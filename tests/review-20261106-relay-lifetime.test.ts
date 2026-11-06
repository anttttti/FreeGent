import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installRelaySession, _resetRelaySessions } from '../relay-session.ts';
const W = window as any;
const worker = 'https://proxy.freegent.ai';
const page = `${worker}/?url=https%3A%2F%2Freview.invalid%2F`;
const ask = () => new Response(JSON.stringify({ turnstileSiteKey: 'synthetic-site-key' }), {
  status: 401, headers: { 'Content-Type': 'application/json', 'X-FG-Session-Required': '1' },
});
let original: typeof fetch;
beforeEach(() => { original = window.fetch; _resetRelaySessions(); W._fgRelaySession = false; });
afterEach(() => {
  window.fetch = original; delete W.turnstile; delete W._fgRelaySession; _resetRelaySessions();
  document.querySelectorAll('script[src*="challenges.cloudflare.com"], .relay-check').forEach(e => e.remove());
  vi.useRealTimers();
});
describe('review: relay fetch lifetime', () => {
  it('settles with AbortError when the caller aborts during a pending challenge', async () => {
    let challenge: any;
    W.turnstile = { render: (_box: any, opts: any) => { challenge = opts; return 'widget'; }, remove: vi.fn() };
    const inner = vi.fn(async (url: any, init?: any) => {
      if (init?.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      if (url === worker + '/session') return new Response(JSON.stringify({ session: 'synthetic-session' }));
      return new Headers(init?.headers).has('X-FG-Session') ? new Response('ok') : ask();
    });
    window.fetch = inner as any; installRelaySession();
    const controller = new AbortController(); let outcome: string | undefined;
    const request = window.fetch(page, { signal: controller.signal }).then(() => { outcome = 'resolved'; }, e => { outcome = e.name; });
    await vi.waitFor(() => expect(challenge).toBeTruthy());
    try {
      controller.abort();
      await vi.waitFor(() => expect(outcome).toBe('AbortError'), { timeout: 150, interval: 10 });
    } finally { challenge.callback('synthetic-token'); await request; }
  });

  it.each(['script load', 'session exchange'])('bounds the %s phase, not only the visible challenge', async phase => {
    vi.useFakeTimers();
    let releaseSession!: (r: Response) => void;
    const heldSession = new Promise<Response>(r => { releaseSession = r; });
    if (phase === 'session exchange') W.turnstile = {
      render: (_box: any, opts: any) => { queueMicrotask(() => opts.callback('synthetic-token')); return 'widget'; }, remove: vi.fn(),
    };
    const inner = vi.fn(async (url: any, init?: any) => {
      if (url === worker + '/session') return heldSession;
      return new Headers(init?.headers).has('X-FG-Session') ? new Response('ok') : ask();
    });
    window.fetch = inner as any; installRelaySession();
    let settled = false;
    const request = window.fetch(page).then(() => { settled = true; }, () => { settled = true; });
    if (phase === 'script load') await vi.waitFor(() => expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).not.toBeNull());
    else await vi.waitFor(() => expect(inner.mock.calls.some(([url]) => url === worker + '/session')).toBe(true));
    try {
      await vi.advanceTimersByTimeAsync(130_000);
      expect(settled).toBe(true);
    } finally {
      if (phase === 'script load') document.querySelector('script[src*="challenges.cloudflare.com"]')!.dispatchEvent(new Event('error'));
      else releaseSession(new Response(JSON.stringify({ session: 'synthetic-session' })));
      await request;
    }
  });
});
