// guest-quota.ts — the guest quota on the page side. The Worker's guest quota (cf-worker/worker.js, "Guest quota")
// runs a visitor's requests on the operator's free-tier accounts at Groq, Kilo, OpenRouter and TokenHarbor, through
// the Worker (Routed level) after a Turnstile check, while the operator has it switched on, up to a daily number of
// requests per network.
//  - The offer: a send with no usable key on a hosted page shows "Use the guest quota" or "Add my own key". The
//    page asks the Worker nothing until the visitor picks the guest quota, so Provider-only still never contacts a
//    Worker; picking it switches Privacy to Routed (and back if it is off), and records the choice: until then the
//    guest models are not offered even at Routed (config.ts loadCfWorkerKeys).
//  - Keeping up: the operator can switch the quota on or off at any time, so /keys is looked up again when the tab
//    comes back into view and every few minutes while it is visible, and at once when a call is refused because the
//    quota is off. A refusal for the day's limit pauses the guest models until 00:00 UTC.
import { isStaticHost } from './static-hosts.js';
import { getPrivacyLevel } from './privacy.js';
import { guestQuotaOn, loadCfWorkerKeys, chooseGuestQuota, unchooseGuestQuota, guestQuotaChosen, guestQuotaDaily, guestQuotaPausedUntil, pauseGuestQuota, cfWorkerKeysLoadedAt } from './config.js';

const DIALOG_ID = 'fg-guest-quota-dialog';
const PROVIDERS_URL = 'https://freegent.ai/docs/models/providers';
const TERMS: [string, string][] = [
    ['Groq', 'https://console.groq.com/docs/legal'],
    ['Kilo', 'https://kilo.ai/terms'],
    ['OpenRouter', 'https://openrouter.ai/terms'],
    ['TokenHarbor', 'https://tokenharbor.ai/terms'],
];
const REFRESH_MIN_MS = 60_000;          // at most one /keys lookup a minute from focus changes and refusals
const REFRESH_EVERY_MS = 5 * 60_000;    // while the tab is visible

/** On a hosted page (no local server with its own keys), and not at the Local level, which allows no Worker. */
export function canOfferGuestQuota(): boolean {
    try { return isStaticHost(window.location.hostname) && getPrivacyLevel() !== 'local'; } catch { return false; }
}

const _utcMidnight = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); };
const _pausedText = () => `This network has used today's guest quota. Add your own key, or come back after 00:00 UTC (${new Date(_utcMidnight()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} your time).`;

/** Shows the choice. `retry` re-runs the send once the guest quota is in use. */
export function offerGuestQuota(retry: () => void): void {
    document.getElementById(DIALOG_ID)?.remove();
    const overlay = document.createElement('div');
    overlay.id = DIALOG_ID;
    overlay.className = 'fg-modal-overlay';
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    const terms = TERMS.map(([name, url]) => `<a href="${url}" target="_blank" rel="noopener">${name}</a>`).join(', ');
    overlay.innerHTML = `<div class="fg-modal" role="dialog" aria-modal="true" aria-labelledby="fg-guest-quota-title" style="max-width:520px;width:95%">
  <div class="fg-modal-header">
    <span class="fg-modal-title" id="fg-guest-quota-title">No API key yet</span>
    <button class="fg-modal-close" aria-label="Close" data-act="close">✕</button>
  </div>
  <div class="fg-modal-body" style="padding:12px 16px">
    <p><b>Use the guest quota.</b> FreeGent runs your requests on its own free-tier accounts at Groq, Kilo, OpenRouter and
    TokenHarbor, while it is switched on. Everyone shares it, and each network gets a limited number of requests a day.
    Requests go through FreeGent's Cloudflare Worker (Privacy: Routed) after a Cloudflare bot check. The providers' terms
    apply (${terms}), and free models may use your prompts for training: don't send anything private.</p>
    <p><b>Add your own key.</b> A free key from Gemini, OpenRouter, Groq or others takes a minute to get
    (<a href="${PROVIDERS_URL}" target="_blank" rel="noopener">where to get one</a>). Your requests then go straight to that
    provider, and your key is always used before the guest quota.</p>
    <p class="settings-hint" data-role="status" role="status" style="margin:0"></p>
  </div>
  <div class="fg-modal-btns">
    <button class="fg-modal-btn fg-modal-btn-cancel" data-act="key">Add my own key</button>
    <button class="fg-modal-btn fg-modal-btn-ok" data-act="guest">Use the guest quota</button>
  </div>
</div>`;
    const status = overlay.querySelector('[data-role="status"]') as HTMLElement;
    const guestBtn = overlay.querySelector('[data-act="guest"]') as HTMLButtonElement;
    overlay.querySelector('[data-act="close"]')!.addEventListener('click', () => overlay.remove());
    overlay.querySelector('[data-act="key"]')!.addEventListener('click', () => { overlay.remove(); (window as any).showSettings?.(); });
    guestBtn.addEventListener('click', async () => {
        if (guestQuotaPausedUntil()) { status.textContent = _pausedText(); return; }
        guestBtn.disabled = true;
        status.textContent = 'Checking the guest quota…';
        const before = getPrivacyLevel();
        const setLevel = (level: string) => (window as any).onPrivacyLevelChange?.(level);
        if (before !== 'routed') setLevel('routed');
        chooseGuestQuota();
        try { await loadCfWorkerKeys(); } catch {}
        if (guestQuotaOn()) { overlay.remove(); retry(); return; }
        if (before !== 'routed') setLevel(before);
        status.textContent = 'The guest quota is off right now. Add your own key, or try again later.';
        guestBtn.disabled = false;
    });
    document.body.appendChild(overlay);
    guestBtn.focus();
}

let _refreshing: Promise<void> | null = null;
function _refresh(force = false): void {
    if (_refreshing || (!force && Date.now() - cfWorkerKeysLoadedAt() < REFRESH_MIN_MS)) return;
    if (getPrivacyLevel() !== 'routed') return;   // no Worker below Routed: nothing to look up
    _refreshing = loadCfWorkerKeys().catch(() => {}).finally(() => { _refreshing = null; });
}

/** Watches Worker replies for guest refusals (X-FG-Guest) and keeps the /keys lookup fresh. */
export function installGuestQuotaWatch(): void {
    const w = window as any;
    if (w._fgGuestQuotaWatch) return;
    w._fgGuestQuotaWatch = true;
    const inner = window.fetch;
    window.fetch = async function (input: any, init?: any) {
        const resp = await inner.call(window, input, init);
        const kind = resp.headers?.get?.('X-FG-Guest');
        if (kind === 'limit') { pauseGuestQuota(_utcMidnight()); _refresh(true); }
        else if (kind === 'off') _refresh(true);
        return resp;
    } as typeof fetch;
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') _refresh(); });
    window.addEventListener('focus', () => _refresh());
    setInterval(() => { if (document.visibilityState === 'visible') _refresh(); }, REFRESH_EVERY_MS);
}

// ── "Guest access" in Settings → Models, beside Populate and Defaults ────────
// Shown only while the Worker has its guest quota on (its /keys reply, so only at Routed and never for a Developer-key
// session, which uses all Worker keys anyway). Enabled = this browser chose the guest quota; a click switches it.
export function renderGuestAccess(): void {
    const btn = document.getElementById('guest-access-btn') as HTMLButtonElement | null;
    if (!btn) return;
    btn.hidden = !guestQuotaOn();
    if (btn.hidden) return;
    const on = guestQuotaChosen();
    const paused = guestQuotaPausedUntil();
    const daily = guestQuotaDaily();
    btn.textContent = `Guest access: ${on ? 'Enabled' : 'Disabled'}`;
    btn.classList.toggle('guest-access-on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = 'FreeGent\'s Worker offers guest access: when you have no key of your own for Groq, Kilo, OpenRouter or '
        + `TokenHarbor, it runs those models on FreeGent's free-tier accounts${daily ? `, up to ${daily} requests a day per network` : ''}. `
        + 'Everyone shares it, your own keys are always used first, the providers\' terms apply, and free models may use '
        + 'your prompts for training: don\'t send anything private. '
        + (on ? (paused ? `This network has used today's guest quota; it is back after 00:00 UTC. ` : 'Its models count as available in the lists below. ')
              + 'Click to stop using it.'
              : 'Its models are not offered until you enable it. Click to use it.');
}

export async function toggleGuestAccess(): Promise<void> {
    if (guestQuotaChosen()) unchooseGuestQuota(); else chooseGuestQuota();
    renderGuestAccess();
    try { await loadCfWorkerKeys(); } catch {}   // re-renders the model lists and this button
    (window as any).updateActiveModelDisplay?.();
}

Object.assign(window, { renderGuestAccess, toggleGuestAccess });
