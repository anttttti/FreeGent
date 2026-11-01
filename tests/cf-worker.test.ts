// tests/cf-worker.test.ts — the CF Worker proxy (cf-worker/worker.js): origin check, shared-key
// rate limit, and the public-URL check on the open fetch path.
import worker from '../cf-worker/worker.js';

const ORIGIN = 'https://freegent.ai';
const limiter = (success: boolean) => ({ limit: vi.fn().mockResolvedValue({ success }) });

function post(body: any, origin: string | null = ORIGIN) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9', 'X-FG-Dev-Key': 'pw' };
    if (origin) headers.Origin = origin;
    return new Request('https://fg-proxy.example.workers.dev/', { method: 'POST', headers, body: JSON.stringify(body) });
}
const get = (target: string) => new Request(`https://fg-proxy.example.workers.dev/?url=${encodeURIComponent(target)}`,
    { headers: { Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.9' } });

// The fetch-path tests below are about the relay itself; its Turnstile gate has its own tests.
const OPEN = { FG_OPEN_RELAY: '1' };

const LLM = { url: 'https://openrouter.ai/api/v1/chat/completions', headers: {}, body: '{}' };

describe('CF Worker', () => {
    let upstream: any;
    beforeEach(() => {
        upstream = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', upstream);
    });

    it('exposes upstream retry and quota headers to the WebUI', async () => {
        upstream.mockResolvedValue(new Response('{"error":{"message":"Rate limit exceeded"}}', { status: 429,
            headers: { 'retry-after': '25', 'x-ratelimit-reset': '1793491225' } }));
        const r = await worker.fetch(post({ ...LLM, url: 'https://router.requesty.ai/v1/chat/completions' }),
            { REQUESTY_API_KEY: 'synthetic-requesty-key', FG_DEV_KEY: 'pw', FG_RATE_LIMITER: limiter(true) });
        expect(r.status).toBe(429);
        expect(r.headers.get('retry-after')).toBe('25');
        const exposed = r.headers.get('Access-Control-Expose-Headers')!.toLowerCase().split(/,\s*/);
        expect(exposed).toContain('retry-after');
        expect(exposed).toContain('x-ratelimit-reset');
    });

    it('routes MoonMath with its shared credential and rejects lookalike hosts', async () => {
        const env = { MOONMATH_API_KEY: 'synthetic-moonmath-key', FG_DEV_KEY: 'pw', FG_RATE_LIMITER: limiter(true) };
        const url = 'https://zro.moonmath.ai/v1/chat/completions';
        expect((await worker.fetch(post({ ...LLM, url }), env)).status).toBe(200);
        expect(upstream.mock.calls[0][1].headers.Authorization).toBe('Bearer synthetic-moonmath-key');
        upstream.mockClear();
        expect((await worker.fetch(post({ ...LLM, url: 'https://evil.zro.moonmath.ai/v1/chat/completions' }), env)).status).toBe(403);
        expect(upstream).not.toHaveBeenCalled();
    });

    it('routes Requesty with its shared credential and rejects lookalike hosts', async () => {
        const env = { REQUESTY_API_KEY: 'synthetic-requesty-key', FG_DEV_KEY: 'pw', FG_RATE_LIMITER: limiter(true) };
        expect((await worker.fetch(post({ ...LLM, url: 'https://router.requesty.ai/v1/chat/completions' }), env)).status).toBe(200);
        expect(upstream.mock.calls[0][1].headers.Authorization).toBe('Bearer synthetic-requesty-key');
        upstream.mockClear();
        expect((await worker.fetch(post({ ...LLM, url: 'https://router.requesty.ai.evil.com/v1/chat/completions' }), env)).status).toBe(403);
        expect(upstream).not.toHaveBeenCalled();
    });

    it('hermes C7: only the listed hosts, not their subdomains, are proxied (the shared key is injected before the request leaves)', async () => {
        const env = { OPENROUTER_API_KEY: 'shared', OPENAI_API_KEY: 'shared2', FG_DEV_KEY: 'pw', FG_RATE_LIMITER: limiter(true) };
        for (const url of ['https://evil.openrouter.ai/api/v1/x', 'https://x.api.openai.com/v1/x', 'https://a.ai-gateway.vercel.sh/v1/x', 'https://openrouter.ai.evil.com/x']) {
            const r = await worker.fetch(post({ ...LLM, url }), env);
            expect(r.status, url).toBe(403);
        }
        expect(upstream).not.toHaveBeenCalled();
        expect((await worker.fetch(post(LLM), env)).status).toBe(200);          // the listed host still works
        expect((await worker.fetch(post({ ...LLM, url: 'https://openrouter.ai./api/v1/x' }), env)).status).toBe(200);   // a trailing dot is the same host
    });

    it('rejects requests without an Origin header', async () => {
        const r = await worker.fetch(post(LLM, null), { OPENROUTER_API_KEY: 'shared', FG_DEV_KEY: 'pw' });
        expect(r.status).toBe(403);
        expect(upstream).not.toHaveBeenCalled();
    });

    it('injects the shared key while under the rate limit', async () => {
        const env = { OPENROUTER_API_KEY: 'shared', FG_DEV_KEY: 'pw', FG_RATE_LIMITER: limiter(true) };
        const r = await worker.fetch(post(LLM), env);
        expect(r.status).toBe(200);
        expect(upstream.mock.calls[0][1].headers.Authorization).toBe('Bearer shared');
        expect(env.FG_RATE_LIMITER.limit).toHaveBeenCalledWith({ key: 'key:203.0.113.9' });
    });

    it('uses no shared key without the matching passphrase', async () => {
        const env = { OPENROUTER_API_KEY: 'shared', FG_DEV_KEY: 'other', FG_RATE_LIMITER: limiter(true) };
        await worker.fetch(post(LLM), env);
        expect(upstream.mock.calls[0][1].headers.Authorization).toBeUndefined();
    });

    it('never forwards a shared key over http:// or to a URL with credentials', async () => {
        const env = { GROQ_API_KEY: 'shared', FG_DEV_KEY: 'pw', FG_RATE_LIMITER: limiter(true) };
        for (const url of ['http://api.groq.com/openai/v1/chat/completions', 'https://u:p@api.groq.com/openai/v1/chat/completions']) {
            const r = await worker.fetch(post({ url, headers: {}, body: '{}' }), env);
            expect(r.status).toBe(403);
        }
        expect(upstream).not.toHaveBeenCalled();
    });

    it('proxies only GET and POST to a provider, whatever method the client names', async () => {
        const env = { OPENROUTER_API_KEY: 'shared', FG_DEV_KEY: 'pw', FG_RATE_LIMITER: limiter(true) };
        for (const method of ['DELETE', 'PUT', 'PATCH']) {
            const r = await worker.fetch(post({ ...LLM, method }), env);
            expect(r.status).toBe(405);
        }
        expect(upstream).not.toHaveBeenCalled();
        const ok = await worker.fetch(post({ url: 'https://openrouter.ai/api/v1/models', method: 'get', headers: {} }), env);
        expect(ok.status).toBe(200);
        expect(upstream.mock.calls[0][1].method).toBe('GET');
    });

    it('does not follow redirects for a request that carries the shared key', async () => {
        await worker.fetch(post({ url: 'https://api.groq.com/openai/v1/chat/completions', headers: {}, body: '{}' }),
            { GROQ_API_KEY: 'shared', FG_DEV_KEY: 'pw', FG_RATE_LIMITER: limiter(true) });
        expect(upstream.mock.calls[0][1].redirect).toBe('manual');
    });

    it('refuses shared-key use over the rate limit', async () => {
        // Only the shared-key budget is spent; the key-guess budget still has room.
        const lim = { limit: vi.fn(async ({ key }: any) => ({ success: !key.startsWith('key:') })) };
        const r = await worker.fetch(post(LLM), { OPENROUTER_API_KEY: 'shared', FG_DEV_KEY: 'pw', FG_RATE_LIMITER: lim });
        expect(r.status).toBe(429);
        expect(r.headers.get('X-FG-Proxy-Error')).toBe('1');
        expect(upstream).not.toHaveBeenCalled();
    });

    it('with the key-guess budget spent, even the right key gets no shared key', async () => {
        const r = await worker.fetch(post(LLM), { OPENROUTER_API_KEY: 'shared', FG_DEV_KEY: 'pw', FG_RATE_LIMITER: limiter(false) });
        expect(r.status).toBe(200);
        expect(upstream.mock.calls[0][1].headers.Authorization).toBeUndefined();
    });

    it('never rate-limits a request that brings its own key', async () => {
        const env = { OPENROUTER_API_KEY: 'shared', FG_DEV_KEY: 'pw', FG_RATE_LIMITER: limiter(false) };
        const r = await worker.fetch(post({ ...LLM, headers: { Authorization: 'Bearer user-own' } }), env);
        expect(r.status).toBe(200);
        expect(upstream.mock.calls[0][1].headers.Authorization).toBe('Bearer user-own');
    });

    it('rate-limits the open fetch path', async () => {
        const r = await worker.fetch(get('https://example.com/'), { FG_RATE_LIMITER: limiter(false) });
        expect(r.status).toBe(429);
    });

    it('re-checks redirects on the fetch path', async () => {
        upstream.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://169.254.169.254/latest/' } }));
        const r = await worker.fetch(get('https://example.com/r'), OPEN);
        expect(r.status).toBe(403);
        expect(upstream).toHaveBeenCalledTimes(1);
    });

    it('replays cookies set during a redirect chain to the same host only', async () => {
        const redirect = (loc: string, cookie?: string) => {
            const h = new Headers({ Location: loc });
            if (cookie) h.append('Set-Cookie', cookie);
            return new Response(null, { status: 302, headers: h });
        };
        upstream.mockResolvedValueOnce(redirect('https://example.com/auth', 'signin=1; Path=/; Secure'))
                .mockResolvedValueOnce(redirect('https://other.example.org/x'))
                .mockResolvedValueOnce(new Response('ok', { status: 200 }));
        const r = await worker.fetch(get('https://example.com/page'), OPEN);
        expect(r.status).toBe(200);
        expect(upstream.mock.calls[0][1].headers.Cookie).toBeUndefined();
        expect(upstream.mock.calls[1][1].headers.Cookie).toBe('signin=1');
        expect(upstream.mock.calls[2][1].headers.Cookie).toBeUndefined();
        expect(r.headers.get('Set-Cookie')).toBeNull();
    });

    it('retries an https -> http redirect over https', async () => {
        upstream.mockResolvedValueOnce(new Response(null, { status: 301, headers: { Location: 'http://example.com/events/' } }));
        const r = await worker.fetch(get('https://www.example.com/events/'), OPEN);
        expect(r.status).toBe(200);
        expect(upstream.mock.calls[1][0]).toBe('https://example.com/events/');
    });

    it('refuses a response over 48 MB by its Content-Length, and cuts off one that streams past it', async () => {
        upstream.mockResolvedValueOnce(new Response('x', { status: 200, headers: { 'Content-Length': String(49 * 1024 * 1024) } }));
        const r = await worker.fetch(get('https://example.com/big'), OPEN);
        expect(r.status).toBe(413);
        expect(r.headers.get('X-FG-Proxy-Error')).toBe('1');
        const chunk = new Uint8Array(16 * 1024 * 1024);
        let sent = 0;
        upstream.mockResolvedValueOnce(new Response(new ReadableStream({
            pull(c) { if (sent++ < 4) c.enqueue(chunk); else c.close(); },
        }), { status: 200 }));
        const s = await worker.fetch(get('https://example.com/stream'), OPEN);
        expect(s.status).toBe(200);
        await expect(s.arrayBuffer()).rejects.toThrow(/48 MB/);
        upstream.mockResolvedValueOnce(new Response(new Uint8Array(1024), { status: 200 }));
        expect((await (await worker.fetch(get('https://example.com/small'), OPEN)).arrayBuffer()).byteLength).toBe(1024);
    });

    it('blocks private and reserved targets on the fetch path', async () => {
        for (const t of ['https://169.254.169.254/latest/meta-data/', 'https://127.0.0.2/', 'https://0.0.0.0/',
                         'https://100.64.1.1/', 'https://[::1]/', 'https://[fd00::1]/', 'https://[::ffff:127.0.0.1]/',
                         'https://localhost./', 'http://example.com/']) {
            const r = await worker.fetch(get(t), OPEN);
            expect(r.status, t).toBe(403);
        }
        expect(upstream).not.toHaveBeenCalled();
        expect((await worker.fetch(get('https://example.com/'), OPEN)).status).toBe(200);
    });
});

describe('CF Worker POST /log', () => {
    const logReq = (body: string | Uint8Array, origin = 'http://192.168.1.20:5000') => new Request('https://proxy.example/log', {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain', 'CF-Connecting-IP': '203.0.113.9' }, body });
    const kv = () => ({ put: vi.fn().mockResolvedValue(undefined) });

    it('stores a log for 14 days and returns an id, from any origin', async () => {
        const FG_LOGS = kv();
        const r = await worker.fetch(logReq('{"a":1}'), { FG_LOGS });
        expect(r.status).toBe(200);
        const { id } = await r.json() as any;
        expect(id).toMatch(/^[0-9a-f]{16}$/);
        expect(FG_LOGS.put).toHaveBeenCalledTimes(1);
        const [key, value, opts] = FG_LOGS.put.mock.calls[0];
        expect(key).toBe(`log:${id}`);
        expect(new TextDecoder().decode(value)).toBe('{"a":1}');
        expect(opts).toEqual({ expirationTtl: 14 * 24 * 3600 });
    });
    it('answers 503 without the KV binding, 413 over 25 MB (the Workers KV value limit), 429 when rate limited', async () => {
        expect((await worker.fetch(logReq('x'), {})).status).toBe(503);
        const FG_LOGS = kv();
        // 25 MiB is the Workers KV value limit. The declared size is checked first; a real 25 MiB body runs the vitest
        // worker out of memory under jsdom (checked by hand in plain node: 25 MiB stored, 25 MiB + 1 byte -> 413).
        const over = new Request('https://proxy.example/log', { method: 'POST', headers: { Origin: 'http://192.168.1.20:5000', 'CF-Connecting-IP': '203.0.113.9', 'Content-Length': String(25 * 1024 * 1024 + 1) }, body: 'x' });
        expect((await worker.fetch(over, { FG_LOGS })).status).toBe(413);
        expect((await worker.fetch(logReq('x'), { FG_LOGS, FG_RATE_LIMITER: limiter(false) })).status).toBe(429);
        expect(FG_LOGS.put).not.toHaveBeenCalled();
    });
    it('answers 507 with CORS headers when KV refuses the write (quota exhausted)', async () => {
        const FG_LOGS = { put: vi.fn().mockRejectedValue(new Error('KV PUT failed: 429 Too Many Requests')) };
        const r = await worker.fetch(logReq('{"a":1}'), { FG_LOGS });
        expect(r.status).toBe(507);
        expect(r.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(((await r.json()) as any).error).toMatch(/full|limit/);
    });
    it('cannot read logs back', async () => {
        const r = await worker.fetch(new Request('https://proxy.example/log', { method: 'GET', headers: { Origin: ORIGIN } }), { FG_LOGS: kv() });
        expect(r.status).toBe(405);
    });
});

describe('CF Worker /errlog and legacy names', () => {
    const errReq = (body: string, key: string | null = 'pw') => new Request('https://proxy.example/errlog', {
        method: 'POST', body, headers: { Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.9', ...(key ? { 'X-FG-Dev-Key': key } : {}) } });
    const kv = () => ({ put: vi.fn().mockResolvedValue(undefined) });

    it('stores a batch under the session id with the Developer key', async () => {
        const FG_LOGS = kv();
        const r = await worker.fetch(errReq('{"sessionId":"abc123","entries":[]}'), { FG_LOGS, FG_DEV_KEY: 'pw' });
        expect(r.status).toBe(200);
        expect(FG_LOGS.put.mock.calls[0][0]).toMatch(/^err:abc123:\d+:[0-9a-f]{8}$/);
    });
    it('refuses without or with a wrong key', async () => {
        const FG_LOGS = kv();
        expect((await worker.fetch(errReq('{"sessionId":"a"}', null), { FG_LOGS, FG_DEV_KEY: 'pw' })).status).toBe(401);
        expect((await worker.fetch(errReq('{"sessionId":"a"}', 'no'), { FG_LOGS, FG_DEV_KEY: 'pw' })).status).toBe(401);
        expect(FG_LOGS.put).not.toHaveBeenCalled();
    });
    it('still honours the old FG_PASS secret and X-FG-Pass header', async () => {
        const FG_LOGS = kv();
        const req = new Request('https://proxy.example/errlog', { method: 'POST', body: '{"sessionId":"a"}',
            headers: { Origin: ORIGIN, 'X-FG-Pass': 'old' } });
        expect((await worker.fetch(req, { FG_LOGS, FG_PASS: 'old' })).status).toBe(200);
    });
});

describe('CF Worker key guessing', () => {
    it('spends the per-IP budget on every key-bearing request, and a spent budget refuses even the right key', async () => {
        const kvPut = vi.fn().mockResolvedValue(undefined);
        const lim = { limit: vi.fn().mockResolvedValue({ success: true }) };
        const mk = (key: string) => new Request('https://proxy.example/errlog', { method: 'POST', body: '{"sessionId":"a"}',
            headers: { Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.9', 'X-FG-Dev-Key': key } });
        const env = { FG_LOGS: { put: kvPut }, FG_DEV_KEY: 'pw', FG_RATE_LIMITER: lim };
        expect((await worker.fetch(mk('wrong'), env)).status).toBe(401);
        expect(lim.limit).toHaveBeenCalledWith({ key: 'devkey:203.0.113.9' });
        lim.limit.mockResolvedValue({ success: false });
        expect((await worker.fetch(mk('pw'), env)).status).toBe(429);
        expect(kvPut).not.toHaveBeenCalled();
    });
});

describe('CF Worker relay sessions (Turnstile)', () => {
    const TS = { TURNSTILE_SITE_KEY: '0xSITE', TURNSTILE_SECRET: 'secret', FG_SESSION_KEY: 'k'.repeat(32) };
    const getFrom = (ip: string, session?: string, extra: Record<string, string> = {}) =>
        new Request(`https://fg-proxy.example.workers.dev/?url=${encodeURIComponent('https://example.com/')}`,
            { headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip, ...(session ? { 'X-FG-Session': session } : {}), ...extra } });
    const sessionReq = (ip: string, token = 'tok') => new Request('https://fg-proxy.example.workers.dev/session',
        { method: 'POST', headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    let upstream: any;
    beforeEach(() => {
        upstream = vi.fn(async (url: string) => String(url).includes('siteverify')
            ? new Response(JSON.stringify({ success: true }), { status: 200 })
            : new Response('page', { status: 200 }));
        vi.stubGlobal('fetch', upstream);
    });
    afterEach(() => vi.unstubAllGlobals());
    const session = async (ip: string) => (await (await worker.fetch(sessionReq(ip), TS)).json()).session as string;

    it('refuses the fetch path with 503 when Turnstile is not set up and the relay is not opened explicitly', async () => {
        const r = await worker.fetch(getFrom('203.0.113.9'), {});
        expect(r.status).toBe(503);
        expect((await r.json()).error).toMatch(/TURNSTILE_SECRET.*FG_OPEN_RELAY/);
        expect(upstream).not.toHaveBeenCalled();
    });

    it('asks for a session with the public site key, never fetching the target first', async () => {
        const r = await worker.fetch(getFrom('203.0.113.9'), TS);
        expect(r.status).toBe(401);
        expect(r.headers.get('X-FG-Session-Required')).toBe('1');
        expect(r.headers.get('Access-Control-Expose-Headers')).toMatch(/X-FG-Session-Required/);
        expect((await r.json()).turnstileSiteKey).toBe('0xSITE');
        expect(upstream).not.toHaveBeenCalled();
    });

    it('trades a passed Turnstile token for a session that opens the fetch path from the same network', async () => {
        const s = await session('203.0.113.9');
        const verify = upstream.mock.calls[0];
        expect(verify[0]).toMatch(/challenges\.cloudflare\.com\/turnstile\/v0\/siteverify/);
        expect(verify[1].body.get('secret')).toBe('secret');
        expect(verify[1].body.get('response')).toBe('tok');
        expect(verify[1].body.get('remoteip')).toBe('203.0.113.9');
        expect((await worker.fetch(getFrom('203.0.113.9', s), TS)).status).toBe(200);
    });

    it('a session is refused from another network, but survives an IPv6 address change within the /64', async () => {
        const s4 = await session('203.0.113.9');
        expect((await worker.fetch(getFrom('198.51.100.7', s4), TS)).status).toBe(401);
        const s6 = await session('2001:db8:aa:bb:1111:2222:3333:4444');
        expect((await worker.fetch(getFrom('2001:db8:aa:bb::9', s6), TS)).status).toBe(200);
        expect((await worker.fetch(getFrom('2001:db8:aa:cc::9', s6), TS)).status).toBe(401);
    });

    it('refuses a tampered, expired, or differently keyed session', async () => {
        const s = await session('203.0.113.9');
        const [exp, mac] = s.split('.');
        expect((await worker.fetch(getFrom('203.0.113.9', `${Number(exp) + 1}.${mac}`), TS)).status).toBe(401);
        expect((await worker.fetch(getFrom('203.0.113.9', `${exp}.${mac.replace(/.$/, c => c === '0' ? '1' : '0')}`), TS)).status).toBe(401);
        expect((await worker.fetch(getFrom('203.0.113.9', s), { ...TS, FG_SESSION_KEY: 'other' })).status).toBe(401);
        vi.useFakeTimers({ now: Date.now() + 5 * 3600 * 1000 });
        try { expect((await worker.fetch(getFrom('203.0.113.9', s), TS)).status).toBe(401); }
        finally { vi.useRealTimers(); }
    });

    it('gives no session when Turnstile says the check failed, or without a token', async () => {
        upstream.mockImplementation(async () => new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] })));
        expect((await worker.fetch(sessionReq('203.0.113.9'), TS)).status).toBe(403);
        expect((await worker.fetch(sessionReq('203.0.113.9', ''), TS)).status).toBe(400);
        expect((await worker.fetch(sessionReq('203.0.113.9'), {})).status).toBe(503);
    });

    it('the Developer key and FG_OPEN_RELAY skip the check', async () => {
        const env = { ...TS, FG_DEV_KEY: 'pw', FG_RATE_LIMITER: limiter(true) };
        expect((await worker.fetch(getFrom('203.0.113.9', undefined, { 'X-FG-Dev-Key': 'pw' }), env)).status).toBe(200);
        expect((await worker.fetch(getFrom('203.0.113.9', undefined, { 'X-FG-Dev-Key': 'wrong' }), env)).status).toBe(401);
        expect((await worker.fetch(getFrom('203.0.113.9'), { ...TS, FG_OPEN_RELAY: '1' })).status).toBe(200);
    });
});
