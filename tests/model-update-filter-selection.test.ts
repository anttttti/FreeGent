import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { showModelUpdateModal } from '../model-update.ts';
const W = window as any;
const spec = 'requesty|review-no-tools';
beforeEach(() => { localStorage.clear(); document.body.innerHTML = ''; });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); document.body.innerHTML = ''; });
it('does not apply a selected addition after its filter hides and deselects it', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: any) => {
    const target = init?.body ? JSON.parse(init.body).url : _url;
    return { ok: true, json: async () => target === 'https://router.requesty.ai/v1/models'
      ? { data: [{ id: 'review-no-tools', supports_tool_calling: false, input_price: 0, output_price: 0 }] }
      : null };
  }));
  showModelUpdateModal();
  await vi.waitFor(() => expect(document.querySelector('#fg-mu-apply')).not.toBeNull(), { timeout: 10_000 });
  const chip = document.querySelector<HTMLButtonElement>('[data-filter="no-tools"]')!;
  expect(chip).not.toBeNull(); chip.click();
  const checkbox = document.querySelector<HTMLInputElement>(`input[data-spec="${spec}"]`)!;
  expect(checkbox.checked).toBe(false);
  checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  chip.click(); // The handler explicitly intends to hide AND deselect these additions.
  expect(document.querySelector(`input[data-spec="${spec}"]`)).toBeNull();
  document.querySelector<HTMLButtonElement>('#fg-mu-apply')!.click();
  expect(W.getCustomModels().some((m: any) => `${m.provider}|${m.model}` === spec)).toBe(false);
});
