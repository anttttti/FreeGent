// proxy.ts — FreeGent: the one place that decides which proxy a request goes through.
//
//   'get'   plain-GET path (fetch_url, search, arXiv): manual proxy → headless '' → CF Worker on a
//           static host → same-origin /api/proxy.
//   'post'  LLM-POST path: same as 'get' (the Worker only forwards allow-listed LLM hosts for POST).
//   'local' the local dev server only — manual proxy and the CF Worker are never used. MCP uses
//           this: MCP servers are arbitrary user-chosen hosts the Worker's POST allow-list would
//           refuse, and the user's MCP credentials must not go through a shared proxy. On a static
//           host or headless it is '' (direct fetch), which is a deliberate policy, not an omission.
import { isStaticHost } from './static-hosts.js';

export const DEFAULT_CF_WORKER = 'https://proxy.freegent.ai';
export type ProxyKind = 'get' | 'post' | 'local';

export function resolveProxy(kind: ProxyKind, manual = ''): string {
    if (kind !== 'local' && manual) return kind === 'post' ? manual.replace(/\/$/, '') : manual;
    // Headless (fg-run, benchmarks) has no local server and no CORS: fetch directly.
    if ((window as any)._fgHeadless) return '';
    try {
        if (isStaticHost(window.location.hostname)) return kind === 'local' ? '' : DEFAULT_CF_WORKER;
        // Same-origin /api/proxy also covers LAN-IP access (https://192.168.1.28:5000), avoiding CORS.
        return `${window.location.origin}/api/proxy`;
    } catch { return ''; }
}

// Requests to the CF Worker carry the saved passphrase, if any.
export function installPassHeader(): void {
    const _origFetch = window.fetch;
    window.fetch = function (input: any, init?: any) {
        try {
            const url = typeof input === 'string' ? input : input?.url ?? String(input);
            const pass = localStorage.getItem('fg_pass');
            if (pass && typeof url === 'string' && url.startsWith(DEFAULT_CF_WORKER)) {
                const headers = new Headers(init?.headers ?? (typeof input === 'object' ? input.headers : undefined));
                headers.set('X-FG-Pass', pass);
                return _origFetch.call(window, input, { ...init, headers });
            }
        } catch {}
        return _origFetch.call(window, input, init);
    } as typeof fetch;
}
