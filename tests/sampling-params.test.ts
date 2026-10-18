// Sampling fields: never saved = FreeGent's default; saved empty = left out of the request (codex campaign 7, case 029).
const W = globalThis as any;
beforeAll(async () => { await import('../config.ts'); });
beforeEach(() => localStorage.clear());

describe('sampling parameters', () => {
    it('are FreeGent\'s defaults until the user changes them', () => {
        expect(W.getSamplingParams()).toEqual({ temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0, repetition_penalty: 1 });
    });
    it('a cleared field is left out of the request, not replaced by the default', () => {
        localStorage.setItem('fg_temperature', '');   // what saveSamplingSetting stores for an emptied field
        localStorage.setItem('fg_top_k', '');
        localStorage.setItem('fg_top_p', '0.7');
        const p = W.getSamplingParams();
        expect(p).not.toHaveProperty('temperature');
        expect(p).not.toHaveProperty('top_k');
        expect(p.top_p).toBe(0.7);
        expect(p.min_p).toBe(0);   // untouched fields keep their defaults
    });
    it('a profile captures temperature along with the other sampling choices', async () => {
        const src = (await import('node:fs')).readFileSync('profiles.ts', 'utf8');
        for (const k of ['fg_temperature', 'fg_top_p', 'fg_top_k', 'fg_min_p', 'fg_presence_penalty', 'fg_repetition_penalty'])
            expect(src.split("const PROFILE_KEYS")[1].split('];')[0]).toContain(`'${k}'`);
    });
    it('the Settings field keeps an emptied value as empty instead of removing the key', async () => {
        const src = (await import('node:fs')).readFileSync('settings-ui.ts', 'utf8');
        const body = src.split('function saveSamplingSetting')[1].split('\n}')[0];
        expect(body).not.toContain('removeItem');
    });
});
