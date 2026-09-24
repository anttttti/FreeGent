// retry.ts — FreeGent: the retry/backoff engine and provider retry handlers.
//
// Owns transient-error classification (isTransient), backoff policy (retryDelay:
// exponential or fixed via fg_retry_mode), the abort-aware sleep, the withRetry
// driver, Retry-After header parsing, and the provider onRetry factory
// (_makeOAIRetryHandler) that wires cooldown marking, model rotation, and
// cross-loop fallback into the model-router.
//
// _parseRetryAfter was stranded in llm-loops away from the engine — reunified here
// (same stranded-sibling pattern as nonStreamOAICompat before stream-decode.ts).
//
// Follows the step-validator/…/stream-decode pattern: ES module, exports, window bridge.

export function _isTimeoutError(e) {
    return e.name === 'TimeoutError' || /signal timed out/i.test(e.message || '');
}

export function isTransient(e) {
    const msg = e.message || '';
    // Permanent configuration errors — model ID or endpoint wrong, retrying won't help
    if (/does not exist|you do not have access|model not found|no such model/i.test(msg)) return false;
    if (_isTimeoutError(e)) return true;
    // "cancelled" — iOS Safari kills fetch when the tab is backgrounded or the screen locks.
    // "network connection was lost" — iOS Safari network-level disconnect mid-stream.
    // "The operation couldn't be completed" — iOS/macOS generic network failure variant.
    return /HTTP 5\d\d|Internal error|Failed to fetch|fetch failed|NetworkError|Load failed|rate.?limit|too many requests|request too large|quota exceeded|insufficient balance|maximum context length|not found|file not found|service unavailable|bad gateway|idle timeout|high traffic|high demand|spikes in demand|signal timed out|bodystreambuffer|stream.*aborted|^cancelled$|network connection was lost|the operation couldn't be completed/i.test(msg);
}

export function parseContextOverflow(e) {
    const msg = e.message || '';
    // vLLM (current): "you requested M output tokens and your prompt contains at least N input
    // tokens, for a total of at least <ctx+1> tokens". N is a lower bound vLLM derives as ctx+1−M,
    // not the prompt size, so ctx−N−256 would shave only ~257 tokens per retry (compaction needed
    // 7–21 rejected attempts in v0.54). The real prompt size is unknown here: halve M instead, and
    // report no headroom once that gets tiny so callers shrink the prompt.
    const lb = msg.match(/you requested (\d+) output tokens and your prompt contains at least \d+ input tokens/i);
    if (lb) {
        const half = Math.floor(parseInt(lb[1], 10) / 2);
        return half >= 256 ? half : 0;
    }
    // vLLM / SGLang: "maximum context length is N ... at least M input tokens"
    let m = msg.match(/maximum context length is (\d+).*?at least (\d+) input tokens/is);
    if (!m) {
        // OpenAI detailed: "N tokens in your prompt; M for the completion"
        m = msg.match(/maximum context length is (\d+).*?(\d+) tokens in your prompt/is);
    }
    if (!m) {
        // OpenAI / OpenRouter simple: "your messages resulted in N tokens"
        // N = prompt-only token count; always > contextLimit when this fires.
        m = msg.match(/maximum context length is (\d+).*?messages resulted in (\d+)/is);
    }
    if (!m) {
        // vLLM OpenAI-compat (current): "you requested N tokens (M in the messages, K in the completion)"
        // M = prompt token count; K = requested completion tokens.
        m = msg.match(/maximum context length is (\d+).*?\((\d+) in the messages/is);
    }
    if (!m) return null;
    const contextLimit = parseInt(m[1], 10);
    const promptTokens = parseInt(m[2], 10);
    // Raw headroom — may be negative when the prompt alone exceeds the context limit.
    // Callers must check the sign: positive → reduce max_tokens and retry;
    // negative/zero → prompt is irrecoverably too large, must compact history instead.
    return contextLimit - promptTokens - 256;
}

const MAX_BACKOFF_MS = 60_000; // 60s — long retries hurt more than they help for local endpoints

// fg_retry_mode: 'exponential' (default) | 'fixed'
// fg_retry_fixed_ms: delay in ms when mode is 'fixed' (default 120000 = 2 min)
export function retryDelay(attempt, e) {
    const mode    = (typeof localStorage !== 'undefined' ? localStorage.getItem('fg_retry_mode') : null) || 'exponential';
    const fixedMs = parseInt(typeof localStorage !== 'undefined' ? localStorage.getItem('fg_retry_fixed_ms') : null) || 120_000;
    if (mode === 'fixed') return fixedMs;
    const base = /HTTP 429|HTTP 413|rate.?limit|too many requests|request too large|quota|insufficient balance/i.test(e.message || '') ? 8_000 : 1_500;
    return Math.min(base * Math.pow(2, attempt), MAX_BACKOFF_MS);
}

export function fmtDelay(ms) {
    if (ms < 60_000)    return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
    return `${(ms / 86_400_000).toFixed(1)}d`;
}

// Sleep for `ms` ms, resolving early if the abort signal fires.
// Pass a session-scoped signal when available; falls back to the global activeAbortController.
export function sleepInterruptible(ms: number, signal?: AbortSignal | null) {
    return new Promise<void>((resolve, reject) => {
        const _signal = signal ?? activeAbortController?.signal;
        if (_signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
        const timer = setTimeout(resolve, ms);
        _signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    });
}

// isTransientOverride: optional fn(e) → bool that supplements isTransient().
// Used by callers that can classify errors the generic pattern list can't (e.g. custom endpoints).
// onFailure: optional fn(e) called for EVERY caught exception, before the transient/non-transient
// branch — a non-transient error (e.g. a 400 that doesn't match any isTransient() pattern) never
// reaches onRetry at all, so this is the only hook that sees every failed attempt unconditionally.
export async function withRetry(fn, onRetry, maxAttempts = Infinity, isTransientOverride = null, onFailure = null) {
    for (let attempt = 0; ; attempt++) {
        try { return await fn(); }
        catch (e) {
            try { onFailure?.(e); } catch {}
            // Soft-stop is active (timeout or UI stop button): never retry — the caller will
            // see the error and return *(break)* or propagate it cleanly.
            if (softStopPending) throw e;
            // AbortErrors when softStopPending=false are timeouts or network aborts — not user
            // aborts. Genuine user aborts are caught above (line 90 fires first). Retrying
            // is correct: AbortSignal.any propagates the timeout reason as AbortError in some
            // Chrome versions (message "The user aborted a request." rather than "signal timed
            // out"), which the old message-based guard incorrectly threw as a fatal error,
            // sending execution to the outer executeWorkers retry loop (3×90s = 270s stall).
            if (e.name !== 'AbortError' && !isTransient(e) && !isTransientOverride?.(e)) throw e;
            if (attempt + 1 >= maxAttempts) throw e;
            const delay = retryDelay(attempt, e);
            const bail  = onRetry?.(attempt, e, delay);
            if (bail === false) throw e;
            // onRetry may return a number to override the delay (e.g. 0 after an endpoint switch)
            await sleepInterruptible(typeof bail === 'number' ? bail : delay);
        }
    }
}

// Returns an onRetry callback for withRetry() in OAI-compatible contexts.
// Handles 429s, server errors, and context overflow; rotates endpoints across all providers.
// getEp/setEp: read and write the current endpoint object.
// setFallback: writes _sessionFallback in main-loop callers; null for compact callers.
// onNote(msg): UI notification.
// onContextOverflow(maxTokens): called on context-length errors to reduce max_tokens.
// onContextTruncate(): called for workers when prompt itself exceeds limit; should trim localHistory.
export function _makeOAIRetryHandler({ getEp, setEp, setFallback = null, onNote, onModelChange = null, forWorker = false, onContextOverflow = null, onContextTruncate = null }) {
    // Lock the tool-call format to the session-start model so rotation never switches
    // from native OAI tool calls to fn-tag (or vice-versa) mid-conversation. The history
    // already contains tool messages in the opening format; mixing formats produces
    // <tool_response> user messages instead of proper role:tool entries.
    const _sessionEp = getEp();
    const _sessionFormat = typeof getModelToolFormat === 'function'
        ? getModelToolFormat(_sessionEp.provider, _sessionEp.model)
        : 'openai';
    const _sameFormat = (spec: string) => {
        const bar = spec.indexOf('|');
        if (bar < 0) return true;
        const fmt = typeof getModelToolFormat === 'function'
            ? getModelToolFormat(spec.slice(0, bar), spec.slice(bar + 1))
            : 'openai';
        return fmt === _sessionFormat;
    };
    const _anyFreeSpecSameFormat = (curKey: string): string | null => {
        if (typeof getActiveMainModelList !== 'function') return _anyFreeSpec(curKey);
        const list = getActiveMainModelList().filter(_sameFormat);
        for (const candidate of list) {
            if (candidate === curKey) continue;
            if (typeof getCooldownRemaining === 'function' && getCooldownRemaining(candidate) === 0) return candidate;
        }
        return null;
    };
    return (n, e, d) => {
        // Truncated/empty response: cycle through the model pool, same as for 429s.
        // Use a short exact cooldown (30s) so each provider is skipped in turn while
        // the others are tried, then becomes available again when the pool has cycled.
        // Bail when all are exhausted rather than waiting — the caller's step loop
        // continues with whatever content exists (empty string), ending gracefully.
        if (e.isTruncated) {
            if (forWorker) return false;
            const ep = getEp();
            const curKey = `${ep.provider}|${ep.model}`;
            const next = _anyFreeSpecSameFormat(curKey);
            if (next) {
                const nextEp = specToEndpoint(next);
                _markExactCooldown(ep, 30_000);
                setEp(nextEp);
                setFallback?.(nextEp);
                onModelChange?.(next);
                const _kind = e.isFiltered ? 'filtered' : 'truncated';
                onNote(`[${curKey}][${_kind}: cycling to ${next}]`);
                return 0;
            }
            return false; // pool exhausted — fall through with empty content
        }
        const is429 = _isRateLimit(e.message);
        const isErr = !is429 && _isServerError(e.message);
        const headroom = parseContextOverflow(e);
        if (headroom !== null) {
            // Immediate retry with smaller max_tokens — never the global retry delay (in benchmark
            // configs that's a fixed 120 s, meant for rate limits and outages).
            if (headroom > 0 && onContextOverflow) { onContextOverflow(headroom); return 0; }
            // Prompt itself exceeds context — reducing max_tokens won't help.
            if (onContextTruncate) {
                const reduced = onContextTruncate();
                if (reduced) return 50;  // truncation helped — retry after brief pause
                return false;            // nothing left to drop — bail
            }
            if (onContextOverflow) { onContextOverflow(256); }  // main agent: set _forceCompact; bail so step catch can compact
            return false;
        }
        const ep = getEp();
        // 401 / 404 from a cloud provider = auth rejected or model ID invalid/discontinued.
        // Pause the model (not remove) so it stays visible in the table for user review.
        const isGone = /HTTP 40[14]/.test(e.message || '');
        if (isGone && ep.provider !== 'custom') {
            const goneKey = `${ep.provider}|${ep.model}`;
            if (typeof savePausedMainModels === 'function' && typeof getPausedMainModels === 'function') {
                const _paused = getPausedMainModels();
                if (!_paused.includes(goneKey)) savePausedMainModels([..._paused, goneKey]);
            }
            onNote(`[${goneKey}][paused: ${e.message?.slice(0, 80) ?? 'HTTP 401/404'}]`);
            const next = _anyFreeSpec(goneKey);
            if (next) { setEp(specToEndpoint(next)); setFallback?.(specToEndpoint(next)); onModelChange?.(next); return 0; }
            return false;
        }
        // Custom (local) endpoints: treat any non-abort error as retryable server error.
        // This covers OOM, CUDA errors, context-overflow messages, etc. from SGLang/vLLM.
        const isCustom = ep.provider === 'custom';
        const effectiveErr = isErr || (isCustom && !is429);
        // Stream timeout means the local model was slow, not that the server is broken.
        // Don't mark it on cooldown and don't fall back to a remote provider — just retry locally.
        const isStreamTimeout = /stream.*timed?\s*out|idle timeout/i.test(e.message);
        // Fetch timeout on a custom/local endpoint: the entire request timed out (FETCH_TIMEOUT_CUSTOM_MS).
        // Retrying immediately will hang again for the same duration — bail so the task fails fast
        // instead of silently looping every 10 min for hours.
        if (_isTimeoutError(e) && isCustom && !isStreamTimeout) {
            onNote(`[${ep.provider}|${ep.model}][fetch timeout: server unresponsive after 10min, not retrying]`);
            return false;
        }
        // preFlight: thrown by knownLimitWaitMs before any HTTP request — cooldown already set,
        // don't extend it. Just let the existing cooldown expire by sleeping retryAfterMs.
        if (is429 && !e.preFlight) _markCooldown(ep, e.retryAfterMs ?? null);
        else if (effectiveErr && !isStreamTimeout) _markFlatCooldown(ep);
        // Stream timeout on custom endpoint: the model was just slow. Retry locally, no fallback.
        if (isStreamTimeout && isCustom) {
            onNote(`[${ep.provider}|${ep.model}][retry ${n + 1}: ${e.message}, waiting 5s]`);
            return 5_000;
        }
        if ((is429 || effectiveErr) && !forWorker) {
            const fb = getRateLimitFallbackEndpoint();
            if (fb && fb.model !== ep.model) {
                const fbKey   = `${fb.provider}|${fb.model}`;
                const fbDelay = getCooldownRemaining(fbKey) * 1000;
                setEp(fb);
                setFallback?.(fb);
                onModelChange?.(fbKey);
                onNote(`[${ep.provider}|${ep.model}][${is429 ? 'rate limited' : 'server error'}: switching to ${fbKey}${fbDelay > 0 ? `, waiting ${fmtDelay(fbDelay)}` : ''}]`);
                return fbDelay;
            }
            const curKey = `${ep.provider}|${ep.model}`;
            const next = _anyFreeSpecSameFormat(curKey);
            if (next) {
                const nextEp = specToEndpoint(next);
                setEp(nextEp);
                setFallback?.(nextEp);
                onModelChange?.(next);
                onNote(`[${ep.provider}|${ep.model}][${is429 ? 'rate limited' : 'server error'}: rotating to ${next}]`);
                return 0;
            }
            // No rotation target — retry same endpoint after cooldown.
            if (is429 && e.retryAfterMs != null) return Math.max(e.retryAfterMs, 5_000);
            const remaining = getCooldownRemaining(`${ep.provider}|${ep.model}`) * 1000;
            // For custom endpoints: use 5s flat for recoverable server errors (OOM/CUDA, HTTP 5xx).
            // For network-level failures (Failed to fetch / server unreachable), use exponential
            // backoff capped at 60s so a crashed local server doesn't spin at 5s forever.
            const isFetchFail = /failed to fetch|networkerror|load failed|econnreset|connection/i.test(e.message);
            const delay = remaining > 0 ? remaining : (isCustom && !isFetchFail ? 5_000 : Math.min(d, 60_000));
            onNote(`[${ep.provider}|${ep.model}][retry ${n + 1}: ${e.message}, waiting ${fmtDelay(delay)}]`);
            return delay;
        }
        if (effectiveErr && e.retryAfterMs != null) return Math.max(e.retryAfterMs, 5_000);
        onNote(`[${ep.provider}|${ep.model}][retry ${n + 1}: ${e.message}, waiting ${fmtDelay(e.retryAfterMs ?? d)}]`);
        if (e.retryAfterMs != null) return Math.max(e.retryAfterMs, 5_000);
        // Workers skip the !forWorker rotation block above, so without this cap they fall through
        // to retryDelay()'s raw exponential (1500*2^attempt) with no ceiling — hours of sleep.
        // Custom endpoints: use same 5s flat cap as the non-worker path.
        if (isCustom) return Math.min(d, 60_000);
    };
}

// Build a detailed Error from a non-ok fetch Response — extracts the provider's own error
// message from the body (OpenAI-style {error:{message}}, generic {message}/{detail}, and
// OpenRouter's nested error.metadata.raw) instead of leaving a bare "HTTP 400" with no
// diagnostic content. isTransient()/parseContextOverflow() pattern-match on e.message, so a
// bare status code can never be classified as retryable even when the discarded body would
// have said "rate limited" or "maximum context length" — this is what actually reaches them.
// prefix: optional string prepended to the message (e.g. "[provider|model]").
export async function _httpErrorFromResponse(resp, prefix = '') {
    const retryAfterMs = _parseRetryAfter(resp);
    const text = await resp.text().catch(() => '');
    let msg = `HTTP ${resp.status}`;
    try {
        const j = JSON.parse(text);
        const detail = j.message || j.detail || j.error?.message || (typeof j.error === 'string' ? j.error : '') || '';
        if (detail) msg += ': ' + detail;
        const raw = j.error?.metadata?.raw;
        if (raw) {
            try { const r = JSON.parse(raw); msg += ': ' + (r.error?.message || r.message || raw); }
            catch { msg += ': ' + raw; }
        }
    } catch {
        if (text) msg += ': ' + text.slice(0, 120);
    }
    const e: any = new Error(prefix ? `${prefix} ${msg}` : msg);
    if (retryAfterMs !== null) e.retryAfterMs = retryAfterMs;
    e.status = resp.status;
    return e;
}

// Parse Retry-After / x-ratelimit-reset-* headers into milliseconds.
// Handles: numeric seconds ("30"), Groq-style durations ("1m30s"), HTTP-dates.
export function _parseRetryAfter(resp) {
    const raw = resp.headers.get('retry-after')
             || resp.headers.get('x-ratelimit-reset-requests')
             || resp.headers.get('x-ratelimit-reset-tokens');
    if (!raw) return null;
    // Guard: only match purely numeric strings. Without ^…$, parseFloat('1m30s')→1
    // would return 1 s instead of 90 s, making the duration branch below unreachable.
    if (/^\d+(?:\.\d+)?$/.test(raw.trim())) return Math.ceil(parseFloat(raw)) * 1000;
    // Duration string: "1m30.5s", "6s", "2h"
    let ms = 0;
    for (const [, n, unit] of raw.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
        const v = parseFloat(n);
        if (unit === 'ms') ms += v;
        else if (unit === 's') ms += v * 1_000;
        else if (unit === 'm') ms += v * 60_000;
        else if (unit === 'h') ms += v * 3_600_000;
    }
    if (ms > 0) return ms;
    // HTTP-date fallback
    const ts = Date.parse(raw);
    return !isNaN(ts) ? Math.max(0, ts - Date.now()) : null;
}

// Window bridge for free-variable access from sibling modules (house pattern).
Object.assign(window, {
    _isTimeoutError, isTransient, parseContextOverflow, retryDelay, fmtDelay,
    sleepInterruptible, withRetry, _parseRetryAfter, _httpErrorFromResponse,
    _makeOAIRetryHandler,
});
