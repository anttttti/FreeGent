// exec-sandbox/net.ts — network access for code in the exec sandbox. entry.ts installs
// sandboxFetch as the frame's fetch, so shiro's curl/wget/node/python3/npm and the JS runner all
// use it; the Pyodide worker has its own copy of the fallback (pyodide-worker.ts).
//
// Requests go out directly first. The frame's origin is opaque (Origin: null), so only sites that
// allow any origin (Access-Control-Allow-Origin: *) answer — npm, PyPI, raw.githubusercontent.com
// and many public APIs do. When the browser refuses a plain GET, it is retried through the page,
// which fetches it via the same proxy fetch_url uses (exec-sandbox-host.ts _answerNet). That path
// carries no request headers or body, so other methods, and headers the site needs, only work
// against sites that allow cross-origin requests.

import { pageFetch, type PageFetchResult } from './channel';

// Response headers a proxied response gets; lets callers (curl -v) say how it was fetched.
export const VIA_PROXY_HEADER = 'X-FG-Via-Proxy';

const directFetch = globalThis.fetch.bind(globalThis);

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

export function responseFromPage(r: PageFetchResult): Response {
    const headers: Record<string, string> = { [VIA_PROXY_HEADER]: '1' };
    if (r.contentType) headers['Content-Type'] = r.contentType;
    return new Response(NULL_BODY_STATUS.has(r.status) ? null : r.body, { status: r.status, headers });
}

// Whether a request the browser refused may be retried as a proxied plain GET.
export function proxyable(url: string, method: string, hasBody: boolean): boolean {
    return (method === 'GET' || method === 'HEAD') && !hasBody && /^https?:\/\//i.test(url);
}

export async function sandboxFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    try {
        return await directFetch(input, init);
    } catch (err) {
        // A refused cross-origin request (CORS) or network failure is a TypeError; aborts are not.
        if (!(err instanceof TypeError)) throw err;
        const url    = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        if (!proxyable(url, method, init.body != null)) throw err;
        return responseFromPage(await pageFetch(url));
    }
}
