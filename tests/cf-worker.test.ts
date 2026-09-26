// tests/cf-worker.test.ts — the CF Worker proxy (cf-worker/worker.js): origin check, shared-key
// rate limit, and the public-URL check on the open fetch path.
import worker from '../cf-worker/worker.js';

const ORIGIN = 'https://anttttti.github.io';
const limiter = (success: boolean) => ({ limit: vi.fn().mockResolvedValue({ success }) });

function post(body: any, origin: string | null = ORIGIN) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' };
    if (origin) headers.Origin = origin;
    return new Request('https://fg-proxy.example.workers.dev/', { method: 'POST', headers, body: JSON.stringify(body) });
}
const get = (target: string) => new Request(`https://fg-proxy.example.workers.dev/?url=${encodeURIComponent(target)}`,
    { headers: { Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.9' } });

const LLM = { url: 'https://openrouter.ai/api/v1/chat/completions', headers: {}, body: '{}' };

describe('CF Worker', () => {
    let upstream: any;
    beforeEach(() => {
        upstream = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', upstream);
    });

    it('rejects requests without an Origin header', async () => {
        const r = await worker.fetch(post(LLM, null), { OPENROUTER_API_KEY: 'shared' });
        expect(r.status).toBe(403);
        expect(upstream).not.toHaveBeenCalled();
    });

    it('injects the shared key while under the rate limit', async () => {
        const env = { OPENROUTER_API_KEY: 'shared', FG_RATE_LIMITER: limiter(true) };
        const r = await worker.fetch(post(LLM), env);
        expect(r.status).toBe(200);
        expect(upstream.mock.calls[0][1].headers.Authorization).toBe('Bearer shared');
        expect(env.FG_RATE_LIMITER.limit).toHaveBeenCalledWith({ key: 'key:203.0.113.9' });
    });

    it('refuses shared-key use over the rate limit', async () => {
        const r = await worker.fetch(post(LLM), { OPENROUTER_API_KEY: 'shared', FG_RATE_LIMITER: limiter(false) });
        expect(r.status).toBe(429);
        expect(r.headers.get('X-FG-Proxy-Error')).toBe('1');
        expect(upstream).not.toHaveBeenCalled();
    });

    it('never rate-limits a request that brings its own key', async () => {
        const env = { OPENROUTER_API_KEY: 'shared', FG_RATE_LIMITER: limiter(false) };
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
        const r = await worker.fetch(get('https://example.com/r'), {});
        expect(r.status).toBe(403);
        expect(upstream).toHaveBeenCalledTimes(1);
    });

    it('blocks private and reserved targets on the fetch path', async () => {
        for (const t of ['https://169.254.169.254/latest/meta-data/', 'https://127.0.0.2/', 'https://0.0.0.0/',
                         'https://100.64.1.1/', 'https://[::1]/', 'https://[fd00::1]/', 'https://[::ffff:127.0.0.1]/',
                         'https://localhost./', 'http://example.com/']) {
            const r = await worker.fetch(get(t), {});
            expect(r.status, t).toBe(403);
        }
        expect(upstream).not.toHaveBeenCalled();
        expect((await worker.fetch(get('https://example.com/'), {})).status).toBe(200);
    });
});
