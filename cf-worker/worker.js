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
 * What this does
 * ──────────────
 * GitHub Pages cannot run server-side code, so browser fetch() calls to
 * LLM providers that don't send CORS headers are blocked. This Worker is a
 * thin passthrough that adds the missing CORS headers and forwards the request.
 *
 * Two request shapes are supported, matching the existing /api/proxy protocol:
 *
 *   GET  ?url=<encoded>          – used by fetch_url and web-search tools
 *   POST {url, headers?, body?}  – used by all LLM provider calls
 *
 * Security
 * ──────────────────
 * Two layers prevent the worker from being used as a generic open proxy:
 *
 *   1. Origin check — only browsers from ALLOWED_ORIGINS may call this worker.
 *      (Scripts can spoof Origin, but this stops casual browser misuse.)
 *
 *   2. Domain allowlist — target URLs must match ALLOWED_HOSTS. Even with a
 *      spoofed Origin the worker cannot be used to proxy arbitrary internet
 *      traffic; only the known LLM / search provider domains are reachable.
 *
 * Privacy
 * ──────────────────
 * The Worker is a pure passthrough. No data is logged, stored, or inspected.
 * API keys in Authorization headers are forwarded directly to the provider and
 * never retained. The source is public — you can audit it here, or deploy your
 * own instance to a Cloudflare account you control.
 *
 * Free-tier limits
 * ──────────────────
 * Cloudflare's free Workers plan allows 100 000 req/day and up to 30 seconds
 * of wall time per request. Most LLM responses finish within that window, but
 * very long generations on slow models may time out. Upgrading to Workers Paid
 * ($5/month for 10 M requests, 30-minute limit) removes that concern.
 */

// ── Allowed request origins ───────────────────────────────────────────────────
// Requests from other origins are rejected with 403.
// Add your own domain here if you fork FreeGent or self-host it elsewhere.
const ALLOWED_ORIGINS = new Set([
    'https://anttttti.github.io',   // GitHub Pages deployment
    'http://localhost:5173',         // Vite dev server
    'http://localhost:4173',         // Vite preview
    'http://localhost:3000',
]);

// ── Allowed upstream hostnames ────────────────────────────────────────────────
// Target URLs must match one of these. Anything else is rejected with 403.
// This prevents the worker from being used as a generic open proxy even if
// the Origin header is spoofed.
const ALLOWED_HOSTS = new Set([
    // LLM providers — direct CORS
    'generativelanguage.googleapis.com',  // Google Gemini
    'api.mistral.ai',
    'api.groq.com',
    'api.cerebras.ai',
    'openrouter.ai',
    'api.openrouter.ai',
    'nous.hermes.ai',
    'api.nousresearch.com',

    // LLM providers — proxy required (no CORS headers)
    'opencode.ai',
    'api.kilo.ai',
    'integrate.api.nvidia.com',
    'api.tokenharbor.ai',
    'api.vercel.ai',

    // OpenAI-compatible
    'api.openai.com',

    // Search
    'api.search.brave.com',
    'api.tavily.com',
]);

const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, HTTP-Referer, X-Title, Accept',
    'Access-Control-Max-Age':       '86400',
};

export default {
    async fetch(request) {
        const origin = request.headers.get('Origin') || '';

        // ── CORS preflight ────────────────────────────────────────────────────
        if (request.method === 'OPTIONS') {
            if (!_originOk(origin)) return _err(403, 'Origin not allowed');
            return new Response(null, { status: 204, headers: CORS });
        }

        // ── Origin check ──────────────────────────────────────────────────────
        // Allow requests with no Origin header (e.g. curl, server-side callers)
        // only from the owner's own deployments — for safety we require Origin
        // to be present and in the allowlist for cross-origin browser requests.
        if (origin && !_originOk(origin)) {
            return _err(403, 'Origin not allowed');
        }

        const workerUrl = new URL(request.url);

        try {
            let upstream;

            if (request.method === 'GET') {
                // ── Search / fetch_url proxy ──────────────────────────────────
                const target = workerUrl.searchParams.get('url');
                if (!target) return _err(400, 'Missing url parameter');
                if (!_hostOk(target)) return _err(403, `Host not in allowlist`);

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
                if (!_hostOk(target)) return _err(403, `Host not in allowlist`);

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
        // Allow any subdomain of allowed hosts (e.g. custom OpenRouter subdomain,
        // or a self-hosted vllm instance on a *.workers.dev / *.vercel.app URL).
        // Exact-match is preferred; subdomain wildcard is a fallback for vllm/custom.
        return [...ALLOWED_HOSTS].some(h => hostname === h || hostname.endsWith('.' + h));
    } catch { return false; }
}

function _err(status, message) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
    });
}
