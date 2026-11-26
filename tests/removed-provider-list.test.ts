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
});
