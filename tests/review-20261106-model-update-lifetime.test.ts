import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { showModelUpdateModal } from '../model-update.ts';
const W = window as any;
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => { localStorage.clear(); document.body.innerHTML = ''; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); document.body.innerHTML = ''; });
it('does not let a closed model-update request replace the reopened dialog or apply its stale proposals', async () => {
  const older = deferred<any>(), newer = deferred<any>(); let calls = 0;
  const remembered = vi.spyOn(W, 'rememberModelCreated');
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
    if (url === 'https://openrouter.ai/api/v1/models') return { ok: true, json: () => (++calls === 1 ? older.promise : newer.promise) };
    return { ok: true, json: async () => null };
  }));
  const data = (id: string) => ({ data: [{ id, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] });
  showModelUpdateModal();
  await vi.waitFor(() => expect(calls).toBe(1));
  document.querySelector<HTMLButtonElement>('#fg-mu-close')!.click();
  showModelUpdateModal();
  await vi.waitFor(() => expect(calls).toBe(2));
  newer.resolve(data('review/current:free'));
  await vi.waitFor(() => expect(document.querySelector('input[data-spec="openrouter|review/current:free"]')).not.toBeNull());
  // Positive control: the currently open request completed and offered its own data.
  older.resolve(data('review/stale:free'));
  await vi.waitFor(() => expect(remembered).toHaveBeenCalledTimes(2));
  await Promise.resolve();
  document.querySelector<HTMLButtonElement>('#fg-mu-apply')!.click();
  expect(W.getCustomModels().some((m: any) => m.model === 'review/stale:free')).toBe(false);
  expect(W.getCustomModels().some((m: any) => m.model === 'review/current:free')).toBe(true);
});
