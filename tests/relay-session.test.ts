// tests/relay-session.test.ts — the page side of the Worker's Turnstile-gated fetch path (relay-session.ts):
// a 401 asking for a session runs the challenge once, trades the token at /session and resends with X-FG-Session.
import { installRelaySession, relayOrigin, _resetRelaySessions } from '../relay-session.js';

const WORKER = 'https://proxy.freegent.ai';
const PAGE = `${WORKER}/?url=${encodeURIComponent('https://example.com/')}`;
const json = (obj: any, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const askForSession = () => json({ error: 'Session check required', turnstileSiteKey: '0xSITE' }, 401, { 'X-FG-Session-Required': '1' });

describe('relay-session', () => {
    let inner: any, render: any;
    beforeEach(() => {
        _resetRelaySessions();
        (window as any)._fgRelaySession = false;
        render = vi.fn((_box: HTMLElement, opts: any) => { setTimeout(() => opts.callback('ts-token'), 0); return 'w1'; });
        (window as any).turnstile = { render, remove: vi.fn() };
        inner = vi.fn(async (url: string, init?: any) => {
            if (url === `${WORKER}/session`) return json({ session: 'S1', expires: Date.now() + 1e6 });
            return new Headers(init?.headers).get('X-FG-Session') === 'S1' ? new Response('page') : askForSession();
        });
        window.fetch = inner;
        installRelaySession();
    });
    afterEach(() => { delete (window as any).turnstile; });

    it('recognises GET ?url= requests and string-body POSTs to another origin', () => {
        expect(relayOrigin(PAGE)).toBe(WORKER);
        expect(relayOrigin(`${WORKER}/`, { method: 'POST', body: '{}' })).toBe(WORKER);
        expect(relayOrigin(`${WORKER}/`, { method: 'POST', body: new Blob(['x']) })).toBeNull();
        expect(relayOrigin(PAGE, { method: 'PUT', body: '{}' })).toBeNull();
        expect(relayOrigin(`${WORKER}/keys`)).toBeNull();
        expect(relayOrigin(`${window.location.origin}/api/proxy?url=x`)).toBeNull();
    });

    it('runs the challenge on a 401, trades the token, and resends with the session', async () => {
        const r = await window.fetch(PAGE);
        expect(await r.text()).toBe('page');
        expect(render).toHaveBeenCalledTimes(1);
        expect(render.mock.calls[0][1]).toMatchObject({ sitekey: '0xSITE', appearance: 'interaction-only' });
        const trade = inner.mock.calls.find((c: any[]) => c[0] === `${WORKER}/session`);
        expect(JSON.parse(trade[1].body)).toEqual({ token: 'ts-token' });
        expect(document.querySelector('.relay-check')).toBeNull();
    });

    it('reuses the session, and parallel fetches share one challenge', async () => {
        await Promise.all([window.fetch(PAGE), window.fetch(PAGE), window.fetch(PAGE)]);
        await window.fetch(PAGE);
        expect(render).toHaveBeenCalledTimes(1);
    });

    it('sends no session header before a Worker has asked for one, and passes other requests through untouched', async () => {
        inner.mockImplementation(async () => new Response('ok'));
        await window.fetch(PAGE);
        await window.fetch(`${WORKER}/`, { method: 'POST', body: '{}' });
        for (const [, init] of inner.mock.calls) expect(new Headers(init?.headers).has('X-FG-Session')).toBe(false);
        expect(render).not.toHaveBeenCalled();
    });

    it('a guest model call (POST) asked for a session is resent with it and its body', async () => {
        inner.mockImplementation(async (url: string, init?: any) => {
            if (url === `${WORKER}/session`) return json({ session: 'S1', expires: Date.now() + 1e6 });
            return new Headers(init?.headers).get('X-FG-Session') === 'S1' ? new Response(`ran ${init.body}`) : askForSession();
        });
        const r = await window.fetch(`${WORKER}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"url":"x"}' });
        expect(await r.text()).toBe('ran {"url":"x"}');
        const last = inner.mock.calls.at(-1);
        expect(new Headers(last[1].headers).get('Content-Type')).toBe('application/json');
    });

    it('a failed challenge comes back as a clear error, not a hang', async () => {
        render.mockImplementation((_box: HTMLElement, opts: any) => { setTimeout(() => opts['error-callback']('300030'), 0); return 'w1'; });
        const r = await window.fetch(PAGE);
        expect(r.status).toBe(401);
        expect((await r.json()).error).toMatch(/challenges\.cloudflare\.com.*Provider-only/);
    });
});
