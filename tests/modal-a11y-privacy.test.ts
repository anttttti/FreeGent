import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';

const src = (f: string) => readFileSync(`${process.cwd()}/${f}`, 'utf8');

describe('F4 modal accessibility', () => {
    it('init.ts installs one dialog enhancer covering role, labels, focus trap and Escape', () => {
        const s = src('init.ts');
        expect(s).toContain('initModalA11y();');
        for (const k of ["role', 'dialog'", "aria-modal", "e.key === 'Escape'", "e.key === 'Tab'", 'aria-label']) expect(s).toContain(k);
    });
});

describe('F6 privacy', () => {
    beforeAll(async () => { await import('../config.ts'); });
    it('the IP lookup is off unless the user opts in', async () => {
        const W = window as any;
        localStorage.clear();
        localStorage.setItem('fg_geo_cache', JSON.stringify({ ip: '1.2.3.4', city: 'X', ts: Date.now() }));
        expect(W.geoLookupEnabled()).toBe(false);
        expect(W.getGeoCache()).toBeNull();
        localStorage.setItem('fg_geo_lookup', '1');
        expect(W.geoLookupEnabled()).toBe(true);
    });
    it('analytics honour Do Not Track and the opt-out', () => {
        const h = src('index.html');
        expect(h).toContain("navigator.doNotTrack === '1'");
        expect(h).toContain("fg_analytics");
        expect(h).not.toMatch(/<script[^>]*src="\/\/gc\.zgo\.at/);
    });
});

describe('F7 own-endpoint cooldown', () => {
    it('a custom endpoint 429 with no prior success is not penalised for an hour', async () => {
        const m: any = await import('../model-router.ts');
        const ep = { provider: 'custom', model: 'f7-test' };
        m._markCooldown(ep);
        const until = m._endpointCooldown.get('custom|f7-test');
        expect(until - Date.now()).toBeLessThanOrEqual(m.RATE_LIMIT_MAX_MS + 1000);
        const hosted = { provider: 'groq', model: 'f7-test' };
        m._markCooldown(hosted);
        expect(m._endpointCooldown.get('groq|f7-test') - Date.now()).toBeGreaterThan(m.RATE_LIMIT_MAX_MS);
    });
});
