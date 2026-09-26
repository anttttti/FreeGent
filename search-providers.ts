// search-providers.js — FreeGent: web-search backends (Tavily / Brave / Wikipedia)
// Depends on: config.js globals (getTavilyKey, getBraveKey, getSearchProxy, getSearchProvider),
//             state.js (activeAbortController live binding).
import { activeAbortController } from './state.js';

// Combines the user-facing abort controller with a per-request hard timeout so
// search fetches always terminate even if the global controller is null or stale.
const SEARCH_TIMEOUT_MS = 30_000;
function _searchSignal(): AbortSignal {
    const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
    const user    = activeAbortController?.signal;
    if (!user) return timeout;
    return typeof AbortSignal.any === 'function' ? AbortSignal.any([user, timeout]) : timeout;
}

export async function tavilySearch(query: any): Promise<{ error: string; authFailed?: boolean; source?: undefined; results?: undefined; } | { source: string; results: any; error?: undefined; }> {
    const localKey  = getTavilyKey();
    const cfHasKey  = typeof hasCfTavilyKey === 'function' && hasCfTavilyKey();
    const cfProxy   = typeof getEffectiveProxy === 'function' ? getEffectiveProxy() : '';

    // Use CF Worker POST proxy when the Worker has a shared key or when the user's
    // own key needs a proxy to cross origins.  Fall back to a direct browser fetch
    // only when no proxy is available and the user has a local key.
    let resp: Response;
    try {
        if (cfProxy) {
            // Route through CF Worker POST proxy so it can inject the shared key
            // (when localKey is absent) or just handle CORS (when localKey is present).
            const authHeaders: Record<string, string> = localKey
                ? { 'Authorization': `Bearer ${localKey}` }
                : {};   // Worker injects TAVILY_API_KEY when Authorization is empty
            resp = await fetch(cfProxy, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    url:     'https://api.tavily.com/search',
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders },
                    body:    JSON.stringify({ query, search_depth: 'basic', max_results: 5, include_answer: false }),
                }),
                signal:  _searchSignal(),
            });
        } else if (localKey) {
            // No proxy available — direct browser fetch (works only if Tavily allows CORS, or in dev)
            resp = await fetch('https://api.tavily.com/search', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localKey}` },
                body:    JSON.stringify({ query, search_depth: 'basic', max_results: 5, include_answer: false }),
                signal:  _searchSignal(),
            });
        } else {
            return { error: 'Tavily API key not configured.' };
        }
        if (!resp.ok) {
            if (resp.status === 401 || resp.status === 403) {
                let detail = '';
                try { detail = (await resp.json())?.detail?.error ?? ''; } catch {}
                const hint = detail || 'invalid or expired API key — check Settings → Search';
                return { error: `Tavily ${resp.status}: ${hint}`, authFailed: true };
            }
            return { error: `Tavily HTTP ${resp.status}` };
        }
        const data = await resp.json();
        const _an = typeof annotateUrl === 'function' ? annotateUrl : (u: string) => u;
        return {
            source:  'Tavily',
            results: (data.results || []).map((r: any) => ({ title: r.title, url: _an(r.url), snippet: (r.content || '').slice(0, 400) }))
        };
    } catch (e: any) { return { error: `Tavily: ${e.message}` }; }
}

export async function braveSearch(query: any): Promise<any> {
    const localKey    = getBraveKey();
    const manualProxy = getSearchProxy();   // user-configured custom proxy (legacy)
    const cfProxy     = typeof getEffectiveProxy === 'function' ? getEffectiveProxy() : '';
    const cfHasKey    = typeof hasCfBraveKey === 'function' && hasCfBraveKey();

    try {
        let resp: Response;

        if (manualProxy) {
            // Legacy path: user has a custom Brave proxy (e.g. self-hosted).
            // It expects ?q=query and optionally X-Brave-Key header.
            const headers: Record<string, string> = {};
            if (localKey) headers['X-Brave-Key'] = localKey;
            resp = await fetch(`${manualProxy}?q=${encodeURIComponent(query)}`, {
                headers,
                signal: _searchSignal(),
            });
        } else if (localKey || cfHasKey) {
            // Route through CF Worker POST proxy to Brave Search API.
            // Worker injects X-Subscription-Token from BRAVE_API_KEY when no local key.
            const braveHeaders: Record<string, string> = {};
            if (localKey) braveHeaders['X-Subscription-Token'] = localKey;
            const braveUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`;
            // No proxy (headless): no CORS either, so call Brave directly with the user's key.
            if (!cfProxy && localKey) resp = await fetch(braveUrl, { headers: braveHeaders, signal: _searchSignal() });
            else if (!cfProxy) return { error: 'Brave search requires a proxy URL. Set it in Settings → Search.' };
            else resp = await fetch(cfProxy, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ url: braveUrl, method: 'GET', headers: braveHeaders }),
                signal: _searchSignal(),
            });
        } else {
            return { error: 'Brave search requires a Brave API key or a proxy URL. Set it in Settings → Search.' };
        }

        if (!resp.ok) return { error: `Brave HTTP ${resp.status}` };
        const data = await resp.json();
        // Brave Search API v1 returns { web: { results: [...] } }; legacy proxies
        // may return { results: [...] } directly — support both.
        const results = data.web?.results ?? data.results;
        const _an = typeof annotateUrl === 'function' ? annotateUrl : (u: string) => u;
        const mapped = Array.isArray(results)
            ? results.map((r: any) => r?.url ? { ...r, url: _an(r.url) } : r)
            : results;
        return { source: 'Brave', results: mapped };
    } catch (e: any) { return { error: `Brave: ${e.message}` }; }
}

export async function wikipediaSearch(query: any): Promise<{ error: string; source?: undefined; results?: undefined; } | { source: string; results: any[]; error?: undefined; }> {
    try {
        const searchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=3&namespace=0&format=json&origin=*`;
        const r = await fetch(searchUrl, { signal: _searchSignal() });
        if (!r.ok) return { error: `Wikipedia HTTP ${r.status}` };
        const [, titles] = await r.json();
        if (!titles?.length) return { source: 'Wikipedia', results: [] };
        const summaries = await Promise.all(titles.slice(0, 3).map(async t => {
            try {
                const sr = await fetch(
                    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t)}`,
                    { signal: _searchSignal() }
                );
                if (!sr.ok) return null;
                const d = await sr.json();
                const _u = d.content_urls?.desktop?.page || '';
                const _an = typeof annotateUrl === 'function' ? annotateUrl : (u: string) => u;
                return { title: d.title, url: _an(_u), snippet: d.extract || '' };
            } catch { return null; }
        }));
        return { source: 'Wikipedia', results: summaries.filter(Boolean) };
    } catch (e) { return { error: `Wikipedia: ${e.message}` }; }
}

// Ordered fallback chain for 'auto' mode: try each configured provider in turn,
// return the first success. On auth failure (401/403), skip that provider
// immediately — retrying with the same bad key won't help.
export async function performWebSearch(query: any): Promise<any> {
    const sp        = getSearchProvider();
    const tavilyKey = getTavilyKey();
    const braveKey  = getBraveKey();
    const proxy     = getSearchProxy();
    const cfTavily  = typeof hasCfTavilyKey === 'function' && hasCfTavilyKey();
    const cfBrave   = typeof hasCfBraveKey  === 'function' && hasCfBraveKey();

    const hasTavily = !!(tavilyKey || cfTavily);
    const hasBrave  = !!(braveKey  || cfBrave || proxy);

    // Explicit provider: honour it, no fallback (user made a deliberate choice).
    if (sp !== 'auto') {
        if (sp === 'tavily')    return hasTavily ? tavilySearch(query) : { error: 'Tavily key not set.' };
        if (sp === 'brave')     return braveSearch(query);
        if (sp === 'wikipedia') return wikipediaSearch(query);
        return wikipediaSearch(query);
    }

    // Auto mode: build the candidate list from what's actually configured,
    // then try each in sequence until one succeeds.
    type SearchFn = () => Promise<any>;
    const candidates: Array<{ name: string; fn: SearchFn }> = [];
    if (hasTavily) candidates.push({ name: 'Tavily',    fn: () => tavilySearch(query) });
    if (hasBrave)  candidates.push({ name: 'Brave',     fn: () => braveSearch(query) });
    candidates.push(               { name: 'Wikipedia', fn: () => wikipediaSearch(query) });

    const errors: string[] = [];
    for (const { name, fn } of candidates) {
        const result = await fn();
        if (!result.error) return result;          // success — done
        errors.push(`${name}: ${result.error}`);
        // Auth failures are permanent for this key — no point retrying later providers
        // differently, but we do still continue to the next provider in the chain.
        console.warn(`[performWebSearch] ${name} failed, trying next provider. Error: ${result.error}`);
    }
    // All providers exhausted — return a combined error so the model knows what happened.
    return { error: `All search providers failed:\n${errors.map(e => `  • ${e}`).join('\n')}` };
}

// Window bridge for classic scripts.
Object.assign(window, { tavilySearch, braveSearch, wikipediaSearch, performWebSearch });
