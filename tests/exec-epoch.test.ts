import { describe, it, expect, beforeEach } from 'vitest';
import { snapshotWorkspace, staleGuard, bumpWorkspaceEpoch, WORKSPACE_EPOCH_KEY } from '../exec-limits.js';

// Campaign 8 cases 178/179: a run that started in a project that was replaced meanwhile may not write into the new one,
// even for a file that did not exist before or that was restored with identical bytes.
describe('stale-run guard across project replacement', () => {
    beforeEach(() => { (globalThis as any).localStorage ??= (() => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; })(); });
    const recs = [{ name: 'a.txt', content: 'same' }];
    it('is not stale when nothing changed', async () => {
        const snap = snapshotWorkspace(recs);
        const stale = await staleGuard(snap, new Set(), async () => recs);
        expect(stale('a.txt')).toBe(false);
        expect(stale('new.txt')).toBe(false);
    });
    it('refuses every path once the project was replaced, including new files and identical bytes', async () => {
        const snap = snapshotWorkspace(recs);
        bumpWorkspaceEpoch();                                   // another tab (or this one) imported a project
        const stale = await staleGuard(snap, new Set(), async () => recs);
        expect(stale('a.txt')).toBe(true);
        expect(stale('new.txt')).toBe(true);
    });
    it('keeps its epoch in shared storage', () => {
        const before = Number(localStorage.getItem(WORKSPACE_EPOCH_KEY) || 0);
        bumpWorkspaceEpoch();
        expect(Number(localStorage.getItem(WORKSPACE_EPOCH_KEY))).toBeGreaterThan(before);
    });
});
