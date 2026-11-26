// 4a71646#2: a priority list that holds only models of a removed provider (APInex) is empty by retirement, so a headless prompt does not
// fall back to the default endpoint.
import { describe, it, expect, beforeEach } from 'vitest';
import { mainModelListIsEmptyByChoice, getMainModelList } from '../config.ts';

describe('removed providers in the saved priority list', () => {
    beforeEach(() => localStorage.clear());
    it('a list of only APInex models is empty by retirement', () => {
        localStorage.setItem('fg_main_models', JSON.stringify(['apinex|free/gpt-6-luna']));
        expect(getMainModelList()).toEqual([]);
        expect(mainModelListIsEmptyByChoice()).toBe(true);
    });
    it('a Vercel Ling route that became priced is retired, so a saved selection is not used (Sol 6.2 review of 9608c36)', () => {
        expect((window as any).isBlacklistedModel('vercel|inclusionai/ling-3.1-flash-1019')).toBe(true);
        localStorage.setItem('fg_main_models', JSON.stringify(['vercel|inclusionai/ling-3.1-flash-1019']));
        expect(getMainModelList()).toEqual([]);
    });
    it('every Vercel catalog model is in the fallback probe list, so a fallback discovery never proposes its removal unprobed', async () => {
        const src = (await import('node:fs')).readFileSync('model-update.ts', 'utf8');
        const ids = [...(await import('node:fs')).readFileSync('config.ts', 'utf8').matchAll(/provider:'vercel', model:'([^']+)'/g)].map(m => m[1]);
        const list = src.slice(src.indexOf('const _VERCEL_FREE_IDS'), src.indexOf(']', src.indexOf('const _VERCEL_FREE_IDS')));
        for (const id of ids) expect(list, id).toContain(`'${id}'`);
    });
});
