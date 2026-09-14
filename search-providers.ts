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
    const key = getTavilyKey();
    if (!key) return { error: 'Tavily API key not configured.' };
    try {
        const resp = await fetch('https://api.tavily.com/search', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ api_key: key, query, search_depth: 'basic', max_results: 5, include_answer: false }),
            signal:  _searchSignal()
        });
        if (!resp.ok) {
            // On auth failure, read the body for the server's own message and tag it
            // so callers can distinguish a bad-key error from a transient failure.
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
            results: (data.results || []).map(r => ({ title: r.title, url: _an(r.url), snippet: (r.content || '').slice(0, 400) }))
        };
    } catch (e) { return { error: `Tavily: ${e.message}` }; }
}

export async function braveSearch(query: any): Promise<any> {
    const proxy = getSearchProxy();
    if (!proxy) return { error: 'Brave search requires a proxy URL. Set it in Settings → Search.' };
    try {
        const headers = {};
        const key = getBraveKey();
        if (key) headers['X-Brave-Key'] = key;
        const resp = await fetch(`${proxy}?q=${encodeURIComponent(query)}`, {
            headers,
            signal: _searchSignal()
        });
        if (!resp.ok) return { error: `Brave HTTP ${resp.status}` };
        const data = await resp.json();
        // Annotate result URLs with [UNAVAILABLE] when the host is blacklisted.
        const _an = typeof annotateUrl === 'function' ? annotateUrl : (u: string) => u;
        if (Array.isArray(data.results))
            data.results = data.results.map((r: any) => r?.url ? { ...r, url: _an(r.url) } : r);
        return { source: 'Brave', ...data };
    } catch (e) { return { error: `Brave: ${e.message}` }; }
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
    const proxy     = getSearchProxy();

    // Explicit provider: honour it, no fallback (user made a deliberate choice).
    if (sp !== 'auto') {
        if (sp === 'tavily')    return tavilyKey ? tavilySearch(query) : { error: 'Tavily key not set.' };
        if (sp === 'brave')     return braveSearch(query);
        if (sp === 'wikipedia') return wikipediaSearch(query);
        return wikipediaSearch(query);
    }

    // Auto mode: build the candidate list from what's actually configured,
    // then try each in sequence until one succeeds.
    type SearchFn = () => Promise<any>;
    const candidates: Array<{ name: string; fn: SearchFn }> = [];
    if (tavilyKey) candidates.push({ name: 'Tavily',    fn: () => tavilySearch(query) });
    if (proxy)     candidates.push({ name: 'Brave',     fn: () => braveSearch(query) });
    candidates.push(           { name: 'Wikipedia', fn: () => wikipediaSearch(query) });

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
