import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleOpenRouterCallback } from '../openrouter-oauth.ts';
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/');
  document.body.innerHTML = '<span id="key-paste-status"></span>';
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/'); document.body.innerHTML = ''; });
it('removes a callback code even when the pending request is unavailable in this tab', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  history.replaceState(null, '', '/?code=synthetic-code&state=unavailable&keep=1#anchor');
  await handleOpenRouterCallback();
  expect(fetcher).not.toHaveBeenCalled();
  expect(location.search + location.hash).toBe('?keep=1#anchor');
});
it('redacts saved credentials echoed in an OAuth exchange error', async () => {
  const credential = 'synthetic-opaque-review-credential';
  localStorage.setItem('fg_groq_key', credential);
  sessionStorage.setItem('fg_openrouter_oauth', JSON.stringify({ verifier: 'v'.repeat(43), state: 'review-state', method: 'S256', at: Date.now() }));
  history.replaceState(null, '', '/?code=synthetic-code&state=review-state');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Invalid credential: ' + credential } }), { status: 403 })));
  expect(await handleOpenRouterCallback()).toBe(false);
  expect(document.getElementById('key-paste-status')!.textContent).not.toContain(credential);
});
it('keeps a key the user set or cleared while the exchange was pending (X010)', async () => {
  for (const later of ['pasted-by-hand', null]) {
    localStorage.setItem('fg_openrouter_key', 'old-key');
    sessionStorage.setItem('fg_openrouter_oauth', JSON.stringify({ verifier: 'v'.repeat(43), state: 's', method: 'S256', at: Date.now() }));
    history.replaceState(null, '', '/?code=c&state=s');
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (later === null) localStorage.removeItem('fg_openrouter_key'); else localStorage.setItem('fg_openrouter_key', later);   // the user acts while the request is out
      return new Response(JSON.stringify({ key: 'exchanged-key' }), { status: 200 });
    }));
    expect(await handleOpenRouterCallback()).toBe(false);
    expect(localStorage.getItem('fg_openrouter_key')).toBe(later);
    expect(document.getElementById('key-paste-status')!.textContent).toMatch(/changed while signing in/);
  }
});
