// privacy.ts — FreeGent: the network privacy level (Settings → Privacy) and the rules that follow from it.
// Pure functions, no imports, so proxy.ts, config.ts, the sandbox hosts and the tests can all use them.
//
//   default   today's behaviour: model and web requests go through the hosted Cloudflare Worker on a static
//             host (freegent.ai, *.github.io, *.pages.dev), or through the local server's /api/proxy.
//   provider  the browser talks to the model provider directly. Nothing goes to the hosted or a custom
//             Worker, the page-view counter, log uploads and the location lookup are off. The local dev
//             server's own /api/proxy still works: it runs on this machine and holds the credentials file keys.
//   local     only localhost and local-network addresses. Cloud providers, web search and fetch_url are
//             refused, and sandboxed code gets a CSP that blocks its own network calls.
//
// Libraries and runtimes that the page loads with <script> or import() (jsdelivr, esm.sh) are not fetch calls
// and load at every level; the browser caches them afterwards.

type PrivacyLevel = 'default' | 'provider' | 'local';
const PRIVACY_LEVEL_KEY = 'fg_privacy_level';

export function parsePrivacyLevel(v: unknown): PrivacyLevel {
    return v === 'provider' || v === 'local' ? v : 'default';
}

export function getPrivacyLevel(): PrivacyLevel {
    try { return parsePrivacyLevel(localStorage.getItem(PRIVACY_LEVEL_KEY)); } catch { return 'default'; }
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

const LEVEL_NAME: Record<PrivacyLevel, string> = { default: 'Default', provider: 'Provider-only', local: 'Local' };

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
    if (level === 'default') return null;
    let u: URL;
    try { u = new URL(target, ctx.pageOrigin); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
    const name = LEVEL_NAME[level];
    if (level === 'provider') {
        return ctx.workerOrigins.includes(u.origin)
            ? `Blocked by Settings → Privacy (${name}): ${u.host} is a Cloudflare Worker. Choose Default to use it.` : null;
    }
    // The page's own origin is where the app was served from, including its static files.
    if (u.origin === ctx.pageOrigin || isLocalAddress(u.hostname)) return null;
    return `Blocked by Settings → Privacy (${name}): ${u.host} is not on this machine or your local network.`;
}

/** Providers whose API sends no CORS headers (checked 2026-10-18), so a browser cannot call them without the Worker. */
const NO_BROWSER_CORS_PROVIDERS: ReadonlySet<string> = new Set(['nvidia', 'kilo']);

/** True when a model cannot be used at this level, so it should not enter the rotation. */
export function providerBlockedByPrivacy(provider: string, level: PrivacyLevel, opts: { staticHost: boolean; url?: string }): boolean {
    if (level === 'default') return false;
    if (level === 'provider') return opts.staticHost && NO_BROWSER_CORS_PROVIDERS.has(provider);
    if (provider === 'custom' || provider === 'vllm') {
        if (!opts.url) return false;
        try { return !isLocalAddress(new URL(opts.url).hostname); } catch { return false; }
    }
    return true;
}

/** `<meta>` CSP for sandboxed frames: at the "local" level their own fetch/XHR/WebSocket may reach only this
 *  machine (plus the CDN that serves the runtimes). Empty at the other levels. */
export function sandboxCspMeta(level: PrivacyLevel = getPrivacyLevel()): string {
    if (level !== 'local') return '';
    const src = "connect-src data: blob: http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:* https://cdn.jsdelivr.net";
    return `<meta http-equiv="Content-Security-Policy" content="${src}">`;
}
