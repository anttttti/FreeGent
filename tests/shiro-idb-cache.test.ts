// The cache helpers promise best effort: a transaction that aborts or cannot start is a miss, not a rejected load (explorations Y005).
import { describe, it, expect } from 'vitest';
import { idbCache } from '../shiro/utils/idb-cache';

describe('idbCache is best effort', () => {
    it('a write whose transaction aborts, or cannot start, resolves instead of rejecting', async () => {
        let closed = 0;
        const aborting: any = { close: () => closed++, transaction: () => {
            const tx: any = { objectStore: () => ({ put: () => ({}) }) };
            setTimeout(() => tx.onabort?.(), 0);
            return tx;
        } };
        await expect(idbCache(async () => aborting).put('s', 'k', 1)).resolves.toBeUndefined();
        expect(closed).toBe(1);
        const broken: any = { close() {}, transaction: () => { throw new Error('InvalidStateError'); } };
        const c = idbCache(async () => broken);
        await expect(c.put('s', 'k', 1)).resolves.toBeUndefined();
        await expect(c.get('s', 'k')).resolves.toBeNull();
        await expect(c.keys('s')).resolves.toEqual([]);
    });
});
