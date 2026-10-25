import { describe, it, expect, afterEach } from 'vitest';
import { withEndpointSlot } from '../model-router.ts';

const A = { provider: 'google', model: 'a' }, B = { provider: 'google', model: 'b' };
afterEach(() => { delete (globalThis as any).getSingleRequestPerEndpoint; });

function tracker() {
    let now = 0, peak = 0;
    return { peak: () => peak, run: async () => { peak = Math.max(peak, ++now); await new Promise(r => setTimeout(r, 5)); now--; } };
}

describe('one request per endpoint', () => {
    it('serialises requests to one endpoint but not to different ones', async () => {
        const same = tracker();
        await Promise.all([1, 2, 3].map(() => withEndpointSlot(A, null, same.run)));
        expect(same.peak()).toBe(1);
        const diff = tracker();
        await Promise.all([withEndpointSlot(A, null, diff.run), withEndpointSlot(B, null, diff.run)]);
        expect(diff.peak()).toBe(2);
    });
    it('releases the slot when a request throws, and when a waiter is aborted', async () => {
        await expect(withEndpointSlot(A, null, async () => { throw new Error('x'); })).rejects.toThrow('x');
        const holder = withEndpointSlot(A, null, () => new Promise(r => setTimeout(r, 10)));
        const ac = new AbortController();
        const waiter = withEndpointSlot(A, ac.signal, async () => 'ran');
        ac.abort();
        await expect(waiter).rejects.toBeDefined();
        await holder;
        expect(await withEndpointSlot(A, null, async () => 'next')).toBe('next');
    });
    it('does not gate when the setting is off', async () => {
        (globalThis as any).getSingleRequestPerEndpoint = () => false;
        const t = tracker();
        await Promise.all([1, 2].map(() => withEndpointSlot(A, null, t.run)));
        expect(t.peak()).toBe(2);
    });
});
