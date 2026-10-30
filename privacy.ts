// privacy.ts — FreeGent: the network privacy level (Settings → Privacy) and the rules that follow from it.
// Pure functions, no imports, so proxy.ts, config.ts, the sandbox hosts and the tests can all use them.
//
//   routed    model and web requests go through the hosted Cloudflare Worker on a static host (freegent.ai,
//             *.github.io, *.pages.dev), or through the local server's /api/proxy.
//   provider  the browser talks to the model provider directly. Nothing goes to the hosted or a custom
//             Worker, log uploads and the location lookup are off. The anonymous page-view counter still runs
//             (opt out in Settings → Privacy). The local dev
//             server's own /api/proxy still works: it runs on this machine and holds the credentials file keys.
//   local     only localhost and local-network addresses. Cloud providers, web search and fetch_url are
//             refused, and sandboxed code gets a CSP that blocks its own network calls.
//
// Without a saved choice the level is Provider-only, or Routed while a Developer key is saved (the key only
// works through the Worker). The choice is made in the sidebar's Privacy button or Settings → Privacy.
// "default" is the old name of "routed" and still reads as it.
//
// Libraries and runtimes that the page loads with <script> or import() (jsdelivr, esm.sh) are not fetch calls
// and load at every level; the browser caches them afterwards.

type PrivacyLevel = 'routed' | 'provider' | 'local';
const PRIVACY_LEVEL_KEY = 'fg_privacy_level';
const DEV_KEY_STORAGE = 'fg_dev_key';   // proxy.ts DEV_KEY_LS; not imported, to keep this module import-free

/** The saved level, or null when `v` is not one (never chosen, or an unknown value). */
export function parsePrivacyLevel(v: unknown): PrivacyLevel | null {
    return v === 'routed' || v === 'default' ? 'routed' : v === 'provider' || v === 'local' ? v : null;
}

/** The level when nothing is saved: Routed with a Developer key, else Provider-only. */
export function defaultPrivacyLevel(hasDevKey: boolean): PrivacyLevel {
    return hasDevKey ? 'routed' : 'provider';
}

export function getPrivacyLevel(): PrivacyLevel {
    // Headless runs (fg-run, benchmarks) have no page, no Worker and no saved choice: nothing to restrict.
    try { if ((globalThis as any).window?._fgHeadless || (globalThis as any)._fgHeadless) return 'routed'; } catch {}
    try {
        const saved = parsePrivacyLevel(localStorage.getItem(PRIVACY_LEVEL_KEY));
        return saved ?? defaultPrivacyLevel(!!localStorage.getItem(DEV_KEY_STORAGE));
    } catch { return 'provider'; }
}

export function setPrivacyLevel(level: PrivacyLevel): void {
    try { localStorage.setItem(PRIVACY_LEVEL_KEY, level); } catch {}
}

/** True for loopback, link-local, private-range and single-label (LAN name) hosts. */
export function isLocalAddress(host: string): boolean {
    let h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!h) return false;
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
    const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
    }
    if (h.includes(':')) {
        const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isLocalAddress(mapped[1]);
        return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
    }
    return !h.includes('.');
}

export interface PrivacyContext {
    /** `location.origin` of the page. */
    pageOrigin: string;
    /** Origins of Workers that must not be contacted at the "provider" level (the hosted one, a custom one). */
    workerOrigins: string[];
}

export const PRIVACY_LABELS: Record<PrivacyLevel, string> = { routed: 'Routed', provider: 'Provider-only', local: 'Local' };
/** One-sentence explanations, shown as tooltips in the sidebar's Privacy menu. */
export const PRIVACY_HELP: Record<PrivacyLevel, string> = {
    routed: 'Requests go through FreeGent\'s Cloudflare Worker (or your local server\'s proxy), which forwards them and stores nothing. Works with every provider and with web search and fetch.',
    provider: 'Your browser calls the model providers directly. NVIDIA, Kilo and sites without CORS headers cannot be reached.',
    local: 'Only localhost and local-network addresses are reachable: local models and MCP servers on your network. Cloud providers, web search and fetch_url are refused.',
};
const LEVEL_NAME = PRIVACY_LABELS;

/** The real destination of a request to the local server's /api/proxy: `?url=` for GETs, `{url}` in a POST body. */
export function proxiedTarget(url: string, body: unknown, pageOrigin: string): string | null {
    try {
        const u = new URL(url, pageOrigin);
        if (u.origin !== pageOrigin || !u.pathname.endsWith('/api/proxy')) return null;
        const q = u.searchParams.get('url');
        if (q) return q;
        if (typeof body === 'string') { const j = JSON.parse(body); if (j && typeof j.url === 'string') return j.url; }
    } catch {}
    return null;
}

/** Why `target` may not be contacted at this level, or null when it may. Non-network schemes are always fine. */
export function privacyBlockReason(target: string, level: PrivacyLevel, ctx: PrivacyContext): string | null {
    if (level === 'routed') return null;
    let u: URL;
    try { u = new URL(target, ctx.pageOrigin); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
    const name = LEVEL_NAME[level];
    if (level === 'provider') {
        return ctx.workerOrigins.includes(u.origin)
            ? `Blocked by Settings → Privacy (${name}): ${u.host} is a Cloudflare Worker. Choose Routed to use it.` : null;
    }
    // The page's own origin is where the app was served from, including its static files.
    if (u.origin === ctx.pageOrigin || isLocalAddress(u.hostname)) return null;
    return `Blocked by Settings → Privacy (${name}): ${u.host} is not on this machine or your local network.`;
}

/** Providers whose API sends no CORS headers (checked 2026-10-18), so a browser cannot call them without the Worker. */
const NO_BROWSER_CORS_PROVIDERS: ReadonlySet<string> = new Set(['nvidia', 'kilo']);

/** True when a model cannot be used at this level, so it should not enter the rotation. */
export function providerBlockedByPrivacy(provider: string, level: PrivacyLevel, opts: { staticHost: boolean; url?: string }): boolean {
    if (level === 'routed') return false;
    if (level === 'provider') return opts.staticHost && NO_BROWSER_CORS_PROVIDERS.has(provider);
    if (provider === 'custom' || provider === 'vllm') {
        if (!opts.url) return false;
        try { return !isLocalAddress(new URL(opts.url).hostname); } catch { return false; }
    }
    return true;
}

/** `<meta>` CSP for sandboxed frames: at the "local" level their own fetch/XHR/WebSocket may reach only this
 *  machine (plus the CDN that serves the runtimes). Empty at the other levels. */
// The runtimes the sandbox loads from the CDN: Pyodide and the 7-Zip WASM build. Only these paths, not the whole host: with all of
// cdn.jsdelivr.net allowed, code in the sandbox could send workspace data out in the path or query of any request there (codex R269).
const _RUNTIME_CDN = ['https://cdn.jsdelivr.net/pyodide/', 'https://cdn.jsdelivr.net/npm/7z-wasm@'];
const _LOCAL_HOSTS = 'http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*';
export function sandboxCspMeta(level: PrivacyLevel = getPrivacyLevel(), pageOrigin: string = (() => { try { return location.origin; } catch { return ''; } })()): string {
    if (level !== 'local') return '';
    const page = pageOrigin && pageOrigin !== 'null' ? ` ${pageOrigin}` : '';
    const cdn = _RUNTIME_CDN.join(' ');
    // connect-src alone left every other kind of request open: an <img>, a font, a frame or a script URL could carry data anywhere, and the
    // in-frame JavaScript fallback has Image (codex R267). Each kind is limited to this machine, the page and the runtime paths.
    const src = [
        `default-src 'none'`,
        `connect-src data: blob: ${_LOCAL_HOSTS}${page} ${cdn}`,
        `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob: ${_LOCAL_HOSTS}${page} ${cdn}`,
        `worker-src blob: data: ${_LOCAL_HOSTS}${page}`,
        `style-src 'unsafe-inline' data: blob: ${_LOCAL_HOSTS}${page}`,
        `img-src data: blob: ${_LOCAL_HOSTS}${page}`,
        `media-src data: blob: ${_LOCAL_HOSTS}${page}`,
        `font-src data: blob: ${_LOCAL_HOSTS}${page}`,
        `frame-src data: blob: ${_LOCAL_HOSTS}${page}`,
    ].join('; ');
    return `<meta http-equiv="Content-Security-Policy" content="${src}">`;
}
