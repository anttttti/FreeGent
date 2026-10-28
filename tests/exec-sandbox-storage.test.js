// The exec sandbox frame has an opaque origin, where the page's localStorage / sessionStorage / indexedDB throw on any touch,
// even `typeof localStorage`. Code run by the shell's node (`node test_leaderboard.mjs`) guarding with
// `typeof localStorage !== 'undefined'` died with "The operation is insecure" and the agent blocked the task
// (Autopilot exploration 2026-10-27, AE-04). The shim makes them undefined, as in node, and assignable.
const insecure = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };

let saved;
beforeEach(() => { saved = ['localStorage', 'sessionStorage', 'indexedDB'].map(n => [n, Object.getOwnPropertyDescriptor(globalThis, n)]); });
afterEach(() => { for (const [n, d] of saved) { delete globalThis[n]; if (d) Object.defineProperty(globalThis, n, d); } });

it('storage names read as undefined in the frame, can be assigned, and the shell keeps its stand-ins', async () => {
    for (const name of ['localStorage', 'sessionStorage', 'indexedDB'])
        Object.defineProperty(globalThis, name, { get: insecure, configurable: true });
    expect(() => typeof localStorage).toThrow(/insecure/);
    await import('../exec-sandbox/storage-shim.ts');
    expect(typeof localStorage).toBe('undefined');
    expect(typeof sessionStorage).toBe('undefined');
    expect(typeof indexedDB).toBe('undefined');
    const code = new Function(`const store = typeof localStorage !== 'undefined' ? localStorage : new Map(); return store instanceof Map;`);
    expect(code()).toBe(true);
    globalThis.localStorage = { getItem: () => 'mine' };
    expect(localStorage.getItem()).toBe('mine');
    globalThis.__fgMemStorage.setItem('k', 'v');
    expect(globalThis.__fgMemStorage.getItem('k')).toBe('v');
});
