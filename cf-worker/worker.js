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
 * logs are read with `wrangler kv`. POST /errlog (Developer key required) stores batches of
 * console errors/warnings under err:<sessionId>:... in the same namespace. Without the FG_LOGS binding the endpoint answers 503.
 * API keys (user's own or injected from env) are forwarded directly to the
 * provider and never retained.
 *
 * Project sync (Developer key + an R2 bucket bound as FG_SYNC; answers 503 without it): POST /sync/auth trades the key for a
 * 15-minute token; /sync/projects, /sync/<project>/manifest, /sync/<project>/b/<sha256>, /sync/<project>/gc and
 * DELETE /sync/<project> store a project's files as content-addressed R2 objects. See the "/sync" comment below.
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
    'integrate.api.nvidia.com':          'NVIDIA_API_KEY',
    'ai-gateway.vercel.sh':              'VERCEL_API_KEY',
};

// Search providers that use non-standard auth headers (not Authorization: Bearer).
// Injected after the standard PROVIDER_KEY_MAP pass.
const SEARCH_HEADER_MAP = {
    'api.search.brave.com': { envKey: 'BRAVE_API_KEY', header: 'X-Subscription-Token' },
};

const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, HTTP-Referer, X-Title, Accept, X-FG-Dev-Key, X-FG-Pass, X-FG-Sync-Token, X-FG-Sync-Base',
    'Access-Control-Max-Age':       '86400',
    'Access-Control-Expose-Headers': 'X-FG-Proxy-Error',
};

// ── POST /log: a user-sent chat log, stored for debugging ─────────────────────
// Handled before the origin check: the app also runs from LAN-IP and plain-HTTP pages (older iPads)
// whose origin cannot be allow-listed. Bounded instead by the size cap, the per-IP rate limit and
// the KV expiry; the endpoint cannot read anything back.
// 25 MiB is the largest value Workers KV stores (the request body limit of the Worker itself is 100 MB).
const LOG_MAX_BYTES = 25 * 1024 * 1024;
const LOG_TTL_SECONDS = 14 * 24 * 3600;
async function _storeLog(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return _err(405, 'POST only');
    if (!env || !env.FG_LOGS) return _err(503, 'Log upload is not configured on this Worker');
    if (await _rateLimited(request, env, 'log')) return _err(429, 'Rate limit exceeded — try again in a minute');
    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared > LOG_MAX_BYTES) return _err(413, 'Log too large (max 25 MB)');
    // Bytes, not text: a 25 MB string plus its encoded copy would come close to the Worker's 128 MB memory limit.
    const body = await request.arrayBuffer();
    if (body.byteLength > LOG_MAX_BYTES) return _err(413, 'Log too large (max 25 MB)');
    if (!new TextDecoder().decode(body.slice(0, 4096)).trim()) return _err(400, 'Empty log');
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const id = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    try {
        await env.FG_LOGS.put(`log:${id}`, body, { expirationTtl: LOG_TTL_SECONDS });
    } catch (e) {
        // KV refuses writes when the account's storage or daily write quota is used up. Say so with
        // CORS headers; an uncaught throw reaches the browser as an opaque network error.
        return _err(507, 'Log storage is full or over its daily limit — download the chat instead (↓) and try again tomorrow');
    }
    return new Response(JSON.stringify({ id }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// ── POST /errlog: console errors/warnings from a Developer-key session ────────
// Requires the Developer key (unlike /log, which any user may send). Body: {sessionId, entries[]}.
// Stored under err:<session>:<time>:<rand> for 14 days; the session id is the same one carried by
// the task chat logs (POST /log), so the two can be joined.
const ERRLOG_MAX_BYTES = 256 * 1024;
async function _storeErrLog(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return _err(405, 'POST only');
    if (!env || !env.FG_LOGS) return _err(503, 'Log upload is not configured on this Worker');
    if (await _rateLimited(request, env, 'errlog')) return _err(429, 'Rate limit exceeded — try again in a minute');
    if (!(await _unlocked(request, env))) return _err(401, 'Developer key required');
    const body = await request.text();
    if (new TextEncoder().encode(body).length > ERRLOG_MAX_BYTES) return _err(413, 'Error log batch too large (max 256 KB)');
    let sessionId = '';
    try { sessionId = String(JSON.parse(body).sessionId || ''); } catch { return _err(400, 'Body must be JSON'); }
    sessionId = sessionId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'unknown';
    const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('');
    try {
        await env.FG_LOGS.put(`err:${sessionId}:${Date.now()}:${rand}`, body, { expirationTtl: LOG_TTL_SECONDS });
    } catch (e) {
        return _err(507, 'Log storage is full or over its daily limit');
    }
    return new Response('{"ok":true}', { headers: { ...CORS, 'Content-Type': 'application/json' } });
}


// ── /sync: per-file project sync (Developer key + the FG_SYNC R2 bucket) ──────
// A project is a manifest (path → {h: SHA-256 hex, s: size, e?: 'base64', m?: mtime}) plus content-addressed blobs
// p/<project>/b/<sha256>. The client uploads only blobs the manifest does not already list, then replaces the manifest
// with a compare-and-swap on its etag, so two devices pushing at once cannot overwrite each other (the loser gets 412,
// pulls and merges, and pushes again). Every route needs a short-lived token from POST /sync/auth, which is where the
// Developer key is checked (and rate limited): a push of hundreds of files would otherwise exhaust the per-IP key budget.
// Without the FG_SYNC binding every route answers 503, so a Worker that has not enabled sync stores nothing.
const SYNC_TOKEN_TTL_MS = 15 * 60 * 1000;
const SYNC_BLOB_MAX = 95 * 1024 * 1024;
const SYNC_MANIFEST_MAX = 5 * 1024 * 1024;
const _hex = (buf) => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
async function _syncMac(env, exp) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(env.FG_DEV_KEY || env.FG_PASS)),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return _hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('fg-sync:' + exp)));
}
async function _syncTokenOk(request, env) {
    const t = request.headers.get('X-FG-Sync-Token') || '';
    const dot = t.indexOf('.');
    const exp = Number(t.slice(0, dot));
    if (dot < 1 || !(exp > Date.now()) || exp > Date.now() + SYNC_TOKEN_TTL_MS + 1000) return false;
    const want = await _syncMac(env, exp), got = t.slice(dot + 1);
    if (want.length !== got.length) return false;
    let d = 0;
    for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ got.charCodeAt(i);
    return d === 0;
}
const _json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function _sync(request, env, url) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!env || !env.FG_SYNC || !(env.FG_DEV_KEY || env.FG_PASS)) return _err(503, 'Project sync is not enabled on this Worker');
    const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent);   // after "sync"
    if (parts[0] === 'auth' && parts.length === 1) {
        if (request.method !== 'POST') return _err(405, 'POST only');
        if (!(await _unlocked(request, env))) return _err(401, 'Developer key required');
        const exp = Date.now() + SYNC_TOKEN_TTL_MS;
        return _json({ token: `${exp}.${await _syncMac(env, exp)}`, expires: exp });
    }
    if (!(await _syncTokenOk(request, env))) return _err(401, 'Sync token missing or expired');
    const bucket = env.FG_SYNC;
    try {
        if (parts[0] === 'projects' && parts.length === 1 && request.method === 'GET') {
            const l = await bucket.list({ prefix: 'p/', delimiter: '/' });
            return _json({ projects: (l.delimitedPrefixes || []).map(x => x.slice(2, -1)) });
        }
        const project = parts[0] || '';
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(project) || project === '.' || project === '..') return _err(400, 'Invalid project name');
        const root = `p/${project}/`;
        if (parts.length === 1 && request.method === 'DELETE') {
            let n = 0, cursor;
            do {
                const l = await bucket.list({ prefix: root, cursor, limit: 1000 });
                if (l.objects.length) { await bucket.delete(l.objects.map(o => o.key)); n += l.objects.length; }
                cursor = l.truncated ? l.cursor : undefined;
            } while (cursor);
            return _json({ deleted: n });
        }
        if (parts[1] === 'manifest' && parts.length === 2) {
            if (request.method === 'GET') {
                const o = await bucket.get(root + 'manifest.json');
                if (!o) return _json({ etag: null, manifest: { files: {} } });
                return _json({ etag: o.etag, manifest: JSON.parse(await o.text()) });
            }
            if (request.method === 'PUT') {
                if (Number(request.headers.get('Content-Length') || 0) > SYNC_MANIFEST_MAX) return _err(413, 'Manifest too large');
                const text = await request.text();
                if (text.length > SYNC_MANIFEST_MAX) return _err(413, 'Manifest too large');
                let m; try { m = JSON.parse(text); } catch { return _err(400, 'Manifest must be JSON'); }
                if (!m || typeof m.files !== 'object' || Array.isArray(m.files)) return _err(400, 'Manifest needs a files object');
                for (const [path, f] of Object.entries(m.files)) {
                    if (!_safeSyncPath(path)) return _err(400, 'Manifest path not allowed: ' + JSON.stringify(path).slice(0, 80));
                    if (!f || !/^[0-9a-f]{64}$/.test(f.h)) return _err(400, 'Manifest entry without a SHA-256');
                }
                const base = request.headers.get('X-FG-Sync-Base') || '';
                if (!base) return _err(400, 'X-FG-Sync-Base required (the etag you started from, or "none")');
                const o = await bucket.put(root + 'manifest.json', text, { onlyIf: base === 'none' ? { etagDoesNotMatch: '*' } : { etagMatches: base } });
                if (!o) return _err(412, 'The project changed on the server — pull, merge and push again');
                return _json({ etag: o.etag });
            }
        }
        if (parts[1] === 'b' && parts.length === 3 && /^[0-9a-f]{64}$/.test(parts[2])) {
            const key = `${root}b/${parts[2]}`;
            if (request.method === 'GET') {
                const o = await bucket.get(key);
                if (!o) return _err(404, 'No such file');
                return new Response(o.body, { headers: { ...CORS, 'Content-Type': 'application/octet-stream', 'Content-Length': String(o.size) } });
            }
            if (request.method === 'PUT') {
                const lenHeader = request.headers.get('Content-Length');
                const len = Number(lenHeader);
                if (lenHeader === null || !Number.isFinite(len)) return _err(411, 'Content-Length required');
                if (len > SYNC_BLOB_MAX) return _err(413, 'File too large for one upload (max 95 MB)');
                if (await bucket.head(key)) return _json({ stored: false, exists: true });
                try { await bucket.put(key, len === 0 ? new Uint8Array(0) : request.body, { sha256: parts[2] }); }
                catch (e) { return _err(400, 'The upload does not match its SHA-256'); }
                return _json({ stored: true });
            }
        }
        if (parts[1] === 'gc' && parts.length === 2 && request.method === 'POST') {
            const mo = await bucket.get(root + 'manifest.json');
            const keep = new Set(mo ? Object.values(JSON.parse(await mo.text()).files).map(f => `${root}b/${f.h}`) : []);
            let n = 0, cursor;
            do {
                const l = await bucket.list({ prefix: root + 'b/', cursor, limit: 1000 });
                const drop = l.objects.filter(o => !keep.has(o.key)).map(o => o.key);
                if (drop.length) { await bucket.delete(drop); n += drop.length; }
                cursor = l.truncated ? l.cursor : undefined;
            } while (cursor);
            return _json({ deleted: n });
        }
        return _err(404, 'Unknown sync route');
    } catch (e) {
        return _err(500, 'Sync storage error: ' + String(e && e.message || e));
    }
}

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || '';

        if (new URL(request.url).pathname === '/log') return _storeLog(request, env);
        if (new URL(request.url).pathname === '/errlog') return _storeErrLog(request, env);
        if (new URL(request.url).pathname.split('/')[1] === 'sync') return _sync(request, env, new URL(request.url));

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
            const unlocked = await _unlocked(request, env);
            for (const envKey of [...Object.values(PROVIDER_KEY_MAP), ...Object.values(SEARCH_HEADER_MAP).map(v => v.envKey)]) {
                available[envKey] = unlocked && !!(env && env[envKey]);
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
                // Cookies set along the chain are replayed to the same host on later hops (never to
                // the client or other hosts): sites like ai.google.dev bounce through a sign-in
                // redirect that only ends once the cookie it just set comes back.
                const jar = new Map();   // hostname -> Map(name -> value)
                let cur = target;
                for (let hop = 0; ; hop++) {
                    const host = new URL(cur).hostname;
                    const hopHeaders = { ...fwdHeaders };
                    const mine = jar.get(host);
                    if (mine && mine.size) hopHeaders['Cookie'] = [...mine].map(([k, v]) => `${k}=${v}`).join('; ');
                    upstream = await fetch(cur, { headers: hopHeaders, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
                    const loc = upstream.headers.get('Location');
                    if (![301, 302, 303, 307, 308].includes(upstream.status) || !loc) break;
                    if (hop >= 8) return _err(502, 'Too many redirects');
                    for (const sc of (upstream.headers.getSetCookie?.() ?? [])) {
                        const m = /^\s*([^=;\s]+)=([^;]*)/.exec(sc);
                        if (!m) continue;
                        const jarHost = jar.get(host) ?? jar.set(host, new Map()).get(host);
                        if (m[2] === '' || /max-age=0/i.test(sc)) jarHost.delete(m[1]); else jarHost.set(m[1], m[2]);
                    }
                    cur = new URL(loc, cur).toString();
                    // A site redirecting https -> http (e.g. www.christchurchcitylibraries.com ->
                    // http://christchurchcitylibraries.com) is retried over https instead of refused.
                    if (cur.startsWith('http://')) cur = 'https://' + cur.slice(7);
                    if (!_publicUrlOk(cur)) return _err(403, 'Redirect to a private address or non-HTTPS URL blocked');
                }

            } else if (request.method === 'POST') {
                // ── LLM API proxy ─────────────────────────────────────────────
                let body;
                try { body = await request.json(); }
                catch { return _err(400, 'Invalid JSON body'); }

                const { url: target, method: rawMethod = 'POST', headers = {}, body: reqBody } = body;
                if (!target) return _err(400, 'Missing url field in body');
                // Provider APIs are called with POST (completions) and GET (model lists). Another method with
                // the shared key injected would be a way to delete or modify the operator's provider resources.
                const method = String(rawMethod).toUpperCase();
                if (method !== 'POST' && method !== 'GET') return _err(405, 'Only GET and POST are proxied');
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
                const unlocked = await _unlocked(request, env);
                const envKey = isEmpty && unlocked ? PROVIDER_KEY_MAP[hostname] : null;
                const search = unlocked ? SEARCH_HEADER_MAP[hostname] : null;
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
        // Exactly the listed hosts. A suffix match let evil.api.openai.com through, and the operator's shared key is injected into the request
        // before it is sent (hermes C7); the dev server matches exactly too.
        return ALLOWED_HOSTS.has(hostname.toLowerCase().replace(/\.$/, ''));
    } catch { return false; }
}

async function _unlocked(request, env) {
    // FG_DEV_KEY / X-FG-Dev-Key; the pre-rename FG_PASS secret and X-FG-Pass header still work.
    const want = env && (env.FG_DEV_KEY || env.FG_PASS);
    const got = request.headers.get('X-FG-Dev-Key') || request.headers.get('X-FG-Pass');
    if (!want || !got) return false;
    // Every key-bearing request spends from a per-IP budget BEFORE the comparison, so guessing the
    // key online is capped at the rate limit (a wrong key and an over-budget right key look alike).
    if (await _rateLimited(request, env, 'devkey')) return false;
    const enc = new TextEncoder();
    const [a, b] = await Promise.all([want, got].map(v => crypto.subtle.digest('SHA-256', enc.encode(v))));
    const x = new Uint8Array(a), y = new Uint8Array(b);
    let d = 0;
    for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
    return d === 0;
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
// A path a project manifest may carry (the client applies the same rule to what it pulls): relative, no empty, "." or ".." segment,
// no backslash or control character, no drive letter. The keys reach the workspace and the folder helpers on the client.
function _safeSyncPath(p) {
  if (typeof p !== 'string' || !p || p.length > 1024) return false;
  if (/[\\\u0000-\u001f]/.test(p) || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  return p.split('/').every(seg => seg !== '' && seg !== '.' && seg !== '..');
}

function _err(status, message) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json', 'X-FG-Proxy-Error': '1' },
    });
}
