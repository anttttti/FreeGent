/**
 * cf-worker/worker.js — FreeGent CORS proxy for GitHub Pages deployments.
 *
 * Deploy once to your own Cloudflare account (free tier is enough):
 *
 *   cd cf-worker
 *   npx wrangler deploy
 *
 * Then paste the resulting URL (e.g. https://fg-proxy.you.workers.dev)
 * into FreeGent Settings → CORS Proxy / CF Worker URL.
 *
 * Optional: add shared API keys as Cloudflare secrets so GitHub Pages
 * users can access those providers without configuring their own keys:
 *
 *   npx wrangler secret put OPENROUTER_API_KEY
 *   npx wrangler secret put GROQ_API_KEY
 *   npx wrangler secret put CEREBRAS_API_KEY
 *   npx wrangler secret put GEMINI_API_KEY
 *   npx wrangler secret put NOUS_API_KEY
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
 * The Worker is a pure passthrough. No data is logged, stored, or inspected.
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
    'https://anttttti.github.io',   // GitHub Pages deployment
    'http://localhost:5173',         // Vite dev server
    'http://localhost:4173',         // Vite preview
    'http://localhost:3000',
]);

// ── Allowed upstream hostnames (POST / LLM proxy only) ───────────────────────
// GET fetch_url requests use _publicUrlOk() instead — any public HTTPS URL.
const ALLOWED_HOSTS = new Set([
    'generativelanguage.googleapis.com',
    'api.mistral.ai',
    'api.groq.com',
    'api.cerebras.ai',
    'openrouter.ai',
    'api.openrouter.ai',
    'nous.hermes.ai',
    'inference-api.nousresearch.com',
    'opencode.ai',
    'api.kilo.ai',
    'integrate.api.nvidia.com',
    'tokenharbor.ai',
    'api.tokenharbor.ai',
    'api.vercel.ai',
    'api.openai.com',
    'api.search.brave.com',
    'api.tavily.com',
]);

// ── Provider → env var name ───────────────────────────────────────────────────
// Used to inject shared keys when the client sends no Authorization header.
// Must match _CF_PROVIDER_ENV in config.ts.
const PROVIDER_KEY_MAP = {
    'generativelanguage.googleapis.com': 'GEMINI_API_KEY',
    'api.groq.com':                      'GROQ_API_KEY',
    'api.cerebras.ai':                   'CEREBRAS_API_KEY',
    'openrouter.ai':                     'OPENROUTER_API_KEY',
    'api.openrouter.ai':                 'OPENROUTER_API_KEY',
    'inference-api.nousresearch.com':    'NOUS_API_KEY',
    'opencode.ai':                       'OPENCODE_API_KEY',
    'tokenharbor.ai':                    'TOKENHARBOR_API_KEY',
    'api.tokenharbor.ai':                'TOKENHARBOR_API_KEY',
};

const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, HTTP-Referer, X-Title, Accept',
    'Access-Control-Max-Age':       '86400',
};

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || '';

        // ── CORS preflight ────────────────────────────────────────────────────
        if (request.method === 'OPTIONS') {
            if (!_originOk(origin)) return _err(403, 'Origin not allowed');
            return new Response(null, { status: 204, headers: CORS });
        }

        // ── Origin check ──────────────────────────────────────────────────────
        if (origin && !_originOk(origin)) {
            return _err(403, 'Origin not allowed');
        }

        const workerUrl = new URL(request.url);

        // ── GET /keys — which provider secrets are configured ─────────────────
        if (request.method === 'GET' && workerUrl.pathname === '/keys') {
            const available = {};
            for (const envKey of Object.values(PROVIDER_KEY_MAP)) {
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
                // Allow any public HTTPS URL; block private/reserved IPs (SSRF guard).
                if (!_publicUrlOk(target)) return _err(403, 'URL blocked (private address or non-HTTPS)');

                upstream = await fetch(target, {
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                    signal: AbortSignal.timeout(10_000),
                });

            } else if (request.method === 'POST') {
                // ── LLM API proxy ─────────────────────────────────────────────
                let body;
                try { body = await request.json(); }
                catch { return _err(400, 'Invalid JSON body'); }

                const { url: target, method = 'POST', headers = {}, body: reqBody } = body;
                if (!target) return _err(400, 'Missing url field in body');
                if (!_hostOk(target)) return _err(403, 'Host not in allowlist');

                // Inject shared key when client sends no / empty Authorization.
                const auth = headers['Authorization'] || headers['authorization'] || '';
                const isEmpty = !auth || auth === 'Bearer' || auth === 'Bearer ' || auth === 'Bearer public';
                if (isEmpty && env) {
                    const { hostname } = new URL(target);
                    const envKey = PROVIDER_KEY_MAP[hostname];
                    if (envKey && env[envKey]) {
                        headers['Authorization'] = `Bearer ${env[envKey]}`;
                    }
                }

                upstream = await fetch(target, {
                    method,
                    headers,
                    body: typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody),
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

function _hostOk(target) {
    try {
        const { hostname } = new URL(target);
        if (ALLOWED_HOSTS.has(hostname)) return true;
        return [...ALLOWED_HOSTS].some(h => hostname === h || hostname.endsWith('.' + h));
    } catch { return false; }
}

// For GET fetch_url requests: allow any public HTTPS URL.
// Block private/reserved ranges to prevent SSRF attacks.
function _publicUrlOk(target) {
    try {
        const u = new URL(target);
        if (u.protocol !== 'https:') return false;
        const h = u.hostname;
        // Block localhost and loopback
        if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return false;
        // Block link-local / metadata endpoints
        if (h === '169.254.169.254' || h.startsWith('169.254.')) return false;
        // Block private IPv4 ranges (10.x, 172.16-31.x, 192.168.x)
        if (/^10\./.test(h)) return false;
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
        if (/^192\.168\./.test(h)) return false;
        // Block IPv6 private/loopback
        if (/^\[?(::1|fc|fd|fe80)/i.test(h)) return false;
        return true;
    } catch { return false; }
}

function _err(status, message) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
    });
}
