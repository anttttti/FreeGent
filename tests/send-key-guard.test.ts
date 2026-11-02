// agentSend's key guard (agent-core.ts): a priority list headed by a Kilo model with a Kilo key must not
// send the user to Settings. The guard used to check the provider alone ('kilo|'), which misses
// per-model entries, so every send opened Settings instead. Kilo models need a key since 2026-10.
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
afterEach(() => { localStorage.removeItem('fg_main_models'); localStorage.removeItem('fg_kilo_key'); localStorage.removeItem('fg_custom_models'); });

async function sendOpensSettings(): Promise<boolean> {
    const orig = W.showSettings;
    let opened = false;
    W.showSettings = () => { opened = true; };
    try { await W.agentSend(); } finally { W.showSettings = orig; }  // no #agent-input → returns after the guard
    return opened;
}

describe('send key guard', () => {
    it('does not open Settings for a Kilo model with a Kilo key', async () => {
        localStorage.setItem('fg_main_models', JSON.stringify(['kilo|dots-studio/dots-3-note-preview:free']));
        localStorage.setItem('fg_kilo_key', 'sk-test');
        expect(await sendOpensSettings()).toBe(false);
    });
    it('opens Settings when no listed model has a key', async () => {
        localStorage.setItem('fg_main_models', JSON.stringify(['nvidia|nvidia/nemotron-3-ultra-550b-a55b']));
        expect(await sendOpensSettings()).toBe(true);
    });
    it('treats a Kilo model without a Kilo key as keyless, even a saved custom entry marked noKey', () => {
        localStorage.setItem('fg_custom_models', JSON.stringify([{ provider: 'kilo', model: 'acme/old-free:free', label: 'Old', noKey: true, media: ['text'] }]));
        expect(W.specHasKey('kilo|dots-studio/dots-3-note-preview:free')).toBe(false);
        expect(W.specHasKey('kilo|acme/old-free:free')).toBe(false);
        localStorage.setItem('fg_kilo_key', 'sk-test');
        expect(W.specHasKey('kilo|acme/old-free:free')).toBe(true);
    });
    it("counts the guest quota's keys whenever the Worker offers it, but not while it is paused for the day", async () => {
        localStorage.setItem('fg_privacy_level', 'routed');
        localStorage.setItem('fg_search_proxy', 'https://worker.example.dev');
        const orig = W.fetch;
        W.fetch = async () => new Response(JSON.stringify({ guestQuota: true, guestMode: true, KILO_API_KEY: true }), { status: 200 });
        const kilo = 'kilo|dots-studio/dots-3-note-preview:free';
        try {
            await W.loadCfWorkerKeys();
            expect(W.specHasKey(kilo)).toBe(true);           // offered at Routed: usable at once, no extra step
            localStorage.setItem('fg_kilo_key', 'sk-mine');     // the visitor's own key counts, guest quota or not
            localStorage.setItem('fg_guest_paused_until', String(Date.now() + 3600_000));
            await W.loadCfWorkerKeys();
            expect(W.specHasKey(kilo)).toBe(true);
            localStorage.removeItem('fg_kilo_key');
            expect(W.specHasKey(kilo)).toBe(false);           // paused: today's guest quota is used up on this network
            expect(W.guestModeOn()).toBe(true);
        } finally {
            W.fetch = orig;
            for (const k of ['fg_privacy_level', 'fg_search_proxy', 'fg_guest_paused_until']) localStorage.removeItem(k);
            await W.loadCfWorkerKeys();
        }
    });
    it("counts the Worker's Kilo key once the Developer key unlocks it", async () => {
        localStorage.setItem('fg_dev_key', 'dev-test');
        localStorage.setItem('fg_privacy_level', 'routed');
        localStorage.setItem('fg_search_proxy', 'https://worker.example.dev');   // a Worker on another host, as on the deployed site
        const orig = W.fetch;
        W.fetch = async () => new Response(JSON.stringify({ KILO_API_KEY: true }), { status: 200 });
        try {
            expect(W.specHasKey('kilo|dots-studio/dots-3-note-preview:free')).toBe(false);
            await W.loadCfWorkerKeys();
            expect(W.specHasKey('kilo|dots-studio/dots-3-note-preview:free')).toBe(true);
        } finally {
            W.fetch = orig;
            localStorage.removeItem('fg_dev_key'); localStorage.removeItem('fg_privacy_level'); localStorage.removeItem('fg_search_proxy');
            await W.loadCfWorkerKeys();   // no Worker at the default level: clears the cached Worker keys
        }
    });
    it('showSettings opens the Models tab, not Profiles', () => {
        document.body.insertAdjacentHTML('beforeend', '<button class="settings-tab-btn" data-tab="profiles"></button><button class="settings-tab-btn" data-tab="model"></button>');
        const orig = W.activateTab; W.activateTab = () => {};
        try { W.showSettings(); } finally { W.activateTab = orig; }
        expect(document.querySelector('.settings-tab-btn.active')?.getAttribute('data-tab')).toBe('model');
    });
});
