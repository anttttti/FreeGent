// A saved model priority list drops models the providers withdrew: those the catalog no longer has, and those on FREE_MODEL_BLACKLIST.
const W: any = globalThis;

describe('getMainModelList prunes withdrawn models', () => {
    beforeEach(() => localStorage.clear());
    it('drops blacklisted and unknown specs from a saved list and saves the clean one', () => {
        const keep = 'nvidia|z-ai/glm-5.3-flash';
        localStorage.setItem('fg_main_models', JSON.stringify(['kilo|minimax/minimax-m3.1-flash:free', 'vercel|stealth/glyph-cluster', 'nous|no/such-model', keep]));
        expect(W.getMainModelList()).toEqual([keep]);
        expect(JSON.parse(localStorage.getItem('fg_main_models')!)).toEqual([keep]);
    });
    it('the default list holds no withdrawn model', () => {
        localStorage.clear();
        for (const spec of W.getMainModelList()) {
            expect(W.isBlacklistedModel(spec), spec).toBe(false);
            expect(W.getAllModels().some((m: any) => `${m.provider}|${m.model}` === spec), spec).toBe(true);
        }
    });
});
