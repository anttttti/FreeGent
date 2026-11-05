import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  createVaultPasskey, enableKeyVault, disableKeyVault, resetKeyVault,
  lockKeyVault, unlockKeyVault, flushKeyVault, keyVaultEnabled, keyVaultSaveState,
} from '../key-vault.ts';

const secret = 'synthetic-review-groq-credential';
const prf = (salt: Uint8Array) => new Uint8Array(createHmac('sha256', 'review-authenticator').update(salt).digest()).buffer;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(async () => {
  await flushKeyVault(); resetKeyVault(); localStorage.clear();
  vi.stubGlobal('PublicKeyCredential', class {});
  vi.stubGlobal('isSecureContext', true);
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: {
    create: async (o: any) => ({ rawId: new Uint8Array([1,2,3]).buffer,
      getClientExtensionResults: () => ({ prf: { enabled: true, results: { first: prf(o.publicKey.extensions.prf.eval.first) } } }) }),
    get: async (o: any) => ({ getClientExtensionResults: () => ({ prf: { results: { first: prf(o.publicKey.extensions.prf.eval.first) } } }) }),
  } });
});
afterEach(async () => { vi.restoreAllMocks(); await flushKeyVault(); resetKeyVault(); localStorage.clear(); vi.unstubAllGlobals(); });
async function enabled() { localStorage.setItem('fg_groq_key', secret); await enableKeyVault(await createVaultPasskey()); }

describe('review: disabling a passkey vault respects later transitions', () => {
  it.each(['lock', 'reset'] as const)('does not restore plaintext after %s during its decrypt', async action => {
    await enabled();
    const entered = deferred(), release = deferred();
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (...args) => {
      entered.resolve(); await release.promise; return decrypt(...args);
    });
    const disabling = disableKeyVault();
    // Observe rejection immediately so the test does not create an unhandled rejection.
    const outcome = disabling.then(() => 'resolved', () => 'rejected');
    await entered.promise;
    if (action === 'lock') lockKeyVault(); else resetKeyVault();
    release.resolve();
    await outcome;
    expect(localStorage.getItem('fg_groq_key')).toBeNull();
    if (action === 'lock') expect(keyVaultEnabled()).toBe(true);
  });
});

describe('review: failed saves remain visible until persisted', () => {
  it('does not report success for a later unrelated save while an earlier credential remains unsaved', async () => {
    await enabled();
    vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValueOnce(new Error('synthetic encrypted-save failure'));
    localStorage.setItem('fg_groq_key', 'replacement-review-groq-credential');
    await flushKeyVault();
    expect(keyVaultSaveState().error).toContain('synthetic encrypted-save failure');
    localStorage.setItem('fg_hf_key', 'synthetic-review-hf-credential');
    await flushKeyVault();
    // A successful HF save must either recover the Groq edit or keep its failure visible.
    const errorStillVisible = keyVaultSaveState().error;
    lockKeyVault(); await unlockKeyVault();
    const recovered = localStorage.getItem('fg_groq_key') === 'replacement-review-groq-credential';
    expect(recovered || !!errorStillVisible).toBe(true);
  });
});
