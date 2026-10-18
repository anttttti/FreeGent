import { describe, it, expect } from 'vitest';
import { isTransient, _httpErrorFromResponse } from '../retry.js';
import { _isRateLimit, _isServerError } from '../model-router.js';

describe('retry classifier contract', () => {
    const rateLimited = ['HTTP 429: slow down', 'HTTP 402: payment required', 'HTTP 503 unavailable', 'Rate limit reached',
        'rate-limit exceeded', 'Too many requests', 'quota exceeded for project', 'insufficient balance', 'high demand right now',
        'spikes in demand'];
    for (const m of rateLimited) it(`"${m}" is a rate limit and transient`, () => {
        expect(_isRateLimit(m)).toBe(true);
        expect(isTransient(new Error(m))).toBe(true);
    });
    it('server-side rotation triggers are wider than transience for plain 4xx, by design', () => {
        expect(_isServerError('HTTP 401: bad key')).toBe(true);
        expect(isTransient(new Error('HTTP 401: bad key'))).toBe(false);
    });
});

describe('_httpErrorFromResponse (shared by chat and compaction)', () => {
    it('keeps status, Retry-After and the provider message, with an optional prefix', async () => {
        const r = new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429, headers: { 'retry-after': '3' } });
        const e: any = await _httpErrorFromResponse(r, 'Compaction');
        expect(e.message).toBe('Compaction HTTP 429: slow down');
        expect(e.status).toBe(429);
        expect(e.retryAfterMs).toBe(3000);
    });
});

describe('isProviderSide400', () => {
    it('separates a provider-side 400 (cool down) from a request or account 400 (pause)', async () => {
        const { isProviderSide400 } = await import('../retry');
        expect(isProviderSide400('[vercel|stealth/cat-jam] HTTP 400: The stealth model could not complete the request.')).toBe(true);
        expect(isProviderSide400('HTTP 400: Free tier users do not have access to this model')).toBe(false);
        expect(isProviderSide400('HTTP 503: try again later')).toBe(false);
    });
});

describe('named waits and plan refusals', () => {
    it('reads a wait from the error text', async () => {
        const { parseRetryHintMs } = await import('../model-router');
        expect(parseRetryHintMs('HTTP 429: ... was reached. Retry after 40s.')).toBe(40_000);
        expect(parseRetryHintMs('Please retry in about 30 seconds.')).toBe(30_000);
        expect(parseRetryHintMs('try again in 2 minutes')).toBe(120_000);
        expect(parseRetryHintMs('{"reason":"rate_limited","retry_after":452}')).toBe(452_000);
        expect(parseRetryHintMs('HTTP 429: Too Many Requests')).toBeNull();
        expect(parseRetryHintMs('Retry after 3 days')).toBeNull();
    });
    it('a short named wait overrides the first-failure one-hour penalty', async () => {
        const m = await import('../model-router');
        const ep = { provider: 'vercel', model: 'x/never-succeeded' };
        m._markCooldown(ep, null, new Error('HTTP 429: limit of 5 requests per minute. Retry after 40s.'));
        expect(m.getCooldownRemaining('vercel|x/never-succeeded')).toBe(120);
        const ep2 = { provider: 'vercel', model: 'x/never-succeeded-2' };
        m._markCooldown(ep2, null, new Error('HTTP 429: Too Many Requests'));
        expect(m.getCooldownRemaining('vercel|x/never-succeeded-2')).toBe(3600);
    });
    it('recognises plan refusals and provider-side 400s from real logs', async () => {
        const r = await import('../retry');
        expect(r.ACCOUNT_PLAN_REFUSAL_RE.test('HTTP 403: Free tier users do not have access to this model')).toBe(true);
        expect(r.ACCOUNT_PLAN_REFUSAL_RE.test('HTTP 403: requires an active Pro plan with purchased AI Gateway credits')).toBe(true);
        expect(r.ACCOUNT_PLAN_REFUSAL_RE.test('HTTP 403: This request was refused.')).toBe(false);
        expect(r.isProviderSide400('[kilo|stealth/glyph-cluster] HTTP 400: The upstream provider was unable to process the request')).toBe(true);
    });
});
