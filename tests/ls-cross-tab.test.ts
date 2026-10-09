import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const W = window as any;
beforeAll(async () => { await import('../config.ts'); });
beforeEach(() => localStorage.clear());

describe('priority list across tabs', () => {
    it('re-reads fg_main_models after another tab changed it', () => {
        const a = 'kilo|dots-studio/dots-3-note-preview:free';
        const b = 'kilo|nvidia/nemotron-3-ultra-550b-a55b:free';
        W.saveMainModelList([a, b]);
        expect(W.getMainModelList()).toEqual([a, b]);
        // Another tab writes straight to storage; this tab's wrappers never see it.
        (localStorage as any)['fg_main_models'] = JSON.stringify([b, a]);   // named setter: skips the setItem wrapper
        expect(W.getMainModelList()).toEqual([a, b]);   // stale cache, as in the bug
        window.dispatchEvent(new StorageEvent('storage', { key: 'fg_main_models', storageArea: localStorage }));
        expect(W.getMainModelList()).toEqual([b, a]);
    });
});
