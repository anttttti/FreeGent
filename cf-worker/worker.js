/**
 * cf-worker/worker.js — FreeGent CORS proxy for GitHub Pages deployments.
 *
 * Deploy once to your own Cloudflare account (free tier is enough):
 *
 *   cd cf-worker
 *   npx wrangler deploy
 *
 * Then paste the resulting URL (e.g. https://freegent-proxy.you.workers.dev)
 * into FreeGent Settings → CORS Proxy / CF Worker URL.
 *
 * Optional: add shared API keys as Cloudflare secrets so GitHub Pages
 * users can access those providers without configuring their own keys:
 *
 *   npx wrangler secret put OPENROUTER_API_KEY
 *   npx wrangler secret put GROQ_API_KEY
 *   npx wrangler secret put GEMINI_API_KEY
 *   npx wrangler secret put NOUS_API_KEY
 *   npx wrangler secret put TAVILY_API_KEY
 *   npx wrangler secret put BRAVE_API_KEY
 *
 * Secrets are stored encrypted in Cloudflare — never in the repo code.
 * They are injected into requests as Authorization headers when the
 * client hasn't supplied its own key.  The user's own key always wins.
 *
 * What this does
 * ──────────────
 * GitHub Pages cannot run server-side code, so browser fetch() calls to
 * LLM providers that don't send CORS headers are blocked. This Worker is a
 * thin passthrough that adds the missing CORS headers and forwards the request.
 *
 * Three request shapes are supported:
 *
 *   GET  /keys                   – returns which provider keys are configured
 *   GET  ?url=<encoded>          – used by fetch_url and web-search tools
 *   POST {url, headers?, body?}  – used by all LLM provider calls
 *
 * Security
 * ──────────────────
 * - Origin check: only browsers from ALLOWED_ORIGINS may call this worker.
 * - POST (LLM proxy): strict domain allowlist — only known LLM/search providers.
 * - GET  (fetch_url): any public HTTPS URL; private/reserved IPs are blocked (SSRF guard).
 * - Secrets never leave the worker; /keys only returns true/false per provider.
 *
 * Privacy
 * ──────────────────
 * The Worker is a pure passthrough. No data is logged, stored, or inspected —
 * with one opt-in exception: POST /log stores a chat log the user explicitly sends from the app
 * ("Send log to developer") in the FG_LOGS KV namespace for 14 days. It is write-only here;
 * logs are read with `wrangler kv`. Without the FG_LOGS binding the endpoint answers 503.
 * API keys (user's own or injected from env) are forwarded directly to the
 * provider and never retained.
 *
 * Free-tier limits
 * ──────────────────
 * Cloudflare's free Workers plan allows 100 000 req/day and up to 30 seconds
 * of wall time per request.
 */

// ── Allowed request origins ───────────────────────────────────────────────────
const ALLOWED_ORIGINS = new Set([
    'https://freegent.ai',           // production
    'https://www.freegent.ai',
    'https://anttttti.github.io',   // old GitHub Pages URL — remove once traffic has moved to freegent.ai
    'http://localhost:5173',         // Vite dev server
    'http://localhost:4173',         // Vite preview
    'http://localhost:3000',
    'http://localhost:5000',         // Vite dev server (actual default port)
    'http://127.0.0.1:5000',
]);

// ── Allowed upstream hostnames (POST / LLM proxy only) ───────────────────────
// GET fetch_url requests use _publicUrlOk() instead — any public HTTPS URL.
const ALLOWED_HOSTS = new Set([
    'generativelanguage.googleapis.com',
    'api.groq.com',
    'openrouter.ai',
    'api.openrouter.ai',
    'nous.hermes.ai',
    'inference-api.nousresearch.com',
    'api.kilo.ai',
    'integrate.api.nvidia.com',
    'tokenharbor.ai',
    'api.tokenharbor.ai',
    'ai-gateway.vercel.sh',
    'api.openai.com',
    'api.search.brave.com',
    'api.tavily.com',
]);

// ── Provider → env var name ───────────────────────────────────────────────────
// Used to inject shared keys when the client sends no Authorization header.
// Must match _CF_PROVIDER_ENV in config.ts.
// Note: Brave (api.search.brave.com) uses X-Subscription-Token, not Authorization —
// its key is injected separately below after this map is applied.
const PROVIDER_KEY_MAP = {
    'generativelanguage.googleapis.com': 'GEMINI_API_KEY',
    'api.groq.com':                      'GROQ_API_KEY',
    'openrouter.ai':                     'OPENROUTER_API_KEY',
    'api.openrouter.ai':                 'OPENROUTER_API_KEY',
    'inference-api.nousresearch.com':    'NOUS_API_KEY',
    'tokenharbor.ai':                    'TOKENHARBOR_API_KEY',
    'api.tokenharbor.ai':                'TOKENHARBOR_API_KEY',
    'api.tavily.com':                    'TAVILY_API_KEY',
};

// Search providers that use non-standard auth headers (not Authorization: Bearer).
// Injected after the standard PROVIDER_KEY_MAP pass.
const SEARCH_HEADER_MAP = {
    'api.search.brave.com': { envKey: 'BRAVE_API_KEY', header: 'X-Subscription-Token' },
};

const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, HTTP-Referer, X-Title, Accept',
    'Access-Control-Max-Age':       '86400',
    'Access-Control-Expose-Headers': 'X-FG-Proxy-Error',
};

// ── POST /log: a user-sent chat log, stored for debugging ─────────────────────
// Handled before the origin check: the app also runs from LAN-IP and plain-HTTP pages (older iPads)
// whose origin cannot be allow-listed. Bounded instead by the size cap, the per-IP rate limit and
// the KV expiry; the endpoint cannot read anything back.
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_TTL_SECONDS = 14 * 24 * 3600;
async function _storeLog(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return _err(405, 'POST only');
    if (!env || !env.FG_LOGS) return _err(503, 'Log upload is not configured on this Worker');
    if (await _rateLimited(request, env, 'log')) return _err(429, 'Rate limit exceeded — try again in a minute');
    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared > LOG_MAX_BYTES) return _err(413, 'Log too large (max 5 MB)');
    const body = await request.text();
    if (!body.trim()) return _err(400, 'Empty log');
    if (new TextEncoder().encode(body).length > LOG_MAX_BYTES) return _err(413, 'Log too large (max 5 MB)');
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const id = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    try {
        await env.FG_LOGS.put(`log:${id}`, body, { expirationTtl: LOG_TTL_SECONDS });
    } catch (e) {
        // KV refuses writes when the account's storage or daily write quota is used up. Say so with
        // CORS headers; an uncaught throw reaches the browser as an opaque network error.
        return _err(507, 'Log storage is full or over its daily limit — download the chat instead (⬇) and try again tomorrow');
    }
    return new Response(JSON.stringify({ id }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
}

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || '';

        if (new URL(request.url).pathname === '/log') return _storeLog(request, env);

        // ── CORS preflight ────────────────────────────────────────────────────
        if (request.method === 'OPTIONS') {
            if (!_originOk(origin)) return _err(403, 'Origin not allowed');
            return new Response(null, { status: 204, headers: CORS });
        }

        // ── Origin check ──────────────────────────────────────────────────────
        if (!origin || !_originOk(origin)) {
            return _err(403, 'Origin not allowed');
        }

        const workerUrl = new URL(request.url);

        // ── GET /keys — which provider secrets are configured ─────────────────
        if (request.method === 'GET' && workerUrl.pathname === '/keys') {
            const available = {};
            for (const envKey of Object.values(PROVIDER_KEY_MAP)) {
                available[envKey] = !!(env && env[envKey]);
            }
            for (const { envKey } of Object.values(SEARCH_HEADER_MAP)) {
                available[envKey] = !!(env && env[envKey]);
            }
            return new Response(JSON.stringify(available), {
                headers: { ...CORS, 'Content-Type': 'application/json' },
            });
        }

        try {
            let upstream;

            if (request.method === 'GET') {
                // ── Search / fetch_url proxy ──────────────────────────────────
                const target = workerUrl.searchParams.get('url');
                if (!target) return _err(400, 'Missing url parameter');
                if (await _rateLimited(request, env, 'get')) return _err(429, 'Rate limit exceeded — try again in a minute');
                // Allow any public HTTPS URL; block private/reserved IPs (SSRF guard).
                if (!_publicUrlOk(target)) return _err(403, 'URL blocked (private address or non-HTTPS)');

                // Build realistic browser headers so data APIs (finance, news, etc.)
                // don't reject the request as an obvious bot.
                const fwdHeaders = {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                };

                // Optional: agent-specified extra headers via ?h=<base64-JSON>.
                // Only a safe whitelist of header names is accepted (no auth, cookie, etc.).
                const _SAFE_HDR = new Set(['accept', 'accept-language', 'cache-control',
                    'referer', 'origin', 'x-requested-with', 'content-type']);
                const hParam = workerUrl.searchParams.get('h');
                if (hParam) {
                    try {
                        const extra = JSON.parse(atob(hParam));
                        for (const [k, v] of Object.entries(extra)) {
                            if (_SAFE_HDR.has(k.toLowerCase()) && typeof v === 'string' && v.length < 512)
                                fwdHeaders[k] = v;
                        }
                    } catch { /* ignore malformed ?h= */ }
                }

                // Follow redirects here so every hop gets the same public-URL check.
                let cur = target;
                for (let hop = 0; ; hop++) {
                    upstream = await fetch(cur, { headers: fwdHeaders, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
                    const loc = upstream.headers.get('Location');
                    if (![301, 302, 303, 307, 308].includes(upstream.status) || !loc) break;
                    if (hop >= 5) return _err(502, 'Too many redirects');
                    cur = new URL(loc, cur).toString();
                    if (!_publicUrlOk(cur)) return _err(403, 'Redirect to a private address or non-HTTPS URL blocked');
                }

            } else if (request.method === 'POST') {
                // ── LLM API proxy ─────────────────────────────────────────────
                let body;
                try { body = await request.json(); }
                catch { return _err(400, 'Invalid JSON body'); }

                const { url: target, method = 'POST', headers = {}, body: reqBody } = body;
                if (!target) return _err(400, 'Missing url field in body');
                if (!_hostOk(target)) return _err(403, 'Host not in allowlist');
                // Shared keys must never travel in clear text or to a URL that carries credentials.
                if (!_httpsNoCreds(target)) return _err(403, 'Only https:// URLs without embedded credentials are allowed');

                // Inject shared key when client sends no / empty Authorization.
                // Shared keys are usable by anyone who can reach this Worker — the Origin check
                // stops browsers on other sites, but any other client can send any Origin. The
                // per-IP rate limit (FG_RATE_LIMITER in wrangler.toml) is what bounds their use.
                const auth = headers['Authorization'] || headers['authorization'] || '';
                const isEmpty = !auth || auth === 'Bearer' || auth === 'Bearer ' || auth === 'Bearer public';
                const { hostname } = new URL(target);
                const envKey = isEmpty && env ? PROVIDER_KEY_MAP[hostname] : null;
                const search = env ? SEARCH_HEADER_MAP[hostname] : null;
                const searchMissing = search && !(headers[search.header] || headers[search.header.toLowerCase()]);
                const injecting = (envKey && env[envKey]) || (searchMissing && env[search.envKey]);
                if (injecting && await _rateLimited(request, env, 'key'))
                    return _err(429, 'Shared-key rate limit exceeded — add your own API key in Settings, or try again in a minute');
                if (envKey && env[envKey]) headers['Authorization'] = `Bearer ${env[envKey]}`;
                // Search providers that use non-standard auth headers.
                if (searchMissing && env[search.envKey]) headers[search.header] = env[search.envKey];

                upstream = await fetch(target, {
                    method,
                    headers,
                    body: typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody),
                    // A redirect could carry the injected key to another host (or to http://):
                    // hand the 3xx back to the client instead of following it.
                    redirect: injecting ? 'manual' : 'follow',
                });

            } else {
                return _err(405, 'Method not allowed');
            }

            // Forward upstream response, adding CORS headers.
            // Pass body as a stream so SSE / chunked LLM responses are not buffered.
            const respHeaders = new Headers(upstream.headers);
            for (const [k, v] of Object.entries(CORS)) respHeaders.set(k, v);
            return new Response(upstream.body, { status: upstream.status, headers: respHeaders });

        } catch (err) {
            return _err(502, String(err));
        }
    },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function _originOk(origin) {
    if (!origin) return false;
    try {
        const { origin: o } = new URL(origin);
        return ALLOWED_ORIGINS.has(o);
    } catch { return false; }
}

function _httpsNoCreds(target) {
    try {
        const u = new URL(target);
        return u.protocol === 'https:' && !u.username && !u.password;
    } catch { return false; }
}

function _hostOk(target) {
    try {
        const { hostname } = new URL(target);
        if (ALLOWED_HOSTS.has(hostname)) return true;
        return [...ALLOWED_HOSTS].some(h => hostname === h || hostname.endsWith('.' + h));
    } catch { return false; }
}

// Per-client-IP limit via the Workers Rate Limiting binding. Without the binding (e.g. a fork
// deployed with an older wrangler.toml) nothing is limited.
async function _rateLimited(request, env, kind) {
    const limiter = env && env.FG_RATE_LIMITER;
    if (!limiter) return false;
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    try {
        const { success } = await limiter.limit({ key: `${kind}:${ip}` });
        return !success;
    } catch { return false; }
}

// For GET fetch_url requests: allow any public HTTPS URL.
// Block private/reserved ranges to prevent SSRF attacks. (Workers can't reach private networks
// anyway; this keeps the check honest.) Applied again to every redirect hop.
function _publicUrlOk(target) {
    try {
        const u = new URL(target);
        if (u.protocol !== 'https:') return false;
        let h = u.hostname.toLowerCase().replace(/\.$/, '');
        if (h === 'localhost' || h.endsWith('.localhost')) return false;
        // IPv6 literal: loopback, unspecified, unique-local, link-local, IPv4-mapped
        if (h.startsWith('[')) {
            h = h.slice(1, -1);
            if (h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:')) return false;
            return true;
        }
        const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
        if (!m) return true;
        const [a, b] = [Number(m[1]), Number(m[2])];
        if (a === 0 || a === 10 || a === 127) return false;                 // this-network, private, loopback
        if (a === 169 && b === 254) return false;                            // link-local / cloud metadata
        if (a === 172 && b >= 16 && b <= 31) return false;                   // private
        if (a === 192 && b === 168) return false;                            // private
        if (a === 100 && b >= 64 && b <= 127) return false;                  // carrier-grade NAT
        if (a >= 224) return false;                                          // multicast / reserved
        return true;
    } catch { return false; }
}

// X-FG-Proxy-Error marks errors generated here, so clients can tell them from upstream responses.
function _err(status, message) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json', 'X-FG-Proxy-Error': '1' },
    });
}
