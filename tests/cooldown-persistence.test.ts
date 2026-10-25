// A rate limited or out-of-quota model stays on cooldown across a page reload instead of being tried (and refused) again.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const KEY = 'fg_endpoint_cooldowns';
const load = async () => { vi.resetModules(); return await import('../model-router.ts'); };

describe('endpoint cooldowns survive a reload', () => {
    beforeEach(() => { localStorage.clear(); });

    it('a cooldown set before a reload is still there after it', async () => {
        const a = await load();
        a._endpointCooldown.set('kilo|x:free', Date.now() + 3_600_000);
        await new Promise(r => setTimeout(r, 120));
        expect(JSON.parse(localStorage.getItem(KEY)!)['kilo|x:free']).toBeGreaterThan(Date.now());
        const b = await load();
        expect(b._isCoolingDown({ provider: 'kilo', model: 'x:free' })).toBe(true);
    });
    it('expired entries are dropped on load, and a cleared cooldown is not brought back', async () => {
        localStorage.setItem(KEY, JSON.stringify({ 'a|old': Date.now() - 1000, 'a|live': Date.now() + 60_000 }));
        const a = await load();
        expect(a._isCoolingDown({ provider: 'a', model: 'old' })).toBe(false);
        expect(a._isCoolingDown({ provider: 'a', model: 'live' })).toBe(true);
        a._endpointCooldown.delete('a|live');
        await new Promise(r => setTimeout(r, 120));
        expect(localStorage.getItem(KEY)).toBeNull();
        const b = await load();
        expect(b._isCoolingDown({ provider: 'a', model: 'live' })).toBe(false);
    });
    it('an unreadable store starts empty', async () => {
        localStorage.setItem(KEY, '{not json');
        const a = await load();
        expect(a._endpointCooldown.size).toBe(0);
    });
});
