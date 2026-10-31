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
    // codex R255: the inputs' min/max were hints; any number was saved and sent.
    it('a value outside its range is not saved by Settings, and a stored one is left out of the request', async () => {
        expect(W.samplingRangeError('fg_temperature', '3')).toMatch(/between 0 and 2/);
        expect(W.samplingRangeError('fg_top_k', '-1')).toBeNull();
        expect(W.samplingRangeError('fg_top_k', '2.5')).toMatch(/whole number/);
        expect(W.samplingRangeError('fg_top_p', '')).toBeNull();
        W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        await import('../settings-ui.ts');
        const el = document.createElement('input');
        W.saveSamplingSetting('fg_temperature', '3', el);
        expect(localStorage.getItem('fg_temperature')).toBeNull();
        expect(el.validationMessage).toMatch(/Not saved: must be between 0 and 2/);
        W.saveSamplingSetting('fg_temperature', '0.4', el);
        expect(localStorage.getItem('fg_temperature')).toBe('0.4');
        localStorage.setItem('fg_top_p', '2');   // from a profile or an import
        expect(W.getSamplingParams()).not.toHaveProperty('top_p');
    });
});
