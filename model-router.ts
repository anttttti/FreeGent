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

// ── Endpoint cooldown state ──────────────────────────────────────────────────
// Shared by all LLM callers (main loops, compaction, workers).
export const _endpointCooldown          = new Map(); // key → expiry timestamp
export const _endpointHits              = new Map(); // key → consecutive 429 count
export const _endpointNeedsProbe        = new Set(); // keys that exited cooldown and must be probed before next use
export const _endpointSuccessSinceCooldown = new Map(); // key → bool: had a success since last _markCooldown call
export const RATE_LIMIT_COOLDOWN_MS = () => getRateLimitCooldownMs();
export const RATE_LIMIT_MAX_MS      = 10 * 60_000;
export const RATE_LIMIT_PENALTY_MS  = 60 * 60_000; // 1h penalty when no success since last cooldown

// ── Known rate limit tracking ────────────────────────────────────────────────
// Proactively enforces rpm/rpd limits from MODEL_CATALOG before hitting the API.
const _rlTs  = new Map(); // key → number[] (request timestamps, last 60s)
const _rlDay = new Map(); // key → {count, day}

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
            { rpm: x.rpm ?? null, rpd: x.rpd ?? null },
        ]));
    }
    return _knownLimitsMap.get(key) ?? { rpm: null, rpd: null };
}

// Returns ms to wait before sending a request to this endpoint (0 = ok to proceed).
// Does NOT modify counters — call recordRequest() after the fetch is dispatched.
export function knownLimitWaitMs(endpoint: any): number {
    if (!endpoint?.model) return 0;
    const key = `${endpoint.provider ?? ''}|${endpoint.model}`;
    const { rpm, rpd } = _getKnownLimits(key);
    const now = Date.now();
    if (rpm != null) {
        const ts = (_rlTs.get(key) || []).filter(t => now - t < 60_000);
        _rlTs.set(key, ts); // prune while we're here
        if (ts.length >= rpm) return 60_000 - (now - ts[0]) + 250; // ms until window clears
    }
    if (rpd != null) {
        const today = new Date().toISOString().slice(0, 10);
        const d = _rlDay.get(key);
        if (d?.day === today && d.count >= rpd) {
            const midnight = new Date(); midnight.setHours(24, 0, 0, 0);
            return midnight.getTime() - now;
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
    if (rpm != null) {
        const ts = (_rlTs.get(key) || []).filter(t => now - t < 60_000);
        ts.push(now);
        _rlTs.set(key, ts);
    }
    if (rpd != null) {
        const today = new Date().toISOString().slice(0, 10);
        const d = _rlDay.get(key) || { count: 0, day: today };
        if (d.day !== today) { d.count = 0; d.day = today; }
        d.count++;
        _rlDay.set(key, d);
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
    if (endpoint.provider === 'custom' || endpoint.provider === 'vllm') return true;
    const key = `${endpoint.provider}|${endpoint.model}`;
    return !!_cacheCapMap()[key];
}

// ── Error classification + cooldown operations ───────────────────────────────

export function _isRateLimit(msg: string): boolean {
    // 429: standard rate limit. 402: payment required / quota exhausted. 503: provider throttle.
    return /HTTP 429|HTTP 402|HTTP 503|rate.?limit|too many requests|quota exceeded|insufficient balance|high demand|spikes in demand/i.test(msg || '');
}
export function _isServerError(msg: string): boolean {
    return /HTTP [45]\d\d|idle timeout|signal timed out|read operation timed out|stream error|failed to fetch|networkerror|load failed|connection reset|connection refused|econnreset|socket hang up|bodystreambuffer|stream.*aborted/i.test(msg || '');
}
export function recordSuccess(endpoint: any): void {
    if (!endpoint) return;
    const key = `${endpoint.provider}|${endpoint.model}`;
    _endpointSuccessSinceCooldown.set(key, true);
}
export function _markCooldown(endpoint: any, exactMs: number | null = null): void {
    if (!endpoint) return;
    const key  = `${endpoint.provider}|${endpoint.model}`;
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
    const hadSuccess = _endpointSuccessSinceCooldown.get(key) ?? false; // no entry = no prior success → penalty applies
    _endpointSuccessSinceCooldown.set(key, false); // reset; recordSuccess() will flip back on next hit
    if (!hadSuccess) {
        _endpointCooldown.set(key, Date.now() + RATE_LIMIT_PENALTY_MS);
        return;
    }
    const hits = (_endpointHits.get(key) || 0) + 1;
    _endpointHits.set(key, hits);
    const base  = RATE_LIMIT_COOLDOWN_MS();
    const delay = exactMs !== null
        ? Math.max(exactMs, base)
        : Math.min(base * Math.pow(2, hits - 1), RATE_LIMIT_MAX_MS);
    _endpointCooldown.set(key, Date.now() + delay);
}
export function _markFlatCooldown(endpoint: any, exactMs: number | null = null): void {
    if (!endpoint) return;
    const key = `${endpoint.provider}|${endpoint.model}`;
    const base = endpoint.provider === 'custom' ? 5_000 : RATE_LIMIT_COOLDOWN_MS();
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
    const key     = entry?.key ?? getOAIKey() ?? '';
    const fmt     = entry?.apiFormat || hintProvider || 'openai';
    const path    = fmt === 'ollama' ? '/api/chat' : '/chat/completions';
    const provider = fmt === 'vllm' ? 'vllm' : 'custom';
    // proxy:true routes through the same-origin /api/proxy to avoid CORS in the browser.
    // In headless/Node.js mode there is no browser CORS restriction and no proxy server,
    // so skip it to fetch the LLM endpoint directly.
    const useProxy = !window._fgHeadless;
    return { provider, url: `${baseUrl}${path}`, key, model, proxy: useProxy };
}

// On static hosts (GitHub Pages, *.pages.dev) there is no local server, so route
// CORS-capable providers through the CF Worker too — this lets the worker inject
// shared API keys from its environment when the user hasn't set a local key.
function _staticProxy(): boolean {
    if (window._fgHeadless) return false;
    try {
        const h = window.location.hostname;
        return h.endsWith('.github.io') || h.endsWith('.pages.dev');
    } catch { return false; }
}

export function oaiEndpoint(): any {
    const provider = getProvider();
    const model    = getActiveModel(); // always reads from priority list
    const sp       = _staticProxy();
    if (provider === 'google')      return { provider, url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key: getGeminiKey(), model, proxy: sp };
    if (provider === 'mistral')     return { provider, url: 'https://api.mistral.ai/v1/chat/completions',          key: getMistralKey(),    model };
    if (provider === 'groq')        return { provider, url: 'https://api.groq.com/openai/v1/chat/completions',     key: getGroqKey(),       model, proxy: sp };
    if (provider === 'cerebras')    return { provider, url: 'https://api.cerebras.ai/v1/chat/completions',         key: getCerebrasKey(),   model, proxy: sp };
    if (provider === 'openrouter')  return { provider, url: 'https://openrouter.ai/api/v1/chat/completions',       key: getOpenRouterKey(), model, proxy: sp };
    if (provider === 'opencode')    return { provider, url: 'https://opencode.ai/zen/v1/chat/completions',         key: getOpenCodeKey(), model, proxy: !window._fgHeadless };
    if (provider === 'tokenharbor') return { provider, url: 'https://tokenharbor.ai/v1/chat/completions',          key: getTokenHarborKey(), model, proxy: !window._fgHeadless };
    if (provider === 'kilo')        return { provider, url: 'https://api.kilo.ai/api/gateway/chat/completions',    key: getKiloKey() || '', model, proxy: !window._fgHeadless };
    if (provider === 'vercel')      return { provider, url: 'https://ai-gateway.vercel.sh/v1/chat/completions',    key: getVercelKey(), model, proxy: !window._fgHeadless };
    if (provider === 'nous')        return { provider, url: 'https://inference-api.nousresearch.com/v1/chat/completions', key: getNousKey(), model, proxy: sp };
    if (provider === 'nvidia') {
        return { provider, url: 'https://integrate.api.nvidia.com/v1/chat/completions', key: getNvidiaKey(), model, proxy: !window._fgHeadless };
    }
    if (provider === 'vllm' || provider === 'custom') {
        return _customEndpoint(model, provider);
    }
    return _customEndpoint(model, 'custom');
}

// Returns the default endpoint for the current provider configuration.
export function _defaultEndpoint(): any { return oaiEndpoint(); }

export function specToEndpoint(spec: string): any {
    if (!spec) return null;
    const idx      = spec.indexOf('|');
    const provider = idx !== -1 ? spec.slice(0, idx) : spec;
    const model    = idx !== -1 ? spec.slice(idx + 1) : spec;
    const sp = _staticProxy();
    if (provider === 'google')     return { provider, url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key: getGeminiKey(), model, proxy: sp };
    if (provider === 'mistral')    return { provider, url: 'https://api.mistral.ai/v1/chat/completions',          key: getMistralKey(),    model };
    if (provider === 'groq')       return { provider, url: 'https://api.groq.com/openai/v1/chat/completions',     key: getGroqKey(),       model, proxy: sp };
    if (provider === 'cerebras')   return { provider, url: 'https://api.cerebras.ai/v1/chat/completions',         key: getCerebrasKey(),   model, proxy: sp };
    if (provider === 'openrouter') return { provider, url: 'https://openrouter.ai/api/v1/chat/completions',       key: getOpenRouterKey(), model, proxy: sp };
    if (provider === 'opencode')    return { provider, url: 'https://opencode.ai/zen/v1/chat/completions',         key: getOpenCodeKey(), model, proxy: !window._fgHeadless };
    if (provider === 'tokenharbor') return { provider, url: 'https://tokenharbor.ai/v1/chat/completions',          key: getTokenHarborKey(), model, proxy: !window._fgHeadless };
    if (provider === 'kilo')        return { provider, url: 'https://api.kilo.ai/api/gateway/chat/completions',    key: getKiloKey() || '', model, proxy: !window._fgHeadless };
    if (provider === 'vercel')      return { provider, url: 'https://ai-gateway.vercel.sh/v1/chat/completions',    key: getVercelKey(), model, proxy: !window._fgHeadless };
    if (provider === 'nous')        return { provider, url: 'https://inference-api.nousresearch.com/v1/chat/completions', key: getNousKey(), model, proxy: sp };
    if (provider === 'nvidia') {
        return { provider, url: 'https://integrate.api.nvidia.com/v1/chat/completions', key: getNvidiaKey(), model, proxy: !window._fgHeadless };
    }
    if (provider === 'vllm' || provider === 'custom') {
        return _customEndpoint(model, provider);
    }
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
    saveMainModelList([key, ...list.filter(k => k !== key)]);
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
    if (setting && setting !== '') {
        // A specific provider|model was selected.
        return setting;
    }

    // Default: follow priority list rotation (first active model).
    let wSpec: string | null = getActiveMainModelList()[0] || null;
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
    return specToEndpoint(spec);
}

// Window bridge for free-variable access from sibling modules (house pattern).
Object.assign(window, {
    _endpointCooldown, _endpointHits, _endpointNeedsProbe, _endpointSuccessSinceCooldown,
    RATE_LIMIT_COOLDOWN_MS, RATE_LIMIT_MAX_MS, RATE_LIMIT_PENALTY_MS,
    knownLimitWaitMs, recordRequest, recordSuccess, recordCacheCapable, isCacheCapable,
    _isRateLimit, _isServerError, _markCooldown, _markFlatCooldown, _markExactCooldown, _isCoolingDown, getCooldownRemaining,
    oaiEndpoint, specToEndpoint, _defaultEndpoint, firstFreeEndpoint, utilityEndpoint,
    _anyFreeSpec, getRateLimitFallbackEndpoint, _switchToFreeModel, _nextRotationSpec,
    modelFriendlyName, resolveWorkerModelSpec,
});
