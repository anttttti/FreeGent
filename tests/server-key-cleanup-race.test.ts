import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const W = window as any;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); delete W.__FG_SERVER_KEYS; localStorage.clear(); });
it('keeps a user replacement made while the server-copy hash check was in flight', async () => {
  const old = 'synthetic-server-held-review-value';
  const replacement = 'synthetic-user-replacement-review-value';
  localStorage.setItem('fg_groq_key', old);
  W.__FG_SERVER_KEYS = { fg_groq_key: createHash('sha256').update(old).digest('hex').slice(0,16) };
  const entered = deferred(), release = deferred();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
    entered.resolve(); await release.promise; return digest(...args);
  });
  const loading = W.loadServerKeys();
  await entered.promise;
  localStorage.setItem('fg_groq_key', replacement);
  release.resolve(); await loading;
  expect(localStorage.getItem('fg_groq_key')).toBe(replacement);
});
