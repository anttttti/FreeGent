import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';

const src = (f: string) => readFileSync(`${process.cwd()}/${f}`, 'utf8');

describe('F4 modal accessibility', () => {
    it('init.ts installs one dialog enhancer covering role, labels, focus trap and Escape', () => {
        const s = src('init.ts');
        expect(s).toContain('initModalA11y();');
        for (const k of ["role', 'dialog'", "aria-modal", "e.key === 'Escape'", "e.key === 'Tab'", 'aria-label']) expect(s).toContain(k);
    });
    it('the workspace file picker is a dialog layer too (role, name, focus returns to its opener)', () => {
        const s = src('init.ts');
        expect(s).toMatch(/_MODAL_SEL = '[^']*\.ws-pick-overlay/);
        expect(s).toContain("'.fg-modal, .ws-pick-box'");
        expect(s).toContain("'.fg-modal-title, .ws-pick-title'");
        expect(s).not.toContain("closest?.('.fg-modal-overlay')");
    });
});

describe('F6 privacy', () => {
    beforeAll(async () => { await import('../config.ts'); });
    it('the IP lookup is on by default, off when the user opts out or the privacy level is restricted', async () => {
        const W = window as any;
        localStorage.clear();
        localStorage.setItem('fg_geo_cache', JSON.stringify({ ip: '1.2.3.4', city: 'X', ts: Date.now() }));
        expect(W.geoLookupEnabled()).toBe(true);
        expect(W.getGeoCache()).not.toBeNull();
        localStorage.setItem('fg_geo_lookup', '0');
        expect(W.geoLookupEnabled()).toBe(false);
        expect(W.getGeoCache()).toBeNull();
        localStorage.setItem('fg_geo_lookup', '1');
        expect(W.geoLookupEnabled()).toBe(true);
        for (const level of ['provider', 'local']) {
            localStorage.setItem('fg_privacy_level', level);
            expect(W.geoLookupEnabled(), level).toBe(false);
        }
        localStorage.clear();
    });
    it('the default utility model stays on the main provider below the Default privacy level', () => {
        const W = window as any;
        localStorage.clear();
        localStorage.setItem('fg_groq_key', 'k');
        localStorage.setItem('fg_main_models', JSON.stringify(['groq|openai/gpt-oss-120b']));
        expect(W.getUtilityModel()).toBe('google|gemma-4-26b-a4b-it');
        localStorage.setItem('fg_privacy_level', 'provider');
        expect(W.getUtilityModel()).toBe('groq|openai/gpt-oss-120b');
        localStorage.setItem('fg_utility_model', 'groq|openai/gpt-oss-20b');
        expect(W.getUtilityModel()).toBe('groq|openai/gpt-oss-20b');
        localStorage.clear();
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
