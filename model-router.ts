// model-router.ts — FreeGent: endpoint construction, cooldown/rate-limit state,
// and model selection/rotation.
//
// Owns the "which model do we call next" concern end to end:
//   - endpoint construction: specToEndpoint / oaiEndpoint (spec string → {provider,url,key,model})
//   - proactive rate limiting: knownLimitWaitMs / recordRequest (rpm/rpd from the catalog)
//   - reactive cooldowns: _markCooldown (exponential) / _markFlatCooldown / _isCoolingDown /
//     getCooldownRemaining, plus the shared error classifiers _isRateLimit/_isServerError
//   - selection: _anyFreeSpec / getRateLimitFallbackEndpoint / _switchToFreeModel /
//     resolveWorkerModelSpec / _nextRotationSpec
//
// This state was previously smeared across llm-shared (cooldown maps), llm-loops
// (rotation counter), and workers (spec pickers) — the same divergence profile that
// produced the enable_thinking bug in payload construction. One module, one behavior.
//
// Rotation state is INJECTED ({step} object owned by the loop) following the
// detectors seen-maps pattern — the router holds no per-turn state.
//
// Follows the step-validator/…/history pattern: ES module, exports, window bridge.

import { isStaticHost } from './static-hosts.js';
import { isCustomEndpoint } from './payload-builder.js';

// ── Endpoint cooldown state ──────────────────────────────────────────────────
// Shared by all LLM callers (main loops, compaction, workers).
// A Map that keeps itself in localStorage, so a page reload does not forget which models are cooling down. Without it the first
// message after a load tried every exhausted or rate limited model again, each failure a round trip (often through the Worker),
// and the message looked stuck for seconds. Only unexpired entries are kept; headless runs (no page) do not persist.
const COOLDOWN_STORE_KEY = 'fg_endpoint_cooldowns';
class PersistentCooldownMap extends Map<string, number> {
    private _timer: ReturnType<typeof setTimeout> | null = null;
    constructor() {
        super();
        try {
            if ((globalThis as any).window?._fgHeadless) return;
            const saved = JSON.parse(localStorage.getItem(COOLDOWN_STORE_KEY) || '{}');
            const now = Date.now();
            for (const [k, until] of Object.entries(saved)) if (typeof until === 'number' && until > now) super.set(k, until);
        } catch { /* no storage, or unreadable: start empty */ }
    }
    private _save(): void {
        if (this._timer) return;
        this._timer = setTimeout(() => {
            this._timer = null;
            try {
                if ((globalThis as any).window?._fgHeadless) return;
                const now = Date.now(), out: Record<string, number> = {};
                for (const [k, until] of this) if (until > now) out[k] = until;
                if (Object.keys(out).length) localStorage.setItem(COOLDOWN_STORE_KEY, JSON.stringify(out));
                else localStorage.removeItem(COOLDOWN_STORE_KEY);
            } catch { /* quota or blocked: the cooldowns still work for this page */ }
        }, 50);
    }
    set(k: string, v: number): this { super.set(k, v); this._save(); return this; }
    delete(k: string): boolean { const r = super.delete(k); if (r) this._save(); return r; }
    clear(): void { super.clear(); this._save(); }
}
export const _endpointCooldown          = new PersistentCooldownMap(); // key → expiry timestamp
export const _endpointHits              = new Map(); // key → consecutive 429 count
export const _endpointNeedsProbe        = new Set(); // keys that exited cooldown and must be probed before next use
export const _endpointSuccessSinceCooldown = new Map(); // key → bool: had a success since last _markCooldown call
export const RATE_LIMIT_COOLDOWN_MS = () => getRateLimitCooldownMs();
export const RATE_LIMIT_MAX_MS      = 10 * 60_000;
export const RATE_LIMIT_PENALTY_MS  = 60 * 60_000; // 1h penalty when no success since last cooldown

// ── Known rate limit tracking ────────────────────────────────────────────────
// Proactively enforces rpm/rpd limits from MODEL_CATALOG before hitting the API.
// Kept in localStorage, so every tab of the page counts against the same limit: each tab had its own maps, and two tabs on one key could send
// twice the account's RPM/RPD (codex R242). Read and written synchronously around each request (no await between check and record).
// The in-memory map is the fallback when storage cannot be used.
type _RlRec = { ts: number[]; day: string; count: number };
const _rlMem = new Map<string, _RlRec>();
function _rlLoad(key: string): _RlRec {
    try {
        const raw = localStorage.getItem('fg_rl:' + key);
        if (raw) { const r = JSON.parse(raw); if (Array.isArray(r?.ts)) return { ts: r.ts.filter((t: any) => typeof t === 'number'), day: String(r.day ?? ''), count: Number(r.count) || 0 }; }
        return { ts: [], day: '', count: 0 };
    } catch {}
    return _rlMem.get(key) ?? { ts: [], day: '', count: 0 };
}

// APInex's documented free baseline is shared across models, unlike per-model catalog RPM.
// Response headers can raise/lower it for this account; stale observations expire after five minutes.
const _APINEX_ACCOUNT_KEY = 'apinex|*account';
function _apinexRpm(): number {
    try {
        const r = JSON.parse(localStorage.getItem('fg_apinex_observed_rpm') || 'null');
        if (r?.rpm >= 1 && Number.isFinite(r.rpm) && Date.now() - r.at < 300_000) return r.rpm;
    } catch {}
    return 15;
}
export function recordRateLimitHeaders(endpoint: any, headers: Headers): void {
    if (endpoint?.provider !== 'apinex') return;
    const rpm = Number(headers.get('x-ratelimit-limit'));
    if (Number.isFinite(rpm) && rpm >= 1) {
        try { localStorage.setItem('fg_apinex_observed_rpm', JSON.stringify({ rpm, at: Date.now() })); } catch {}
    }
}
function _rlSave(key: string, rec: _RlRec): void {
    _rlMem.set(key, rec);
    try { localStorage.setItem('fg_rl:' + key, JSON.stringify(rec)); } catch {}
}

// Cache the known-limits Map so _getKnownLimits is O(1) per call instead of O(n).
// Rebuilt whenever getAllModels() returns a different array reference (config change).
let _knownLimitsModels: any[] | null = null;
let _knownLimitsMap = new Map<string, { rpm: number | null; rpd: number | null }>();

function _getKnownLimits(key: string) {
    const models = typeof getAllModels === 'function' ? getAllModels() : [];
    if (models !== _knownLimitsModels) {
        _knownLimitsModels = models;
        _knownLimitsMap = new Map(models.map(x => [
            `${x.provider}|${x.model}`,
            // A limit below 1 is no limit (blank in the editor); 0 made the first request pass on NaN and then waited (codex R243).
            { rpm: x.rpm >= 1 ? x.rpm : null, rpd: x.rpd >= 1 ? x.rpd : null },
        ]));
    }
    return _knownLimitsMap.get(key) ?? { rpm: null, rpd: null };
}

// Returns ms to wait before sending a request to this endpoint (0 = ok to proceed).
// Does NOT modify counters — call recordRequest() after the fetch is dispatched.
// Providers whose free daily allowance is one budget for the account, whatever free model is asked: OpenRouter's ~50 requests a day. Each
// free model counted its own 50, so rotating among them sent several times the account's allowance (codex R253).
const _ACCOUNT_DAILY_FREE = new Set(['openrouter']);
const _dayKey = (key: string): string => {
    const bar = key.indexOf('|');
    return _ACCOUNT_DAILY_FREE.has(key.slice(0, bar)) && /(:|-)free$/i.test(key.slice(bar + 1)) ? `${key.slice(0, bar)}|*free` : key;
};
export function knownLimitWaitMs(endpoint: any): number {
    if (!endpoint?.model) return 0;
    const key = `${endpoint.provider ?? ''}|${endpoint.model}`;
    const { rpm, rpd } = _getKnownLimits(key);
    const now = Date.now();
    if (endpoint.provider === 'apinex') {
        const ts = _rlLoad(_APINEX_ACCOUNT_KEY).ts.filter(t => now - t < 60_000);
        if (ts.length >= _apinexRpm()) {
            const wait = 60_000 - (now - ts[0]) + 250;
            _markCooldown(endpoint, wait, new Error('HTTP 429: known APInex account RPM limit'));
            return wait;
        }
    }
    if (rpm == null && rpd == null) return 0;
    if (rpm != null) {
        const ts = _rlLoad(key).ts.filter(t => now - t < 60_000);
        if (ts.length >= rpm) return 60_000 - (now - ts[0]) + 250; // ms until window clears
    }
    if (rpd != null) {
        const today = new Date().toISOString().slice(0, 10);
        const d = _rlLoad(_dayKey(key));
        if (d.day === today && d.count >= rpd) {
            // The counter's day is a UTC date (above), so it resets at the next UTC midnight —
            // not local midnight, which is hours off outside UTC.
            const d0 = new Date(now);
            return Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate() + 1) - now;
        }
    }
    return 0;
}

// Record a dispatched request. Call immediately before fetch().
export function recordRequest(endpoint: any): void {
    if (!endpoint?.model) return;
    const key = `${endpoint.provider ?? ''}|${endpoint.model}`;
    const { rpm, rpd } = _getKnownLimits(key);
    const now = Date.now();
    if (endpoint.provider === 'apinex') {
        const rec = _rlLoad(_APINEX_ACCOUNT_KEY);
        rec.ts = rec.ts.filter(t => now - t < 60_000); rec.ts.push(now); _rlSave(_APINEX_ACCOUNT_KEY, rec);
    }
    if (rpm != null) { const rec = _rlLoad(key); rec.ts = rec.ts.filter(t => now - t < 60_000); rec.ts.push(now); _rlSave(key, rec); }
    if (rpd != null) {
        const today = new Date().toISOString().slice(0, 10);
        const rec = _rlLoad(_dayKey(key));
        if (rec.day !== today) { rec.count = 0; rec.day = today; }
        rec.count++;
        _rlSave(_dayKey(key), rec);
    }
}

// ── Prefix-cache capability detection ───────────────────────────────────────
// Tracks which provider+model pairs have returned cached_tokens > 0 in usage,
// indicating the endpoint does efficient server-side prefix caching (OpenAI
// prompt-caching, Gemini implicit caching, vLLM RadixAttention).
// Persisted in localStorage so the result survives page reloads.
// Used by init.ts to gate model-warmup calls to cache-capable endpoints only —
// there's no benefit to priming KV cache on providers that don't support it.

const _CACHE_CAP_KEY = 'fg_cache_capable';

function _cacheCapMap(): Record<string, true> {
    try { return JSON.parse(localStorage.getItem(_CACHE_CAP_KEY) || '{}'); }
    catch { return {}; }
}

/** Record that this endpoint supports prefix caching (a cached_tokens > 0 response
 *  was observed). Idempotent — writes only when the key is new. */
export function recordCacheCapable(endpoint: any): void {
    if (!endpoint?.provider || !endpoint?.model) return;
    const key = `${endpoint.provider}|${endpoint.model}`;
    const map = _cacheCapMap();
    if (!map[key]) {
        map[key] = true;
        try { localStorage.setItem(_CACHE_CAP_KEY, JSON.stringify(map)); } catch { /* quota */ }
    }
}

/** Returns true if this endpoint is known to support efficient prefix caching.
 *  Always true for custom/vllm (RadixAttention is automatic and cost-free).
 *  Also true once a cached_tokens > 0 response has been observed for this
 *  provider+model pair. Returns false (unknown) until a real response confirms it. */
export function isCacheCapable(endpoint: any): boolean {
    if (!endpoint) return false;
    if (isCustomEndpoint(endpoint)) return true;
    const key = `${endpoint.provider}|${endpoint.model}`;
    return !!_cacheCapMap()[key];
}

// ── Error classification + cooldown operations ───────────────────────────────

// These pick a *recovery action* (cool down + rotate). retry.ts isTransient() decides whether to
// retry at all; every message _isRateLimit accepts must also be transient (pinned by
// tests/retry-consistency.test.ts). _isServerError is wider on purpose: any HTTP 4xx/5xx rotates.
export function _isRateLimit(msg: string, ep?: any): boolean {
    // 429: standard rate limit. 402: payment required / quota exhausted. 503: provider throttle —
    // but from the user's own server (custom/vLLM) a 503 is "busy / still loading", a server error to
    // retry in seconds, not a quota to wait out for minutes.
    if (ep && isCustomEndpoint(ep) && /HTTP 503\b/.test(msg || '') && !/rate.?limit|too many requests/i.test(msg || '')) return false;
    return /HTTP 429|HTTP 402|HTTP 503|rate.?limit|too many requests|quota exceeded|insufficient balance|high demand|spikes in demand|monthly spend limit/i.test(msg || '');
}
export function _isServerError(msg: string): boolean {
    return /HTTP [45]\d\d|idle timeout|signal timed out|read operation timed out|stream error|failed to fetch|networkerror|load failed|connection reset|connection refused|econnreset|socket hang up|bodystreambuffer|stream.*aborted/i.test(msg || '');
}
// Consecutive HTTP 403 answers per endpoint; a success clears it.
export const REFUSAL_LIMIT = 3;
export const REFUSAL_COOLDOWN_MS = 30 * 60_000;
const _refusals = new Map<string, number>();
export function noteRefusal(endpoint: any): number {
    if (!endpoint) return 0;
    const key = `${endpoint.provider}|${endpoint.model}`;
    const n = (_refusals.get(key) ?? 0) + 1;
    _refusals.set(key, n);
    return n;
}
export function recordSuccess(endpoint: any): void {
    if (!endpoint) return;
    const key = `${endpoint.provider}|${endpoint.model}`;
    _refusals.delete(key);
    _endpointSuccessSinceCooldown.set(key, true);
}

// ── Per-account quota errors ────────────────────────────────────────────────
// Some providers meter one allowance for the whole account (TokenHarbor's weekly free period, a depleted
// credit balance). When such an error names the reset, every free model of that provider is unavailable
// until then, so the siblings go on cooldown too instead of each being tried and refused in turn.
const _MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function isAccountQuotaError(msg: string): boolean {
    return /free allowance|free.?tier.?limit|free_tier_limit_reached|out of (free )?credits|credits? (are |have )?(exhausted|depleted|run out)|insufficient (balance|credits?)|HTTP 402\b/i.test(msg || '');
}
// Milliseconds until the reset time named in an error message, or null when it names none.
// Understands "20 Oct 2026 at 04:23 UTC", ISO timestamps after reset/renew/again/until, and "resets in 3h 20m".
export function parseQuotaResetMs(msg: string, now: number = Date.now()): number | null {
    const m = String(msg || '');
    let at: number | null = null;
    const d = m.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})(?:\s+at)?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:UTC|GMT|Z)?/);
    if (d) {
        const mon = _MONTHS.indexOf(d[2].toLowerCase());
        if (mon >= 0) at = Date.UTC(+d[3], mon, +d[1], +d[4], +d[5], +(d[6] || 0));
    }
    if (at === null) {
        const iso = m.match(/(?:reset|renew|again|until|after|resumes?|starts?)\D{0,30}?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?/i);
        if (iso) { const t = Date.parse(iso[1].replace(' ', 'T') + (iso[2] || 'Z')); if (!isNaN(t)) at = t; }
    }
    if (at === null) {
        const dur = m.match(/(?:reset|renew|retry|try again|available|again)\D{0,20}?in\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,and]*)+)/i);
        if (dur) {
            let ms = 0;
            for (const x of dur[1].matchAll(/(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
                const u = x[2][0].toLowerCase();
                ms += parseFloat(x[1]) * (u === 'd' ? 86_400_000 : u === 'h' ? 3_600_000 : u === 'm' ? 60_000 : 1_000);
            }
            if (ms > 0) at = now + ms;
        }
    }
    if (at === null) return null;
    const wait = at - now;
    return wait > 0 && wait <= 40 * 86_400_000 ? wait : null;
}
// A wait the error text asks for: "Retry after 40s", "retry in about 30 seconds", "try again in 2 minutes", or a JSON-style
// `retry_after: 452` (seconds). Null when it names none or asks for more than a day (that is account quota, see above).
export function parseRetryHintMs(msg: string): number | null {
    const m = String(msg || '').match(/(?:retry|try again)(?:ing)?\s+(?:after|in)\s+(?:about\s+|approximately\s+|around\s+)?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b/i)
          || String(msg || '').match(/retry_after\W{1,3}(\d+(?:\.\d+)?)()/i);
    if (!m) return null;
    const u = (m[2] || 's').toLowerCase();
    const ms = parseFloat(m[1]) * (u.startsWith('ms') || u.startsWith('milli') ? 1 : u[0] === 'h' ? 3_600_000 : u[0] === 'm' ? 60_000 : 1_000);
    return ms > 0 && ms <= 86_400_000 ? Math.ceil(ms) : null;
}
// Share account cooldowns with sibling models. Free IDs include free/ prefixes and :free/-free
// suffixes; a provider with bare free IDs shares with all its catalog models. RPM can cover paid IDs too.
function _cooldownSiblings(endpoint: any, ms: number, freeOnly = true): void {
    const mods = typeof getAllModels === 'function' ? getAllModels() : [];
    const isFree = (id: string) => /^free\/|(:|-)free$/i.test(id);
    const failingFree = isFree(endpoint.model);
    for (const m of mods) {
        if (m.provider !== endpoint.provider || m.model === endpoint.model) continue;
        if (freeOnly && failingFree && !isFree(m.model)) continue;
        const k = `${m.provider}|${m.model}`;
        const until = Date.now() + ms;
        if ((_endpointCooldown.get(k) ?? 0) < until) _endpointCooldown.set(k, until);
    }
}
export function _markCooldown(endpoint: any, exactMs: number | null = null, err: any = null): void {
    if (!endpoint) return;
    const key  = `${endpoint.provider}|${endpoint.model}`;
    // A per-account quota error: the model and its free siblings wait until the reset the message names
    // (a Retry-After header can be much shorter than that), else the catalog's cooldown, else an hour.
    const _msg = String(err?.message ?? '');
    // APInex uses 402 both for depleted balances and for a model requiring a subscription.
    // A model access refusal must not block the account's usable free models.
    if (endpoint.provider === 'apinex' && /HTTP 402\b/.test(_msg)
        && /available only with a subscription|requires? (?:an? )?(?:active )?subscription|subscription (?:is )?required/i.test(_msg)) {
        _endpointCooldown.set(key, Date.now() + 24 * 60 * 60_000);
        return;
    }
    // APInex free routes need a daily check-in on its site ("Daily check-in required to use free models", HTTP 402, seen 2026-11-01).
    // The account owner can check in at any time, so the free routes are tried again after 15 minutes, not at the next reset.
    if (endpoint.provider === 'apinex' && /HTTP 402\b/.test(_msg) && /check-in required/i.test(_msg)) {
        _endpointCooldown.set(key, Date.now() + 15 * 60_000);
        _cooldownSiblings(endpoint, 15 * 60_000);
        return;
    }
    // MoonMath's Free plan runs two requests at once per key (x-ratelimit-api_key-limit-max_parallel_requests: 2) and refuses a third
    // with 429 + Retry-After: 60, although a slot frees as soon as one finishes (checked 2026-11-01). Retry this model shortly; no quota is spent.
    if (endpoint.provider === 'moonmath' && /HTTP 429\b/.test(_msg) && /requests at once|parallel/i.test(_msg)) {
        _endpointCooldown.set(key, Date.now() + 5_000);
        return;
    }
    // Requesty (docs.requesty.ai/features/error-codes, checked 2026-11-01): no per-minute limit, but an organization can have only
    // (balance rounded up) x tier multiplier requests in flight (about 2 at a $0 balance) and a third gets 429 "reached its limit of
    // concurrent requests" with no Retry-After; a slot frees as soon as one finishes, for every Requesty model at once.
    if (endpoint.provider === 'requesty') {
        if (/HTTP 429\b/.test(_msg) && /limit of concurrent requests/i.test(_msg)) {
            _endpointCooldown.set(key, Date.now() + 5_000);
            _cooldownSiblings(endpoint, 5_000, false);
            return;
        }
        // 429 "You've hit the rate limit for free models": an undocumented budget shared by every $0 route (hit after about 15M tokens in
        // 2 h of the model ladder, 2026-11-01), with no Retry-After or reset named. All free Requesty models wait together; 15 minutes
        // until the recovery time is measured.
        if (/HTTP 429\b/.test(_msg) && /rate limit for free models/i.test(_msg)) {
            const ms = exactMs ?? 15 * 60_000;
            _endpointCooldown.set(key, Date.now() + ms);
            _cooldownSiblings(endpoint, ms, false);
            return;
        }
        // 402 "balance is too low to run this request": a priced model on an empty balance; the $0 routes keep working.
        if (/HTTP 402\b/.test(_msg)) { _endpointCooldown.set(key, Date.now() + 60 * 60_000); return; }
        // 412 "Reached monthly spend limit for API key": every model of the key waits; the cycle's end is not reported, so re-check hourly.
        if (/HTTP 412\b|monthly spend limit/i.test(_msg)) {
            _endpointCooldown.set(key, Date.now() + 60 * 60_000);
            _cooldownSiblings(endpoint, 60 * 60_000, false);
            return;
        }
    }
    if (err && isAccountQuotaError(_msg)) {
        const _cat = (typeof getAllModels === 'function' ? getAllModels() : []).find((m: any) => m.provider === endpoint.provider && m.model === endpoint.model);
        // APInex's wallet/key allowance covers paid routes too; 402 can also reflect temporary
        // reservations, so honor an explicit short retry delay when no quota reset is named.
        const wallet = endpoint.provider === 'apinex' && /insufficient (?:spendable )?balance|api[- ]key allowance/i.test(_msg);
        // APInex's free allowance (20M weighted tokens a day; GET /v1/subscription: resets_at_utc) and MoonMath's Free usage (its console:
        // "resets in 1h 2m" at 22:58 UTC) both reset at 00:00 UTC (checked 2026-11-01): wait for that rather than retrying every hour.
        // A MoonMath per-key spend limit (key_quota_exceeded) is the account owner's own control and can be raised any time: hourly re-check.
        const untilUtcMidnight = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - d.getTime() + 60_000; };
        const dailyUtc = endpoint.provider === 'apinex' || endpoint.provider === 'moonmath' && !/key_quota_exceeded|API key has reached its spend limit/i.test(_msg);
        const ms = parseQuotaResetMs(_msg) ?? _cat?.cooldownMs
            ?? (wallet ? Math.max(1_000, exactMs ?? parseRetryHintMs(_msg) ?? 60 * 60_000)
                : dailyUtc ? untilUtcMidnight() : Math.max(exactMs ?? 0, 60 * 60_000));
        _endpointCooldown.set(key, Date.now() + ms);
        _cooldownSiblings(endpoint, ms, !wallet);
        return;
    }
    // APInex counts inference RPM per account across every model and key in a fixed 60s window.
    // Rotating to another APInex model cannot bypass it. Honor the reset header/text; without
    // one, wait a full window rather than applying the generic first-refusal one-hour penalty.
    if (endpoint.provider === 'apinex' && /HTTP 429\b/.test(_msg)) {
        const ms = Math.max(1_000, exactMs ?? parseRetryHintMs(_msg) ?? 60_000);
        _endpointCooldown.set(key, Date.now() + ms);
        _cooldownSiblings(endpoint, ms, false);
        return;
    }
    // Per-model catalog override: if the catalog entry has a cooldownMs field, use it as a
    // flat cooldown (ignoring penalty/exponential logic). Designed for free-tier models that
    // have daily quotas — when the quota is hit the cooldown should match the reset window
    // rather than the normal short exponential back-off.
    const _catalogEntry = (() => {
        const mods = typeof getAllModels === 'function' ? getAllModels() : [];
        return mods.find((m: any) => m.provider === endpoint.provider && m.model === endpoint.model);
    })();
    if (_catalogEntry?.cooldownMs != null) {
        _endpointCooldown.set(key, Date.now() + _catalogEntry.cooldownMs);
        return;
    }
    // Escalate to 1h penalty when no successful request has landed since the last cooldown
    // on this endpoint — the provider is persistently refusing; back off hard.
    // The provider names the wait (Retry-After header, or "retry after 40s" in the text): use it, whatever the history.
    const named = exactMs ?? parseRetryHintMs(_msg);
    const hadSuccess = _endpointSuccessSinceCooldown.get(key) ?? false; // no entry = no prior success → penalty applies
    _endpointSuccessSinceCooldown.set(key, false); // reset; recordSuccess() will flip back on next hit
    // A user's own endpoint (custom / vLLM) has no shared quota to protect: back off exponentially
    // (capped at RATE_LIMIT_MAX_MS) so a persistent 429 never reads as "waiting 1.0h".
    if (!hadSuccess && named === null && !isCustomEndpoint(endpoint)) {
        _endpointCooldown.set(key, Date.now() + RATE_LIMIT_PENALTY_MS);
        return;
    }
    const hits = (_endpointHits.get(key) || 0) + 1;
    _endpointHits.set(key, hits);
    const base  = RATE_LIMIT_COOLDOWN_MS();
    const delay = named !== null
        ? Math.max(named, base)
        : Math.min(base * Math.pow(2, hits - 1), RATE_LIMIT_MAX_MS);
    _endpointCooldown.set(key, Date.now() + delay);
}
export function _markFlatCooldown(endpoint: any, exactMs: number | null = null): void {
    if (!endpoint) return;
    const key = `${endpoint.provider}|${endpoint.model}`;
    const base = isCustomEndpoint(endpoint) ? 5_000 : RATE_LIMIT_COOLDOWN_MS();
    _endpointCooldown.set(key, Date.now() + (exactMs != null ? Math.max(exactMs, base) : base));
}
// Like _markFlatCooldown but sets exactly `ms` with no rate-limit-cooldown floor.
// Use for transient 4xx errors (e.g. vLLM returning 400 under speculative-decode load)
// where a short retry interval is appropriate.
export function _markExactCooldown(endpoint: any, ms: number): void {
    if (!endpoint) return;
    const key = `${endpoint.provider}|${endpoint.model}`;
    _endpointCooldown.set(key, Date.now() + ms);
}
export function _isCoolingDown(endpoint: any): boolean {
    if (!endpoint) return false;
    const key   = typeof endpoint === 'string' ? endpoint : `${endpoint.provider}|${endpoint.model}`;
    const until = _endpointCooldown.get(key);
    if (!until) return false;
    if (Date.now() >= until) { _endpointCooldown.delete(key); _endpointHits.delete(key); _endpointNeedsProbe.add(key); return false; }
    return true;
}
/** Forget every cooldown (the popup's "Clear cooldowns"): the user has fixed the cause, or wants to try the models again now. */
export function clearAllCooldowns(): void {
    _endpointCooldown.clear();
    _endpointHits.clear();
    _endpointNeedsProbe.clear();
}
export function getCooldownRemaining(key: string): number {
    const until = _endpointCooldown.get(key);
    if (!until) return 0;
    const remaining = Math.ceil((until - Date.now()) / 1000);
    return remaining > 0 ? remaining : 0;
}

// ── Endpoint construction ────────────────────────────────────────────────────

// Resolves URL, key, and provider label for a custom/vllm model.
// Per-model settings (url, key, apiFormat) stored in the catalog entry take priority
// over the legacy global fg_openai_url / fg_openai_key.
function _customEndpoint(model: string, hintProvider: string): any {
    const allMods = typeof getAllModels === 'function' ? getAllModels() : [];
    const entry   = allMods.find((m: any) => (m.provider === 'custom' || m.provider === 'vllm') && m.model === model);
    // Use the per-entry URL first, then only the *explicitly configured* global OAI URL.
    // getOAIUrl() returns 'https://api.openai.com/v1' as its built-in default when fg_openai_url
    // is unset, which would silently route local custom/vllm models to the OpenAI API and produce
    // a 4xx server-error fallback instead of reaching localhost:8000.  Reading localStorage
    // directly gives null (not a default) when the user has never set it.
    const _configuredOaiUrl = typeof localStorage !== 'undefined'
        ? localStorage.getItem('fg_openai_url') ?? ''
        : getOAIUrl();
    const baseUrl = (entry?.url || _configuredOaiUrl || 'http://localhost:8000/v1').replace(/\/$/, '');
    // A server-held OPENAI_API_KEY reaches the page as a placeholder that the dev server only
    // fills in for api.openai.com; sending it to a local server would get the request refused.
    const _oaiKey = getOAIKey() ?? '';
    const _oaiKeyUsable = !(typeof isServerKeyPlaceholder === 'function' && isServerKeyPlaceholder(_oaiKey))
        || /^https:\/\/api\.openai\.com(\/|$)/.test(baseUrl);
    const key     = entry?.key ?? (_oaiKeyUsable ? _oaiKey : '');
    const fmt     = entry?.apiFormat || hintProvider || 'openai';
    const provider = fmt === 'vllm' ? 'vllm' : 'custom';
    // The "Ollama" format talks to Ollama's OpenAI-compatible API, whatever address was typed (http://host:11434, .../api or
    // .../v1). It used to post to /api/chat, Ollama's native API, whose newline-delimited stream nothing here can read, so
    // every request of such a model ended without a reply.
    const url = fmt === 'ollama' ? `${baseUrl.replace(/\/(?:api|v1)$/, '')}/v1/chat/completions` : `${baseUrl}/chat/completions`;
    // proxy:true routes through the same-origin /api/proxy to avoid CORS in the browser.
    // In headless/Node.js mode there is no browser CORS restriction and no proxy server,
    // so skip it to fetch the LLM endpoint directly.
    const useProxy = !window._fgHeadless;
    return { provider, url, key, model, proxy: useProxy };
}

// On static hosts (freegent.ai, GitHub Pages, *.pages.dev) there is no local server, so route
// CORS-capable providers through the CF Worker too — this lets the worker inject
// shared API keys from its environment when the user hasn't set a local key.
function _staticProxy(): boolean {
    if (window._fgHeadless) return false;
    try {
        return isStaticHost(window.location.hostname);
    } catch { return false; }
}

// The hosted providers' chat-completions endpoints, or null for vllm / custom / unknown providers.
function _hostedEndpoint(provider: string, model: string): any {
    const sp = _staticProxy();
    const viaProxy = !window._fgHeadless;
    switch (provider) {
        case 'google':      return { provider, url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key: getGeminiKey(), model, proxy: sp };
        case 'groq':        return { provider, url: 'https://api.groq.com/openai/v1/chat/completions',     key: getGroqKey(),       model, proxy: sp };
        case 'openrouter':  return { provider, url: 'https://openrouter.ai/api/v1/chat/completions',       key: getOpenRouterKey(), model, proxy: sp };
        case 'tokenharbor': return { provider, url: 'https://tokenharbor.ai/v1/chat/completions',          key: getTokenHarborKey(), model, proxy: viaProxy };
        case 'kilo':        return { provider, url: 'https://api.kilo.ai/api/gateway/chat/completions',    key: getKiloKey() || '', model, proxy: viaProxy };
        case 'vercel':      return { provider, url: 'https://ai-gateway.vercel.sh/v1/chat/completions',    key: getVercelKey(), model, proxy: viaProxy };
        case 'moonmath':    return { provider, url: 'https://zro.moonmath.ai/v1/chat/completions',          key: getMoonmathKey(), model, proxy: sp };
        case 'apinex':      return { provider, url: 'https://api.apinex.bond/v1/chat/completions',          key: getApinexKey(), model, proxy: sp };
        case 'requesty':    return { provider, url: 'https://router.requesty.ai/v1/chat/completions',      key: getRequestyKey(), model, proxy: sp };
        case 'nous':        return { provider, url: 'https://inference-api.nousresearch.com/v1/chat/completions', key: getNousKey(), model, proxy: sp };
        case 'nvidia':      return { provider, url: 'https://integrate.api.nvidia.com/v1/chat/completions', key: getNvidiaKey(), model, proxy: viaProxy };
        default:            return null;
    }
}

export function oaiEndpoint(): any {
    const provider = getProvider();
    const model    = getActiveModel(); // always reads from priority list
    const hosted = _hostedEndpoint(provider, model);
    if (hosted) return hosted;
    return _customEndpoint(model, provider === 'vllm' || provider === 'custom' ? provider : 'custom');
}

// Returns the default endpoint for the current provider configuration.
export function _defaultEndpoint(): any { return oaiEndpoint(); }

export function specToEndpoint(spec: string): any {
    if (!spec) return null;
    const idx      = spec.indexOf('|');
    const provider = idx !== -1 ? spec.slice(0, idx) : spec;
    const model    = idx !== -1 ? spec.slice(idx + 1) : spec;
    const hosted = _hostedEndpoint(provider, model);
    if (hosted) return hosted;
    if (provider === 'vllm' || provider === 'custom') return _customEndpoint(model, provider);
    // Unknown provider falls back to the custom OAI-compatible endpoint.
    // Only 'openai' and 'custom' specs are guaranteed to name a model available there;
    // any other provider prefix (e.g. 'anthropic' hallucinated by the LLM) must be
    // replaced with the actually-configured model to avoid 404 retry loops.
    const safeModel = (provider === 'openai' || provider === 'custom') ? model : getActiveModel();
    if (safeModel !== model)
        console.warn(`[specToEndpoint] replacing unavailable model ${provider}|${model} → ${safeModel}`);
    return _customEndpoint(safeModel, 'custom');
}

// ── Selection ────────────────────────────────────────────────────────────────

export function _anyFreeSpec(currentKey: string): string | null {
    const list = getActiveMainModelList();
    for (const candidate of list) {
        if (candidate === currentKey) continue;
        if (getCooldownRemaining(candidate) === 0) return candidate;
    }
    return null;
}

// Returns a genuinely-free (not cooling down) fallback endpoint, or null when nothing
// qualifies. Previously fell through to "the least-cooling-down candidate" when nothing was
// free and returned THAT instead — indistinguishable from a real fallback to callers, which
// all pick it and switch to it. Since it could still be actively cooling, this produced rapid
// no-delay retries against a model that was never actually usable. Callers already have their
// own "nothing found" fallthrough (retry the current endpoint after its real cooldown, or wait
// for the pool's soonest expiry) — returning null routes them there instead of into a fake fallback.
export function getRateLimitFallbackEndpoint(): any {
    const list = getActiveMainModelList();
    for (let i = 1; i < list.length; i++) {
        if (getCooldownRemaining(list[i]) === 0) return specToEndpoint(list[i]);
    }
    return null;
}

// Promotes the first genuinely-free model in the pool to the front of the list so the
// next turn uses it. Returns false (no-op) when no free model exists — avoids the old bug
// where a still-cooling model was silently promoted and persisted, making every subsequent
// turn prefer an unusable endpoint.
export function _switchToFreeModel(): boolean {
    const list = getActiveMainModelList();
    if (!list.length) return false;
    const key = list.find(k => getCooldownRemaining(k) === 0);
    if (!key) return false;
    // Reorder the saved list, not the active subset: saving only `list` would silently drop
    // paused and keyless models from the user's priority list.
    saveMainModelList([key, ...getMainModelList().filter(k => k !== key)]);
    updateModelLabel?.();
    updateActiveModelDisplay?.();
    return true;
}

// Endpoint rotation: each model is used for exactly N consecutive steps, then
// _anyFreeSpec picks the next. rot: {step} counter object OWNED BY THE CALLER'S loop
// (reset to 0 at turn start) — injected so the router holds no per-turn state.
export function _nextRotationSpec(currentKey: string, rot: { step: number }): string | null {
    if (!getEndpointRotation()) return null;
    const list = getActiveMainModelList();
    if (list.length < 2) return null;
    const N = getRotationStepN();
    rot.step++;
    if (rot.step <= N) return null;
    rot.step = 0;
    return _anyFreeSpec(currentKey);
}

// ── One request at a time per endpoint ───────────────────────────────────────

const _slotQueues = new Map<string, Array<() => void>>(); // key → waiters; a key present means a request is in flight

/** Whether the "one request per endpoint" setting is on (default on). */
export function singleRequestPerEndpoint(): boolean {
    return typeof getSingleRequestPerEndpoint === 'function' ? !!getSingleRequestPerEndpoint() : true;
}

/** Runs fn once no other request to the same provider|model is in flight (waiting in arrival order), when the setting is on. An abort while waiting rejects. */
export async function withEndpointSlot<T>(endpoint: any, signal: AbortSignal | null | undefined, fn: () => Promise<T>): Promise<T> {
    if (!endpoint || !singleRequestPerEndpoint()) return fn();
    const key = `${endpoint.provider}|${endpoint.model}`;
    const queue = _slotQueues.get(key);
    if (queue) {
        await new Promise<void>((resolve, reject) => {
            const go = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
            const onAbort = () => {
                const i = queue.indexOf(go);
                if (i !== -1) queue.splice(i, 1);
                reject(signal!.reason ?? new DOMException('Aborted', 'AbortError'));
            };
            if (signal?.aborted) return onAbort();
            queue.push(go);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    } else {
        _slotQueues.set(key, []);
    }
    try {
        return await fn();
    } finally {
        const next = _slotQueues.get(key)?.shift();
        if (next) next(); // the slot passes straight to the next waiter
        else _slotQueues.delete(key);
    }
}

// ── Worker model resolution + display ────────────────────────────────────────

export function modelFriendlyName(providerModel: string): string {
    if (!providerModel) return '';
    const idx = providerModel.indexOf('|');
    if (idx === -1) return providerModel;
    const provider = providerModel.slice(0, idx);
    const model    = providerModel.slice(idx + 1);
    // Use colon as the provider–model separator so model IDs that already contain
    // a slash (e.g. nous|poolside/laguna-xs-2.1:free) stay readable:
    //   nous:poolside/laguna-xs-2.1:free   ✓
    //   nous/poolside/laguna-xs-2.1:free   ✗  (ambiguous nesting)
    return `${provider}:${model}`;
}

export function resolveWorkerModelSpec(workerModelSpec: string | null, role: any): string | null {
    // An explicit per-call spec always wins (e.g. role-level overrides).
    if (workerModelSpec) return workerModelSpec;

    // Consult the global Worker Model setting.
    const setting = typeof getWorkerModel === 'function' ? getWorkerModel() : '';
    if (setting === 'priority') {
        // Always use the #1 model in the priority list, regardless of cooldown.
        return getMainModelList()[0] || null;
    }
    if (setting && setting !== '' && !isBlacklistedModel(setting)) {
        // A specific provider|model was selected (one the provider has since withdrawn is no selection: the default below applies).
        return setting;
    }

    // Default: the next model in the priority list after the one the main chat uses (the first active model), skipping any that is cooling;
    // with no other model available the worker uses the main model.
    const main = getActiveMainModelList()[0] || null;
    let wSpec: string | null = (main ? _anyFreeSpec(main) : null) || main;
    // Director-tier roles get the main model (they reason about strategy, not just execute).
    if (getAgentRoleModelRouting() &&
        (role?.tier === 'orchestrator' || role?.name === 'director')) {
        wSpec = `${getProvider()}|${getActiveModel()}`;
    }
    return wSpec;
}

/** Extract the model name from a provider|model spec string. */

// Returns the first endpoint in the active model list whose cooldown has expired,
// scanning the full list in priority order regardless of provider.
// Returns null when every configured model is still cooling — callers must handle this
// rather than blindly firing against a known-rate-limited model.
export function firstFreeEndpoint(): any {
    const list = getActiveMainModelList();
    for (const spec of list) {
        if (getCooldownRemaining(spec) === 0) return specToEndpoint(spec);
    }
    return null;
}

// Returns the endpoint for the configured utility model, or null when none is set
// or the utility model is currently cooling down.  Used by callLLMComplete and
// generateAndShowSuggestion so that title generation, prompt suggestions, and
// tool classification all route through one dedicated lighter model when configured.
export function utilityEndpoint(): any {
    const spec = typeof getUtilityModel === 'function' ? getUtilityModel() : '';
    if (!spec || spec === 'none') return null; // 'none' = disabled; callers fall back to firstFreeEndpoint
    if (getCooldownRemaining(spec) > 0) return null; // cooling — callers fall back
    // Skip if the model's provider key isn't available (e.g. CF Worker keys not yet loaded)
    if (typeof specHasKey === 'function' && !specHasKey(spec)) return null;
    return specToEndpoint(spec);
}

// Window bridge for free-variable access from sibling modules (house pattern).
Object.assign(window, {
    _endpointCooldown, _endpointHits, _endpointNeedsProbe, _endpointSuccessSinceCooldown,
    RATE_LIMIT_COOLDOWN_MS, RATE_LIMIT_MAX_MS, RATE_LIMIT_PENALTY_MS,
    noteRefusal, REFUSAL_LIMIT, REFUSAL_COOLDOWN_MS,
    knownLimitWaitMs, recordRequest, recordRateLimitHeaders, recordSuccess, recordCacheCapable, isCacheCapable,
    _isRateLimit, _isServerError, _markCooldown, _markFlatCooldown, _markExactCooldown, _isCoolingDown, getCooldownRemaining,
    oaiEndpoint, specToEndpoint, _defaultEndpoint, firstFreeEndpoint, utilityEndpoint,
    _anyFreeSpec, getRateLimitFallbackEndpoint, _switchToFreeModel, _nextRotationSpec,
    modelFriendlyName, resolveWorkerModelSpec, withEndpointSlot, singleRequestPerEndpoint,
});
