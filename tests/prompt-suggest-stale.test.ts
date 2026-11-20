// An obsolete suggestion request's 401/410 must not pause the model: the user may have replaced the credential since (explorations Y013).
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

const W: any = window;
let mod: any;
beforeAll(async () => { mod = await import('../prompt-suggest.ts'); });
afterEach(() => { for (const k of ['callLLMComplete', 'utilityEndpoint', 'getActiveMainModelList', 'specToEndpoint', 'getCooldownRemaining', 'savePausedMainModels', 'getPausedMainModels', 'lastExchange']) delete W[k]; vi.restoreAllMocks(); });

function setup(error: Error) {
    let fail!: () => void;
    const paused: string[][] = [];
    W.lastExchange = () => ({ userMsg: 'make it blue', response: 'Done, it is blue now.' });
    W.utilityEndpoint = () => null;
    W.getActiveMainModelList = () => ['groq|m1'];
    W.specToEndpoint = () => ({ provider: 'groq', model: 'm1' });
    W.getCooldownRemaining = () => 0;
    W.getPausedMainModels = () => [];
    W.savePausedMainModels = (l: string[]) => paused.push(l);
    W.callLLMComplete = () => new Promise((_, reject) => { fail = () => reject(error); });
    return { paused, fail: () => fail() };
}
const tick = () => new Promise(r => setTimeout(r, 10));

describe('suggestion errors', () => {
    it('pause the model when current, not when the request was made obsolete meanwhile', async () => {
        const stale = setup(new Error('HTTP 401: invalid key'));
        const p = mod.generateAndShowSuggestion();
        await tick();
        mod.clearSuggestion();   // the user went on: this generation is obsolete
        stale.fail(); await p;
        expect(stale.paused).toEqual([]);
        const current = setup(new Error('HTTP 401: invalid key'));
        const q = mod.generateAndShowSuggestion();
        await tick(); current.fail(); await q;
        expect(current.paused).toEqual([['groq|m1']]);
    });
});
