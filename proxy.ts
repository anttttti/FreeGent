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

/** True when `url` is on the default Worker's origin. A string prefix test also matched
 *  https://proxy.freegent.ai.example.com and would have sent the Developer key there. */
export function isDefaultWorkerUrl(url: string): boolean {
    try { return new URL(url).origin === new URL(DEFAULT_CF_WORKER).origin; }
    catch { return false; }
}

/** The Developer key (localStorage fg_dev_key; was fg_pass, moved on first read). Unlocks the Worker's
 *  shared provider keys and turns on developer logging (dev-log.ts). Empty string when unset. */
export const DEV_KEY_LS = 'fg_dev_key';
export function getDevKey(): string {
    try {
        let v = localStorage.getItem(DEV_KEY_LS);
        if (v === null) {
            const old = localStorage.getItem('fg_pass');
            if (old !== null) { localStorage.setItem(DEV_KEY_LS, old); localStorage.removeItem('fg_pass'); v = old; }
        }
        return v ?? '';
    } catch { return ''; }
}

// Requests to the CF Worker carry the saved Developer key, if any.
export function installPassHeader(): void {
    const _origFetch = window.fetch;
    window.fetch = function (input: any, init?: any) {
        try {
            const url = typeof input === 'string' ? input : input?.url ?? String(input);
            const pass = getDevKey();
            if (pass && typeof url === 'string' && isDefaultWorkerUrl(url)) {
                const headers = new Headers(init?.headers ?? (typeof input === 'object' ? input.headers : undefined));
                headers.set('X-FG-Dev-Key', pass);
                return _origFetch.call(window, input, { ...init, headers });
            }
        } catch {}
        return _origFetch.call(window, input, init);
    } as typeof fetch;
}
