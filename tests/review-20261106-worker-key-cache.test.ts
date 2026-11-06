import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadCfWorkerKeys, guestModeOn, guestQuotaOn, specHasKey } from '../config.ts';
const response = (guest: boolean) => new Response(JSON.stringify({ guestMode: guest, guestQuota: guest, GROQ_API_KEY: guest }), { status: 200 });
const configure = (url: string) => { localStorage.setItem('fg_privacy_level', 'routed'); localStorage.setItem('fg_search_proxy', url); };
beforeEach(async () => { localStorage.clear(); configure('https://review-reset.invalid'); vi.stubGlobal('fetch', vi.fn(async () => response(false))); await loadCfWorkerKeys(); });
afterEach(async () => { configure('https://review-reset.invalid'); vi.stubGlobal('fetch', vi.fn(async () => response(false))); await loadCfWorkerKeys(); vi.unstubAllGlobals(); localStorage.clear(); });
it('clears manual Worker access when Provider-only returns to the local same-origin proxy', async () => {
  configure('https://review-worker.invalid');
  vi.stubGlobal('fetch', vi.fn(async () => response(true)));
  await loadCfWorkerKeys();
  expect(guestModeOn()).toBe(true);
  expect(specHasKey('groq|openai/gpt-oss-120b')).toBe(true);
  localStorage.setItem('fg_privacy_level', 'provider');
  await loadCfWorkerKeys();
  expect(guestModeOn()).toBe(false);
  expect(specHasKey('groq|openai/gpt-oss-120b')).toBe(false);
});
it('does not let an older Worker response overwrite the current Workers access', async () => {
  let release!: (r: Response) => void;
  const old = new Promise<Response>(r => { release = r; });
  const transport = vi.fn((url: any) => url === 'https://review-old.invalid/keys' ? old : Promise.resolve(response(false)));
  vi.stubGlobal('fetch', transport);
  configure('https://review-old.invalid'); const oldRequest = loadCfWorkerKeys();
  configure('https://review-current.invalid'); await loadCfWorkerKeys();
  expect(guestQuotaOn()).toBe(false); // positive control: the current Worker refused guest access
  release(response(true)); await oldRequest;
  expect(guestQuotaOn()).toBe(false);
  expect(specHasKey('groq|openai/gpt-oss-120b')).toBe(false);
});
