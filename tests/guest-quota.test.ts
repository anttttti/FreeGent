// tests/guest-quota.test.ts — the guest quota on the page (guest-quota.ts): the offer a keyless send gets on a hosted
// page, and the watch that keeps the Worker's /keys answer fresh when the quota is switched or used up.
const state = vi.hoisted(() => ({ guest: false, level: 'provider', chosen: false, pausedUntil: 0, loads: 0, daily: 150 }));
vi.mock('../config.js', () => ({
    guestQuotaOn: () => state.guest,
    loadCfWorkerKeys: vi.fn(async () => { state.loads++; }),
    chooseGuestQuota: () => { state.chosen = true; },
    unchooseGuestQuota: () => { state.chosen = false; },
    guestQuotaChosen: () => state.chosen,
    guestQuotaDaily: () => state.daily,
    guestQuotaPausedUntil: () => state.pausedUntil,
    pauseGuestQuota: (t: number) => { state.pausedUntil = t; },
    cfWorkerKeysLoadedAt: () => 0,
}));
vi.mock('../privacy.js', () => ({ getPrivacyLevel: () => state.level }));
import { offerGuestQuota, canOfferGuestQuota, installGuestQuotaWatch, renderGuestAccess, toggleGuestAccess } from '../guest-quota.js';

const click = (act: string) => (document.querySelector(`#fg-guest-quota-dialog [data-act="${act}"]`) as HTMLElement).click();
const statusText = () => document.querySelector('#fg-guest-quota-dialog [data-role="status"]')!.textContent;
const flush = () => new Promise(r => setTimeout(r, 0));

describe('guest quota offer', () => {
    beforeEach(() => {
        Object.assign(state, { guest: false, level: 'provider', chosen: false, pausedUntil: 0, loads: 0 });
        (window as any).onPrivacyLevelChange = vi.fn((l: string) => { state.level = l; });
        (window as any).showSettings = vi.fn();
    });
    afterEach(() => document.getElementById('fg-guest-quota-dialog')?.remove());

    it('is offered only on a hosted page and not at the Local level', () => {
        expect(canOfferGuestQuota()).toBe(false);   // the test page is localhost, which has its own server and keys
    });

    it('says whose accounts and terms apply, and that free models may train on prompts', () => {
        offerGuestQuota(vi.fn());
        const text = document.getElementById('fg-guest-quota-dialog')!.textContent!;
        expect(text).toMatch(/training: don't send anything private/);
        const links = [...document.querySelectorAll('#fg-guest-quota-dialog a')].map(a => a.getAttribute('href'));
        expect(links).toEqual(expect.arrayContaining(['https://kilo.ai/terms', 'https://openrouter.ai/terms', 'https://tokenharbor.ai/terms']));
    });

    it('uses the guest quota when the Worker has it on: chosen, Routed, dialog closed, send re-run', async () => {
        state.guest = true;
        const retry = vi.fn();
        offerGuestQuota(retry);
        click('guest'); await flush();
        expect(state.chosen).toBe(true);
        expect((window as any).onPrivacyLevelChange).toHaveBeenCalledWith('routed');
        expect(retry).toHaveBeenCalledTimes(1);
        expect(document.getElementById('fg-guest-quota-dialog')).toBeNull();
    });

    it('when the quota is off, says so, restores the privacy level and does not send', async () => {
        const retry = vi.fn();
        offerGuestQuota(retry);
        click('guest'); await flush();
        expect(retry).not.toHaveBeenCalled();
        expect(state.level).toBe('provider');
        expect(statusText()).toMatch(/guest quota is off/);
    });

    it("when this network used today's quota, says until when, without contacting the Worker", async () => {
        state.pausedUntil = Date.now() + 3600_000;
        offerGuestQuota(vi.fn());
        click('guest'); await flush();
        expect(statusText()).toMatch(/used today's guest quota.*00:00 UTC/);
        expect(state.loads).toBe(0);
        expect((window as any).onPrivacyLevelChange).not.toHaveBeenCalled();
    });

    it('"Add my own key" opens Settings and contacts no Worker', () => {
        offerGuestQuota(vi.fn());
        click('key');
        expect((window as any).showSettings).toHaveBeenCalled();
        expect((window as any).onPrivacyLevelChange).not.toHaveBeenCalled();
    });
});

describe('guest quota watch', () => {
    let reply: Response;
    beforeAll(() => {
        window.fetch = vi.fn(async () => reply) as any;
        installGuestQuotaWatch();
    });
    beforeEach(() => { Object.assign(state, { level: 'routed', pausedUntil: 0, loads: 0 }); });
    const refused = (kind: string) => new Response('{}', { status: 403, headers: { 'X-FG-Guest': kind } });

    it('looks /keys up again at once when a call is refused because the quota is off', async () => {
        reply = refused('off');
        await window.fetch('https://proxy.freegent.ai/', { method: 'POST', body: '{}' }); await flush();
        expect(state.loads).toBe(1);
        expect(state.pausedUntil).toBe(0);
    });

    it("pauses the guest models until 00:00 UTC when the day's limit is reached", async () => {
        reply = refused('limit');
        await window.fetch('https://proxy.freegent.ai/', { method: 'POST', body: '{}' }); await flush();
        const midnight = new Date(); midnight.setUTCHours(24, 0, 0, 0);
        expect(state.pausedUntil).toBe(midnight.getTime());
        expect(state.loads).toBe(1);
    });

    it('leaves other replies alone, and looks nothing up below Routed', async () => {
        reply = new Response('ok');
        await window.fetch('https://example.com/'); await flush();
        state.level = 'provider'; reply = refused('off');
        await window.fetch('https://proxy.freegent.ai/', { method: 'POST', body: '{}' }); await flush();
        expect(state.loads).toBe(0);
    });
});

describe('Guest access button (Settings → Models)', () => {
    let btn: HTMLButtonElement;
    beforeEach(() => {
        Object.assign(state, { guest: true, chosen: false, pausedUntil: 0, loads: 0 });
        document.getElementById('guest-access-btn')?.remove();
        document.body.insertAdjacentHTML('beforeend', '<button id="guest-access-btn" hidden></button>');
        btn = document.getElementById('guest-access-btn') as HTMLButtonElement;
    });

    it('is hidden unless the Worker has its guest quota on', () => {
        state.guest = false;
        renderGuestAccess();
        expect(btn.hidden).toBe(true);
        state.guest = true;
        renderGuestAccess();
        expect(btn.hidden).toBe(false);
    });

    it('shows Disabled or Enabled, with an explanation on hover', () => {
        renderGuestAccess();
        expect(btn.textContent).toBe('Guest access: Disabled');
        expect(btn.getAttribute('aria-pressed')).toBe('false');
        expect(btn.title).toMatch(/Groq, Kilo, OpenRouter or TokenHarbor.*150 requests a day per network.*own keys are always used first.*Click to use it/);
        state.chosen = true;
        renderGuestAccess();
        expect(btn.textContent).toBe('Guest access: Enabled');
        expect(btn.classList.contains('guest-access-on')).toBe(true);
        expect(btn.title).toMatch(/Click to stop using it/);
        state.pausedUntil = Date.now() + 3600_000;
        renderGuestAccess();
        expect(btn.title).toMatch(/used today's guest quota.*00:00 UTC/);
    });

    it('a click switches it and looks /keys up again, so the model lists follow', async () => {
        await toggleGuestAccess();
        expect(state.chosen).toBe(true);
        expect(btn.textContent).toBe('Guest access: Enabled');
        expect(state.loads).toBe(1);
        await toggleGuestAccess();
        expect(state.chosen).toBe(false);
        expect(btn.textContent).toBe('Guest access: Disabled');
    });
});
