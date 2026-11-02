// Sampling fields: never saved or saved empty = left out of the request, so the provider's or server's own default applies
// (FreeGent sets none of its own); a saved value is sent (codex campaign 7, case 029).
const W = globalThis as any;
beforeAll(async () => { await import('../config.ts'); });
beforeEach(() => localStorage.clear());

describe('sampling parameters', () => {
    it('are empty until the user sets them, so nothing is sent', () => {
        expect(W.getSamplingParams()).toEqual({});
        expect(W.getTemperature()).toBeNull();
    });
    it('a cleared field is left out of the request, and only set fields are sent', () => {
        localStorage.setItem('fg_temperature', '');   // what saveSamplingSetting stores for an emptied field
        localStorage.setItem('fg_top_k', '');
        localStorage.setItem('fg_top_p', '0.7');
        const p = W.getSamplingParams();
        expect(p).not.toHaveProperty('temperature');
        expect(p).not.toHaveProperty('top_k');
        expect(p.top_p).toBe(0.7);
        expect(p).toEqual({ top_p: 0.7 });   // untouched fields are not sent either
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
