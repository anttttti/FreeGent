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

// Transport failures are classified by where they were thrown, not by what the browser chose to
// call them. fetch() rejects only when the request never completed, and reader.read() only when
// the body stream broke, so anything but an abort from those two calls is a dropped connection —
// whether Chrome words it "network error", Safari "Load failed", Firefox "Error in input stream"
// or undici "terminated". Call sites tag the error once; isTransient() trusts the tag, and the
// message list below stays as the fallback for errors that arrive untagged (wrapped, re-thrown
// as a string, or from a call site that doesn't tag yet).
// Tagged in a WeakSet rather than by assigning a property: a frozen or non-extensible error
// (a DOMException subclass, a library's sealed error) takes the tag all the same, and the
// classifier never throws from the one place that must not.
const _transportErrors = new WeakSet<object>();
export function asTransportError<E>(e: E): E {
    if (e && typeof e === 'object' && (e as any).name !== 'AbortError') _transportErrors.add(e as object);
    return e;
}

// Node and undici put the errno on e.code, usually on e.cause for fetch's "fetch failed".
const _NET_CODE_RE = /^(?:ECONN\w+|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH|ENETDOWN|EHOSTUNREACH|UND_ERR_\w+|ERR_HTTP2_\w+|ERR_STREAM_PREMATURE_CLOSE)$/;

// Message fallback. Grouped by who says it; each group is a family of the same failure.
const _TRANSIENT_MSG_RE = new RegExp([
    // provider/HTTP: server errors, throttling, overload, and the proxies' bare-status forms
    'HTTP 5\\d\\d|HTTP 429|HTTP 402|HTTP 408|HTTP 425|HTTP 499|Internal error|rate.?limit|too many requests',
    'request too large|quota exceeded|insufficient balance|maximum context length|not found|file not found',
    'service unavailable|bad gateway|gateway time-?out|idle timeout|high traffic|high demand|spikes in demand',
    'overloaded|temporarily unavailable|try again later|upstream connect error|no healthy upstream',
    'connection error|request timed out|error code: (?:1015|5\\d\\d)',
    // Chrome/Edge/Electron: "network error" is the TypeError from a body that died mid-read
    'Failed to fetch|network error|net::ERR_',
    // Firefox
    'NetworkError|error in input stream|connection was reset',
    // Safari/iOS, which also kills fetch when the tab is backgrounded or the screen locks
    'Load failed|^cancelled$|network connection was lost|the operation couldn\'t be completed',
    'internet connection appears to be offline|could not connect to the server|hostname could not be found',
    'software caused connection abort',
    // Node/undici (fg-run, headless runner, bench): fetch failed, terminated, errnos, socket drops
    'fetch failed|^terminated$|^aborted$|other side closed|premature close|socket hang up',
    '\\bE(?:CONN\\w+|TIMEDOUT|NOTFOUND|AI_AGAIN|PIPE|NETUNREACH|HOSTUNREACH)\\b',
    '(?:body|headers|connect) timeout error',
    // React Native / generic
    'network request failed',
    // streams and timeouts of our own
    'signal timed out|bodystreambuffer|stream.*aborted',
].join('|'), 'i');

// Prose that says "retry" only by accident of wording. Matching one of these, with nothing
// stronger (an HTTP status, rate limit, overload) and no transport tag, errno or timeout, is
// the weakest reason to retry — withRetry bounds it even where maxAttempts is Infinity.
const _WEAK_PROSE_RE = /not found|try again later|internal error|connection error|request timed out/i;
const _STRONG_PROSE_RE = /HTTP \d{3}|rate.?limit|too many requests|overloaded|unavailable|bad gateway|gateway time|quota|insufficient balance|high (?:traffic|demand)|spikes in demand|upstream|idle timeout|net::ERR_|Failed to fetch|network/i;
const WEAK_PROSE_MAX_ATTEMPTS = 6;
function isWeakProseTransient(e): boolean {
    if (!e || (typeof e === 'object' && _transportErrors.has(e))) return false;
    if (_NET_CODE_RE.test(e.code ?? '') || _NET_CODE_RE.test(e.cause?.code ?? '') || _isTimeoutError(e)) return false;
    const msg = e.message || '';
    return _WEAK_PROSE_RE.test(msg) && !_STRONG_PROSE_RE.test(msg);
}

// An HTTP 400 that says the provider failed, not that the request or the account is wrong (Vercel's stealth models:
// "The stealth model could not complete the request"; the same request works a minute later). Such a 400 cools the model
// down like a server error; it must not pause the model for good.
export const ACCOUNT_PLAN_REFUSAL_RE = /free tier users do not have access|requires an active pro plan|requires available credits|balance is too low to use paid models/i;
export function isProviderSide400(msg: string): boolean {
    return /\bHTTP 400\b/.test(msg || '') && /could not complete the request|unable to process the request|try again|temporar|overload|at capacity|upstream/i.test(msg || '');
}

// finish_reason values that say the reply is not a finished one. Shared by the main loop and the auxiliary completions (codex R28-001).
export const FINISH_TOKEN_CAP = new Set(['length', 'MAX_TOKENS', 'max_tokens', 'OTHER', 'other', 'repetition']);
export const FINISH_FILTERED  = new Set(['content_filter', 'SAFETY', 'filtered', 'RECITATION']);
export const FINISH_ERROR     = new Set(['error', 'abort']);

export function isTransient(e) {
    const msg = e.message || '';
    // Permanent configuration errors — model ID or endpoint wrong, retrying won't help
    if (/does not exist|you do not have access|model not found|no such model/i.test(msg)) return false;
    if (e && typeof e === 'object' && _transportErrors.has(e)) return true;
    if (_NET_CODE_RE.test(e.code ?? '') || _NET_CODE_RE.test(e.cause?.code ?? '')) return true;
    if (_isTimeoutError(e)) return true;
    // HTTP 429/402 by status: some providers return a bare status with no body ("[nvidia|…] HTTP 429"),
    // which the text patterns below miss — workers then gave up on the first rate limit instead of
    // letting the retry handler rotate or wait for a cooldown.
    return _TRANSIENT_MSG_RE.test(msg);
}

// Less room than this for the answer is no room: a reasoning model spends it all thinking and returns nothing, and every
// retry then pays for the whole prompt (real-model run: max_tokens halved to 721 under a 29k-token prompt, 45 s per
// attempt, no end in minutes). Below it the caller is told there is no headroom, so it shrinks the prompt instead.
export const MIN_USEFUL_OUTPUT = 1024;

// The server says it takes no images (vLLM --language-model-only: "At most 0 image(s) may be provided"). Re-sending the same request
// gets the same answer; the caller resends without the image instead.
export const IMAGE_REFUSAL_RE = /(?:at most 0 image|image input is not supported|(?:does not|doesn't) (?:accept|support) (?:image|vision|multimodal)|no endpoints found that support image)/i;

// The server names one of the thinking controls FreeGent sent as a parameter it does not accept (NVIDIA NIM, z-ai/glm-5.3: "HTTP 400: Validation:
// Unsupported parameter(s): `reasoning_budget`"). The same request gets the same answer; the caller remembers the model and resends without them.
const _THINKING_FIELD_RE = /reasoning_budget|enable_thinking|thinking_token_budget|preserve_thinking|chat_template_kwargs|budget_tokens|\bthinking\b/i;
const _FIELD_REFUSAL_RE = /unsupported|unknown|unrecognized|unexpected|not (?:supported|allowed|permitted|a valid)|extra (?:inputs?|fields?)|invalid parameter|additional properties/i;
export function isThinkingFieldRefusal(message: unknown): boolean {
    const m = String(message ?? '');
    return /\bHTTP 400\b/.test(m) && _THINKING_FIELD_RE.test(m) && _FIELD_REFUSAL_RE.test(m);
}

// The server wants the reasoning of the earlier assistant messages back (Vercel, reflection/beam-free: "HTTP 400: Missing required parameter:
// 'messages[1].reasoning_content'. This model needs the reasoning of every earlier assistant message"). The caller remembers the model and
// resends with it (payload-builder withReasoningEcho).
export function isReasoningEchoDemand(message: unknown): boolean {
    const m = String(message ?? '');
    return /\bHTTP 400\b/.test(m) && /reasoning_content/.test(m) && /missing|required|send back/i.test(m);
}

export function parseContextOverflow(e, min = MIN_USEFUL_OUTPUT) {
    const msg = e.message || '';
    // vLLM (current): "you requested M output tokens and your prompt contains at least N input
    // tokens, for a total of at least <ctx+1> tokens". N is a lower bound vLLM derives as ctx+1−M,
    // not the prompt size, so ctx−N−256 would shave only ~257 tokens per retry (compaction needed
    // 7–21 rejected attempts in v0.54). The real prompt size is unknown here: halve M instead, and
    // report no headroom once that gets tiny so callers shrink the prompt.
    const lb = msg.match(/you requested (\d+) output tokens and your prompt contains at least \d+ input tokens/i);
    if (lb) {
        const half = Math.floor(parseInt(lb[1], 10) / 2);
        return half >= min ? half : 0;
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
    const room = contextLimit - promptTokens - 256;
    return room > 0 && room < min ? 0 : room;
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
        // The listener is removed when the sleep ends: every retry used to leave one on the long-lived signal.
        const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
        const timer = setTimeout(() => { _signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
        _signal?.addEventListener('abort', onAbort, { once: true });
    });
}

// Resolve once the page is visible and the browser reports online (max 10 min, abort-aware).
// Mobile browsers freeze hidden pages and bring the network back a moment after wake.
async function _waitUntilReachable(turnSignal?: AbortSignal): Promise<void> {
    if (typeof document === 'undefined') return;
    const ready = () => !document.hidden && (typeof navigator === 'undefined' || navigator.onLine !== false);
    if (ready()) return;
    // The turn's own signal, not whichever controller is current when the wait ends: a later turn's controller must not decide this wait.
    const signal = turnSignal ?? activeAbortController?.signal;
    await new Promise<void>(resolve => {
        const done = () => {
            document.removeEventListener('visibilitychange', check);
            window.removeEventListener('online', check);
            clearTimeout(timer); resolve();
        };
        const check = () => { if (ready() || signal?.aborted) { setTimeout(done, ready() ? 1_500 : 0); } };
        const timer = setTimeout(done, 600_000);
        document.addEventListener('visibilitychange', check);
        window.addEventListener('online', check);
        signal?.addEventListener('abort', done, { once: true });
    });
}

// isTransientOverride: optional fn(e) → bool that supplements isTransient().
// Used by callers that can classify errors the generic pattern list can't (e.g. custom endpoints).
// onFailure: optional fn(e) called for EVERY caught exception, before the transient/non-transient
// branch — a non-transient error (e.g. a 400 that doesn't match any isTransient() pattern) never
// reaches onRetry at all, so this is the only hook that sees every failed attempt unconditionally.
// The note shown while a request is being retried. With the browser offline, say that: a "Failed to fetch"
// that repeats for minutes (a tunnel, a lost Wi-Fi) read like the model hanging, with Stop the only way out.
function _retryNote(ep: any, n: number, e: any, waitMs: number): string {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    return offline
        ? `[${ep.provider}|${ep.model}][offline: no network connection, retrying in ${fmtDelay(waitMs)}; it continues when the connection is back, or press Stop]`
        : `[${ep.provider}|${ep.model}][retry ${n + 1}: ${e.message}, waiting ${fmtDelay(waitMs)}]`;
}

export async function withRetry(fn, onRetry, maxAttempts = 12, isTransientOverride = null, onFailure = null) {
    let weakProse = 0;
    // This call's own turn: activeAbortController is replaced when the next turn starts, and softStopPending is cleared by that send,
    // so a request that was stopped and is still unwinding must not look like a network abort by then (it was retried, and its answer
    // landed after the next message: campaign 5 OC7-ABORT-RESEND).
    const _turnSignal = activeAbortController?.signal;
    for (let attempt = 0; ; attempt++) {
        try { return await fn(); }
        catch (e) {
            // Every failed attempt is a request that ran and is in no token total: count it.
            try { if (typeof metricsNote === 'function') metricsNote({ type: 'request_failed', error: String(e?.message ?? e).slice(0, 400), attempt }); } catch {}
            try { onFailure?.(e); } catch {}
            // Soft-stop is active (timeout or UI stop button): never retry — the caller will
            // see the error and return *(break)* or propagate it cleanly.
            if (softStopPending || _turnSignal?.aborted) throw e;
            // AbortErrors when softStopPending=false are timeouts or network aborts — not user
            // aborts. Genuine user aborts are caught above (line 90 fires first). Retrying
            // is correct: AbortSignal.any propagates the timeout reason as AbortError in some
            // Chrome versions (message "The user aborted a request." rather than "signal timed
            // out"), which the old message-based guard incorrectly threw as a fatal error,
            // sending execution to the outer executeWorkers retry loop (3×90s = 270s stall).
            if (e.name !== 'AbortError' && !isTransient(e) && !isTransientOverride?.(e)) throw e;
            if (attempt + 1 >= maxAttempts) throw e;
            // An error that matched only on weak prose ("not found", "try again later") gets a
            // short bounded run, not an unbounded one: a wording coincidence must not loop a turn.
            if (!isTransientOverride?.(e) && isWeakProseTransient(e) && ++weakProse >= WEAK_PROSE_MAX_ATTEMPTS) throw e;
            const delay = retryDelay(attempt, e);
            const bail  = onRetry?.(attempt, e, delay);
            if (bail === false) throw e;
            // onRetry may return a number to override the delay (e.g. 0 after an endpoint switch)
            await sleepInterruptible(typeof bail === 'number' ? bail : delay);
            // Phone locked / radio asleep: retrying now just burns attempts against a dead network.
            if (isTransient(e)) await _waitUntilReachable(_turnSignal);
            // The wait ends early on Stop (it resolves, it does not reject), and the loop would go straight back to fn(): the cancelled attempt ran
            // again (codex R2-001). Look at the turn's signal once more before every attempt.
            if (softStopPending || _turnSignal?.aborted) throw e;
        }
    }
}

// A local server the user runs: provider 'custom' or 'vllm' (same rule as isCustomEndpoint in
// payload-builder.ts). The retry paths tested 'custom' alone, so a vLLM endpoint — every benchmark
// run — was handled as a cloud provider: a 401/404 paused the model, and the local-server retry
// rules did not apply.
export function _isLocalEp(ep: any): boolean { return !!ep && (ep.provider === 'custom' || ep.provider === 'vllm'); }

// A cloud provider answering HTTP 404 — "The requested model 'x' does not exist", a model the provider dropped or renamed. withRetry
// treats that wording as a permanent configuration error and throws before the retry handler runs, so the handler's own answer to it
// (pause the model, rotate to the next one in the pool) was never reached: a turn ended on the first dead model while the rest of the pool
// worked. Callers add this to the transient override so the handler sees it. With nothing to rotate to the handler gives up and
// the error is reported as before; a custom/local endpoint's 404 stays permanent (the route or model is wrong, retrying cannot fix it).
export function isModelGone(e: any, ep: any): boolean { return !_isLocalEp(ep) && /\bHTTP (?:404|410)\b/.test(String(e?.message ?? '')); }

// HTTP statuses that reject the request itself; 408/409/425/429 are left out (they can pass on a retry).
export const SAME_ENDPOINT_WAIT_LIMIT_MS = 20 * 60_000;
export const MAX_INSTANT_RETRIES = 20;
const _CLIENT_ERROR_RE = /\bHTTP (?:400|401|403|404|405|410|413|415|422)\b|answered with a web page/;
export const CUSTOM_CLIENT_ERROR_ATTEMPTS = 3;
// Attempts (with backoff) on an empty or cut-off reply when no other model is free to cycle to.
export const EMPTY_REPLY_ATTEMPTS = 4;

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
    // Where a spec actually sends requests. A CLI run's endpoint is `custom|m` while its model list holds `openai|m`: the same server and
    // model under another name, so "rotating" to it re-sent the same request at once, forever (self-analysis P1 2026-10-29: 551 cut-off
    // replies in 29 minutes, no step, no compaction; a mock gave 10756 requests in 60 s).
    const _target = (spec: string): string => {
        try { const ep = typeof specToEndpoint === 'function' ? specToEndpoint(spec) : null; return ep ? `${ep.url ?? ''}|${ep.model ?? ''}` : spec; }
        catch { return spec; }
    };
    const _anyFreeSpecSameFormat = (curKey: string): string | null => {
        if (typeof getActiveMainModelList !== 'function') return _anyFreeSpec(curKey);
        const list = getActiveMainModelList().filter(_sameFormat);
        const here = _target(curKey);
        for (const candidate of list) {
            if (candidate === curKey || _target(candidate) === here) continue;
            if (typeof getCooldownRemaining === 'function' && getCooldownRemaining(candidate) === 0) return candidate;
        }
        return null;
    };
    let _clientErrors = 0;
    // Waiting out the same endpoint when there is nothing to rotate to. withRetry is called with no attempt
    // limit by the main loop, and every branch below returns a positive delay, so a local server that stays
    // down (OOM, crash, wrong port) was retried every 5-60 s until the task's wall clock ended (review
    // 2026-10-14, opencode H3). Past this much waiting the error is reported and the loop's own recovery
    // runs. A cloud 429 is not bounded: its cooldown is a quota window, and waiting it out is the point.
    let _sameEpWaitedMs = 0;
    const _boundedWait = (ms: number, ep: any, e: any, is429: boolean, isCustom: boolean): number | false => {
        if (is429 && !isCustom) return ms;
        _sameEpWaitedMs += ms;
        if (_sameEpWaitedMs <= SAME_ENDPOINT_WAIT_LIMIT_MS) return ms;
        onNote(`[${ep.provider}|${ep.model}][giving up: ${Math.round(_sameEpWaitedMs / 60_000)} min of retries on this endpoint with nowhere to rotate: ${String(e.message || '').slice(0, 120)}]`);
        return false;
    };
    const decide = (n, e, d) => {
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
            // Nowhere to cycle to: back off like any other transient failure (retryDelay: exponential, or the
            // user's fixed delay), a few times, instead of re-sending at once. Past that, fall through.
            // Output-cap and stalled-stream cut-offs are not "the provider returned nothing": they need the
            // loop's nudge (shorter calls), so they leave withRetry at once.
            if (!e.outputCapHit && !e.streamStalled && n + 1 < EMPTY_REPLY_ATTEMPTS) {
                onNote(`[${curKey}][${e.isFiltered ? 'filtered' : 'empty or cut-off reply'}: retrying in ${fmtDelay(d)}]`);
                return d;
            }
            return false; // still nothing — fall through with empty content
        }
        const is429 = _isRateLimit(e.message, getEp());
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
        // "No endpoints found that support image input" is a 404 about this request (an image
        // attachment), not a dead model: rotate away for a while without pausing it for good.
        if (/HTTP 404/.test(e.message || '') && /support image input/i.test(e.message || '')
                && !_isLocalEp(ep) && !forWorker) {
            const noVisionKey = `${ep.provider}|${ep.model}`;
            _markExactCooldown(ep, 30 * 60_000);
            onNote(`[${noVisionKey}][no image input — skipped for 30 min]`);
            const next = _anyFreeSpec(noVisionKey);
            if (next) { setEp(specToEndpoint(next)); setFallback?.(specToEndpoint(next)); onModelChange?.(next); return 0; }
            return false;
        }
        // A cloud endpoint that answers HTTP 403 again and again is refusing this account or key, not
        // having a short outage (uploads review 2026-10-14: nine identical TokenHarbor refusals, each
        // followed by the flat two-minute cooldown). After a few, skip it for a long while, if there is
        // somewhere to go; without a fallback the normal retry applies. Not a permanent pause: a 403 can
        // also be about one request, or lift later.
        if (/HTTP 403/.test(e.message || '') && !_isLocalEp(ep) && !forWorker) {
            const refKey = `${ep.provider}|${ep.model}`;
            // "Free tier users do not have access" / "requires an active Pro plan": the account can never use this model, so
            // there is nothing to count; skip it for a day at the first answer.
            const planRefusal = ACCOUNT_PLAN_REFUSAL_RE.test(e.message || '');
            if (noteRefusal(ep) >= REFUSAL_LIMIT || planRefusal) {
                const next = _anyFreeSpecSameFormat(refKey);
                if (next) {
                    const skipMs = planRefusal ? 24 * 3_600_000 : REFUSAL_COOLDOWN_MS;
                    _markExactCooldown(ep, skipMs);
                    onNote(`[${refKey}][${planRefusal ? 'not available to this account (HTTP 403)' : `refused ${REFUSAL_LIMIT} times (HTTP 403)`}: skipped for ${skipMs >= 3_600_000 ? Math.round(skipMs / 3_600_000) + ' h' : Math.round(skipMs / 60_000) + ' min'}, using ${next}]`);
                    setEp(specToEndpoint(next)); setFallback?.(specToEndpoint(next)); onModelChange?.(next);
                    return 0;
                }
            }
        }
        const isGone = /HTTP (?:40[14]|410)\b/.test(e.message || '');   // 410 Gone: "the model has reached its end of life" (chat log b1fd2d32, nvidia|moonshotai/kimi-k3)
        if (isGone && !_isLocalEp(ep) && !forWorker) {
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
        const isCustom = _isLocalEp(ep);
        // …except a request the server refuses as such (bad request, auth, unknown model or route):
        // the same request gets the same answer, and callers pass no attempt limit for custom
        // endpoints, so it was re-sent every 5 s until the run's time limit. A few attempts cover a
        // server that is still loading its model; after that the error is reported.
        if (isCustom && IMAGE_REFUSAL_RE.test(e.message || '')) return false;   // the caller drops the image and resends
        if (isCustom && _CLIENT_ERROR_RE.test(e.message || '') && ++_clientErrors >= CUSTOM_CLIENT_ERROR_ATTEMPTS) {
            onNote(`[${ep.provider}|${ep.model}][not retrying: the server rejected the request ${_clientErrors} times: ${String(e.message || '').slice(0, 120)}]`);
            return false;
        }
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
        if (is429 && !e.preFlight) _markCooldown(ep, e.retryAfterMs ?? null, e);
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
            if (is429 && e.retryAfterMs != null) return _boundedWait(Math.max(e.retryAfterMs, 5_000), ep, e, is429, isCustom);
            const remaining = getCooldownRemaining(`${ep.provider}|${ep.model}`) * 1000;
            // For custom endpoints: use 5s flat for recoverable server errors (OOM/CUDA, HTTP 5xx).
            // For network-level failures (Failed to fetch / server unreachable), use exponential
            // backoff capped at 60s so a crashed local server doesn't spin at 5s forever.
            const isFetchFail = /failed to fetch|networkerror|load failed|econnreset|connection/i.test(e.message);
            const delay = remaining > 0 ? remaining : (isCustom && !isFetchFail ? 5_000 : Math.min(d, 60_000));
            const bounded = _boundedWait(delay, ep, e, is429, isCustom);
            if (bounded === false) return false;
            onNote(_retryNote(ep, n, e, delay));
            return bounded;
        }
        if (effectiveErr && e.retryAfterMs != null) return Math.max(e.retryAfterMs, 5_000);
        onNote(_retryNote(ep, n, e, e.retryAfterMs ?? d));
        if (e.retryAfterMs != null) return Math.max(e.retryAfterMs, 5_000);
        // Workers skip the !forWorker rotation block above, so without this cap they fall through
        // to retryDelay()'s raw exponential (1500*2^attempt) with no ceiling — hours of sleep.
        // Custom endpoints: use same 5s flat cap as the non-worker path.
        if (isCustom) return Math.min(d, 60_000);
    };
    // Every rotation answers 0 (resend at once). However the next model is chosen, more than this many in a row for one request is a loop:
    // the error goes to the caller, whose own recovery (compaction, the cut-off and empty-reply limits) runs.
    let _instant = 0;
    return (n, e, d) => {
        const r = decide(n, e, d);
        if (r === 0 && ++_instant > MAX_INSTANT_RETRIES) {
            onNote(`[${getEp().provider}|${getEp().model}][giving up: ${MAX_INSTANT_RETRIES} immediate retries of one request: ${String(e?.message || '').slice(0, 120)}]`);
            return false;
        }
        return r;
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
    let retryAfterMs = _parseRetryAfter(resp);
    const text = await resp.text().catch(() => '');
    let msg = `HTTP ${resp.status}`;
    try {
        const j = JSON.parse(text);
        // Nous Portal's fair-share 429 gives the wait in the body ("retry_after": seconds), not in a header.
        const bodyWait = Number(j.retry_after ?? j.error?.retry_after);
        if (retryAfterMs === null && bodyWait > 0 && bodyWait < 86_400) retryAfterMs = Math.ceil(bodyWait) * 1000;
        const detail = j.message || j.detail || j.error?.message || (typeof j.error === 'string' ? j.error : '') || '';
        if (detail) msg += ': ' + detail;
        const raw = j.error?.metadata?.raw;
        if (raw) {
            try { const r = JSON.parse(raw); msg += ': ' + (r.error?.message || r.message || raw); }
            catch { msg += ': ' + raw; }
        }
    } catch {
        // A non-JSON body is often an HTML error page from a proxy: show its text, not its markup.
        const plain = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        if (plain) msg += ': ' + plain.slice(0, 120);
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
    _isTimeoutError, isTransient, isProviderSide400, parseContextOverflow, retryDelay, fmtDelay,
    sleepInterruptible, withRetry, _parseRetryAfter, _httpErrorFromResponse,
    _makeOAIRetryHandler,
});
