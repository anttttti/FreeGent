// agentSend's key guard (agent-core.ts): a priority list headed by a keyless Kilo model must not
// send the user to Settings. The guard used to check the provider alone ('kilo|'), which misses
// per-model noKey, so every send from a device with no keys opened Settings instead.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';

const W = window as any;
beforeAll(async () => {
    W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    await import('../settings-ui.ts');
    await import('../agent-core.ts');
    // Globals agentSend calls before the guard that live in modules not loaded here.
    W._resetModelWarmup ??= () => {};
    W.clearSuggestion ??= () => {};
    W.getPendingAttachments ??= () => ({ images: [], files: [] });
});
afterEach(() => { localStorage.removeItem('fg_main_models'); localStorage.removeItem('fg_kilo_key'); });

async function sendOpensSettings(): Promise<boolean> {
    const orig = W.showSettings;
    let opened = false;
    W.showSettings = () => { opened = true; };
    try { await W.agentSend(); } finally { W.showSettings = orig; }  // no #agent-input → returns after the guard
    return opened;
}

describe('send key guard', () => {
    it('does not open Settings for a keyless Kilo model', async () => {
        localStorage.setItem('fg_main_models', JSON.stringify(['kilo|dots-studio/dots-3-note-preview:free']));
        expect(await sendOpensSettings()).toBe(false);
    });
    it('opens Settings when no listed model has a key', async () => {
        localStorage.setItem('fg_main_models', JSON.stringify(['nvidia|nvidia/nemotron-3-ultra-550b-a55b']));
        expect(await sendOpensSettings()).toBe(true);
    });
});
