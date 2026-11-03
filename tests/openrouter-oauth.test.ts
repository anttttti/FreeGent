// openrouter-oauth.ts: Connect OpenRouter (OAuth PKCE). The page leaves for openrouter.ai/auth and comes
// back with ?code=…&state=…; the code and this tab's verifier are exchanged for a key.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { pkcePair, openRouterAuthUrl, openRouterCallbackUrl, handleOpenRouterCallback } from '../openrouter-oauth.ts';

const W: any = window;
const realFetch = W.fetch;
let calls: any[] = [];
const reply = (status: number, body: any) => { W.fetch = async (url: string, init: any) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify(body), { status }); }; };
const pend = (state = 'st8') => sessionStorage.setItem('fg_openrouter_oauth', JSON.stringify({ verifier: 'v'.repeat(43), state, method: 'S256', at: Date.now() }));
const statusEl = () => document.getElementById('key-paste-status')!;

beforeEach(() => {
    calls = []; localStorage.clear(); sessionStorage.clear();
    document.body.innerHTML = '<span id="key-paste-status"></span>';
    history.replaceState(null, '', '/');
});
afterEach(() => { W.fetch = realFetch; });

describe('Connect OpenRouter', () => {
    it('makes an S256 PKCE pair and the auth address OpenRouter expects', async () => {
        const { verifier, challenge, method } = await pkcePair();
        expect(method).toBe('S256');
        expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
        const u = new URL(openRouterAuthUrl(openRouterCallbackUrl({ origin: 'https://freegent.ai', pathname: '/' }), challenge, method, 'st8'));
        expect(u.origin + u.pathname).toBe('https://openrouter.ai/auth');
        expect(Object.fromEntries(u.searchParams)).toEqual({ callback_url: 'https://freegent.ai/', code_challenge: challenge, code_challenge_method: 'S256', key_label: 'FreeGent', state: 'st8' });
    });

    it('does nothing on an ordinary page load', async () => {
        pend();
        expect(await handleOpenRouterCallback()).toBeNull();
        history.replaceState(null, '', '/?code=abc&state=st8');
        sessionStorage.clear();
        expect(await handleOpenRouterCallback()).toBeNull();   // a code with no pending request in this tab
    });

    it('exchanges the code with this tab\'s verifier, saves the key and cleans the address bar', async () => {
        pend();
        history.replaceState(null, '', '/?code=abc&state=st8&keep=1#x');
        reply(200, { key: 'sk-or-v1-' + 'k'.repeat(40) });
        expect(await handleOpenRouterCallback()).toBe(true);
        expect(calls).toEqual([{ url: 'https://openrouter.ai/api/v1/auth/keys', body: { code: 'abc', code_verifier: 'v'.repeat(43), code_challenge_method: 'S256' } }]);
        expect(localStorage.getItem('fg_openrouter_key')).toBe('sk-or-v1-' + 'k'.repeat(40));
        expect(location.search + location.hash).toBe('?keep=1#x');
        expect(sessionStorage.getItem('fg_openrouter_oauth')).toBeNull();
        expect(statusEl().textContent).toMatch(/connected/);
    });

    it('ignores a code whose state does not match this tab\'s request', async () => {
        pend('mine');
        history.replaceState(null, '', '/?code=abc&state=theirs');
        reply(200, { key: 'sk-or-v1-x' });
        expect(await handleOpenRouterCallback()).toBe(false);
        expect(calls).toEqual([]);
        expect(localStorage.getItem('fg_openrouter_key')).toBeNull();
        expect(location.search).toBe('');
    });

    it('a refused or expired code says so and saves nothing', async () => {
        pend();
        history.replaceState(null, '', '/?code=abc&state=st8');
        reply(403, { error: { message: 'Invalid code' } });
        expect(await handleOpenRouterCallback()).toBe(false);
        expect(localStorage.getItem('fg_openrouter_key')).toBeNull();
        expect(statusEl().textContent).toMatch(/refused or expired/);
    });
});
