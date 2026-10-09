import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const W = window as any;
beforeAll(async () => { await import('../config.ts'); });
beforeEach(() => localStorage.clear());

const mk = (model: string, extra: any = {}) => ({ provider: 'openrouter', model, label: model, contextK: 128, ...extra });
const saved = () => W.getCustomModels();

describe('fillMissingReleased', () => {
    it('uses a provider date remembered from the model update as a real date', () => {
        W.saveCustomModels([mk('acme/foo-1:free')]);
        W.rememberModelCreated({ 'openrouter|acme/foo-1:free': Date.UTC(2026, 4, 10) / 1000 });
        expect(W.fillMissingReleased()).toBe(true);
        expect(saved()[0].released).toBe('2026-05');
        expect(saved()[0].releasedEstimated).toBeUndefined();
    });
    it('estimates three months before a newer version of the same family', () => {
        W.saveCustomModels([mk('acme/foo-1:free'), mk('acme/foo-2:free', { released: '2026-08' })]);
        W.fillMissingReleased();
        expect(saved()[0]).toMatchObject({ released: '2026-05', releasedEstimated: true });
        expect(saved()[1].releasedEstimated).toBeUndefined();
    });
    it('falls back to the first-seen month, and keeps it on later runs', () => {
        W.saveCustomModels([mk('acme/lonely:free')]);
        W.fillMissingReleased();
        expect(saved()[0].releasedEstimated).toBe(true);
        const first = saved()[0].released;
        expect(W.fillMissingReleased()).toBe(false);
        expect(saved()[0].released).toBe(first);
    });
});
