// openrouter-oauth.ts — FreeGent: "Connect OpenRouter" in Settings → Credentials.
//
// OpenRouter's OAuth PKCE flow (https://openrouter.ai/docs/guides/overview/auth/oauth) gives FreeGent a
// key of its own without copying one by hand: the page sends the user to openrouter.ai/auth with a
// code_challenge, OpenRouter sends them back with ?code=…&state=…, and the page exchanges the code and
// its code_verifier for a key (POST /api/v1/auth/keys). The key is labelled "FreeGent" in the user's
// OpenRouter account, where they can give it a credit limit or revoke it.
//
// No server is involved and no client secret exists: the verifier and state live in this tab's
// sessionStorage between leaving and returning, and are removed as soon as the callback is handled.
// The key is saved like a pasted one (fg_openrouter_key), so the key lock covers it when it is on.

import { keyVaultEnabled, keyVaultUnlocked } from './key-vault.js';
import { redactText } from './secrets.js';
import { storedCredentialValues } from './stored-credentials.js';

const AUTH_URL = 'https://openrouter.ai/auth';
const KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys';
const PENDING = 'fg_openrouter_oauth';   // sessionStorage: { verifier, state, method, at }
const MAX_AGE_MS = 15 * 60_000;          // OpenRouter codes expire after 10 minutes

const _b64url = (u: Uint8Array) => { let s = ''; for (const b of u) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const _random = (n: number) => _b64url(crypto.getRandomValues(new Uint8Array(n)));

/** The page address OpenRouter returns to: this page, without query or fragment. */
export function openRouterCallbackUrl(loc: { origin: string; pathname: string } = location): string {
    return loc.origin + loc.pathname;
}

/** PKCE pair: S256 where WebCrypto exists (HTTPS, localhost), 'plain' on a plain-HTTP LAN address. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string; method: 'S256' | 'plain' }> {
    const verifier = _random(32);
    const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
    if (!subtle) return { verifier, challenge: verifier, method: 'plain' };
    const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    return { verifier, challenge: _b64url(digest), method: 'S256' };
}

/** The openrouter.ai/auth address for a PKCE challenge. */
export function openRouterAuthUrl(callbackUrl: string, challenge: string, method: string, state: string): string {
    const q = new URLSearchParams({ callback_url: callbackUrl, code_challenge: challenge, code_challenge_method: method, key_label: 'FreeGent', state });
    return `${AUTH_URL}?${q}`;
}

/** Settings → Credentials → Connect: leave for openrouter.ai to approve a key. */
export async function connectOpenRouter(): Promise<void> {
    const have = (() => { try { return localStorage.getItem('fg_openrouter_key') || ''; } catch { return ''; } })();
    if (have && !have.startsWith('__fgsk__') &&
        !confirm('Replace your saved OpenRouter key with a new one from OpenRouter? (The old key keeps working until you revoke it at openrouter.ai/keys.)')) return;
    const { verifier, challenge, method } = await pkcePair();
    const state = _random(16);
    try { sessionStorage.setItem(PENDING, JSON.stringify({ verifier, state, method, at: Date.now() })); }
    catch { alert('Connect OpenRouter needs this tab\'s session storage, which the browser refused. Paste a key instead.'); return; }
    location.assign(openRouterAuthUrl(openRouterCallbackUrl(), challenge, method, state));
}

function _status(text: string) {
    const el = typeof document !== 'undefined' ? document.getElementById('key-paste-status') : null;
    if (el) el.textContent = text;
}

/** At page open: finish a Connect that came back with ?code=…&state=…. Returns true when it saved a key,
 *  false when it handled a callback that failed (the message is in Settings → Credentials), null when there was none.
 *  A code whose state does not match this tab's pending request is ignored (another site's link, a stale
 *  tab); the code and state are removed from the address bar either way. */
export async function handleOpenRouterCallback(): Promise<boolean | null> {
    if (typeof location === 'undefined') return null;
    const params = new URLSearchParams(location.search);
    const code = params.get('code'), state = params.get('state');
    let pending: any = null;
    try { pending = JSON.parse(sessionStorage.getItem(PENDING) || 'null'); } catch {}
    if (!code) return null;
    // Strip the code from the address bar (and history) before anything else, also when this tab has no pending
    // request (a link opened in another tab): it is single-use, but must not linger.
    try {
        params.delete('code'); params.delete('state');
        const q = params.toString();
        history.replaceState(history.state, '', location.pathname + (q ? `?${q}` : '') + location.hash);
    } catch {}
    if (!pending) return null;
    try { sessionStorage.removeItem(PENDING); } catch {}
    if (state !== pending.state || !pending.verifier || Date.now() - (pending.at || 0) > MAX_AGE_MS) {
        _status('OpenRouter: the sign-in did not match this tab or took too long. Try Connect again.');
        return false;
    }
    _status('OpenRouter: getting your key…');
    try {
        const r = await fetch(KEYS_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, code_verifier: pending.verifier, code_challenge_method: pending.method }),
        });
        const j: any = await r.json().catch(() => ({}));
        if (!r.ok || typeof j.key !== 'string' || !j.key) {
            const why = j?.error?.message || j?.message || `HTTP ${r.status}`;
            throw new Error(r.status === 403 ? `the sign-in code was refused or expired (${why})` : why);
        }
        localStorage.setItem('fg_openrouter_key', j.key);
        _status(keyVaultEnabled() && !keyVaultUnlocked()
            ? 'OpenRouter connected, but your saved keys are locked: the new key lasts for this page only. Unlock the key lock, then Connect again to keep it.'
            : 'OpenRouter connected: a "FreeGent" key was saved. Set a credit limit or revoke it at openrouter.ai/keys.');
        const w = window as any;
        try { w.populateSettingsForm?.(); w.renderModelCatalogTable?.(); w.renderMainModelList?.(); w.updateModelLabel?.(); w.updateActiveModelDisplay?.(); } catch {}
        return true;
    } catch (e: any) {
        const why = e?.name === 'PrivacyBlockedError' ? 'blocked by Settings → Privacy' : redactText(String(e?.message ?? e), storedCredentialValues());
        _status(`OpenRouter: could not get a key: ${why}. Try Connect again, or paste a key.`);
        return false;
    }
}

if (typeof window !== 'undefined') Object.assign(window, { connectOpenRouter, handleOpenRouterCallback });
