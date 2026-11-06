import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { devLogEntry, flushDevLog, _resetDevLogForTest } from '../dev-log.ts';
import { storedCredentialValues } from '../stored-credentials.ts';
const W = window as any;
let original: typeof fetch;
beforeEach(() => {
  original = window.fetch; localStorage.clear(); _resetDevLogForTest();
  localStorage.setItem('fg_privacy_level', 'routed');
  localStorage.setItem('fg_dev_key', 'synthetic-review-developer-key');
});
afterEach(() => { _resetDevLogForTest(); window.fetch = original; localStorage.clear(); });
it('redacts an opaque credential saved by another tab before uploading developer errors', async () => {
  const next = 'opaque-review-remote-credential-value';
  localStorage.setItem('fg_moonmath_key', 'opaque-review-old-credential-value');
  devLogEntry('warn', 'review-control', 'populate the redaction inventory');
  // Storage named-property writes bypass this realm's patched setItem, modeling another tab.
  // Dispatch the corresponding browser storage event to exercise all installed cache listeners.
  localStorage['fg_moonmath_key'] = next;
  window.dispatchEvent(new StorageEvent('storage', {
    key: 'fg_moonmath_key', newValue: next, storageArea: localStorage,
  }));
  expect(localStorage.getItem('fg_moonmath_key')).toBe(next);
  expect(storedCredentialValues()).toContain(next); // positive control: extraction works
  const transport = vi.fn(async () => new Response('{}'));
  W.fetch = transport;
  devLogEntry('error', 'review', `provider echoed ${next}`);
  await flushDevLog();
  expect(transport).toHaveBeenCalled();
  expect(transport.mock.calls[0][1].body).not.toContain(next);
});
