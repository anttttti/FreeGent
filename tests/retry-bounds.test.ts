// Retry bounds: a message that matches only on weak prose is retried a few times, not forever;
// transport-tagged errors stay unbounded; the tag works on a frozen error.
import { withRetry, asTransportError, isTransient } from '../retry.ts';

beforeEach(() => { localStorage.setItem('fg_retry_mode', 'fixed'); localStorage.setItem('fg_retry_fixed_ms', '1'); });
afterEach(() => { localStorage.removeItem('fg_retry_mode'); localStorage.removeItem('fg_retry_fixed_ms'); });

describe('withRetry bounds', () => {
    it('gives up on an error that matched only weak prose, even with maxAttempts = Infinity', async () => {
        let n = 0;
        await expect(withRetry(async () => { n++; throw new Error('Resource not found'); }, null, Infinity)).rejects.toThrow('not found');
        expect(n).toBe(6);
    });

    it('keeps retrying a tagged transport error past that bound', async () => {
        let n = 0;
        const r = await withRetry(async () => {
            if (++n < 20) throw asTransportError(new TypeError('whatever the browser calls it'));
            return 'ok';
        }, null, Infinity);
        expect(r).toBe('ok');
        expect(n).toBe(20);
    });

    it('keeps retrying provider overload and HTTP 5xx, which carry stronger signals', async () => {
        let n = 0;
        const r = await withRetry(async () => { if (++n < 10) throw new Error('HTTP 503: service temporarily unavailable, try again later'); return 'ok'; }, null, Infinity);
        expect(r).toBe('ok');
    });
});

describe('asTransportError', () => {
    it('tags a frozen error without throwing', () => {
        const e = Object.freeze(new TypeError('Load failed2'));
        expect(() => asTransportError(e)).not.toThrow();
        expect(isTransient(e)).toBe(true);
    });
});
