/**
 * cf-worker/worker.js — FreeGent CORS proxy for GitHub Pages deployments.
 *
 * Deploy once to your own Cloudflare account (free tier is enough):
 *
 *   cd cf-worker
 *   npx wrangler deploy
 *
 * Then paste the resulting URL (e.g. https://fg-proxy.you.workers.dev)
 * into FreeGent Settings → Search / CORS Proxy.
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
 * Privacy / security
 * ──────────────────
 * This Worker is a pure passthrough. No data is logged, stored, or inspected.
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

const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, HTTP-Referer, X-Title, Accept',
    'Access-Control-Max-Age':       '86400',
};

export default {
    async fetch(request) {
        // ── CORS preflight ────────────────────────────────────────────────────
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS });
        }

        const url = new URL(request.url);

        try {
            let upstream;

            if (request.method === 'GET') {
                // ── Search / fetch_url proxy ──────────────────────────────────
                const target = url.searchParams.get('url');
                if (!target) return _err(400, 'Missing url parameter');

                upstream = await fetch(target, {
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                });

            } else if (request.method === 'POST') {
                // ── LLM API proxy ─────────────────────────────────────────────
                let body;
                try { body = await request.json(); }
                catch { return _err(400, 'Invalid JSON body'); }

                const { url: target, method = 'POST', headers = {}, body: reqBody } = body;
                if (!target) return _err(400, 'Missing url field in body');

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

function _err(status, message) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
    });
}
