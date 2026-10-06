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
