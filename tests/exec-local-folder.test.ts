import { describe, it, expect } from 'vitest';
import { snapshotWorkspace, staleGuard, addLiveFolderInput, withLiveFiles } from '../exec-limits.js';

// codex R438-R440: runs did not receive, or did not guard, the attached Local Folder's live files.
const live: Record<string, any> = {};
const listing = async () => Object.keys(live).map(name => ({ name, isLocal: true }));
const read = async (n: string) => { if (!(n in live)) throw new Error('File not found: ' + n); return live[n]; };
const setup = async (idb: any[], opts: { maxChars?: number } = {}) => {
    const files: Record<string, string> = {}, omitted = new Set<string>(), snap = snapshotWorkspace(idb);
    for (const r of idb) files[r.name] = r.content;
    await addLiveFolderInput({ list: listing, read, maxChars: opts.maxChars ?? 1000, put: (n, c) => { files[n] = c; }, snap, omitted });
    return { files, omitted, snap };
};

describe('live Local Folder files in a run', () => {
    it('reach the run and its baseline, and replace a stale imported record of the same name', async () => {
        for (const k of Object.keys(live)) delete live[k];
        live['local/src/a.py'] = 'live'; live['local/b.txt'] = 'only live';
        const { files, snap } = await setup([{ name: 'local/src/a.py', content: 'old imported' }, { name: 'x.txt', content: 'x' }]);
        expect(files['local/src/a.py']).toBe('live'); expect(files['local/b.txt']).toBe('only live');
        expect(snap.get('local/b.txt')).toBe('T:only live');
    });

    it('a folder file changed while the run worked is not overwritten; an unchanged one is', async () => {
        for (const k of Object.keys(live)) delete live[k];
        live['local/a.txt'] = 'v1'; live['local/b.txt'] = 'v1';
        const { omitted, snap } = await setup([]);
        live['local/a.txt'] = 'edited by the user meanwhile';
        const stale = await staleGuard(snap, omitted, withLiveFiles(async () => [], read, ['local/a.txt', 'local/b.txt', 'local/new.txt']));
        expect(stale('local/a.txt')).toBe(true);
        expect(stale('local/b.txt')).toBe(false);
        expect(stale('local/new.txt')).toBe(false);
        live['local/new.txt'] = 'made by someone else';
        const again = await staleGuard(snap, omitted, withLiveFiles(async () => [], read, ['local/new.txt']));
        expect(again('local/new.txt')).toBe(true);
    });

    it('a file the folder lost meanwhile counts as changed', async () => {
        for (const k of Object.keys(live)) delete live[k];
        live['local/a.txt'] = 'v1';
        const { omitted, snap } = await setup([]);
        delete live['local/a.txt'];
        const stale = await staleGuard(snap, omitted, withLiveFiles(async () => [], read, ['local/a.txt']));
        expect(stale('local/a.txt')).toBe(true);
    });

    it('a file that cannot be read is not seen by the run and, at the end, not known to be unchanged (Y020)', async () => {
        for (const k of Object.keys(live)) delete live[k];
        live['local/a.txt'] = 'v1'; live['local/locked.txt'] = 'secret';
        const unreadable = async (n: string) => { if (n === 'local/locked.txt') throw new Error('Could not read local/locked.txt: NotReadableError'); return read(n); };
        const files: Record<string, string> = {}, omitted = new Set<string>(), snap = snapshotWorkspace([]);
        await addLiveFolderInput({ list: listing, read: unreadable, maxChars: 1000, put: (n, c) => { files[n] = c; }, snap, omitted });
        expect(omitted.has('local/locked.txt')).toBe(true);           // the run may not replace what it did not see
        expect(files['local/a.txt']).toBe('v1');
        const stale = await staleGuard(snap, omitted, withLiveFiles(async () => [], unreadable, ['local/a.txt', 'local/locked.txt']));
        expect(stale('local/a.txt')).toBe(true);                      // the final read failed: nothing is known to be unchanged
    });

    it('too large or not text: left out of the run and not replaceable; a small live file clears an old "too large" mark (R440)', async () => {
        for (const k of Object.keys(live)) delete live[k];
        live['local/big.txt'] = 'x'.repeat(2000); live['local/img.png'] = new Uint8Array([1, 2]); live['local/small.txt'] = 'ok';
        const { files, omitted } = await setup([]);
        expect(files['local/big.txt']).toBeUndefined();
        expect(omitted.has('local/big.txt')).toBe(true); expect(omitted.has('local/img.png')).toBe(true);
        const omitted2 = new Set(['local/small.txt']);   // an imported record of this name was over the limit
        await addLiveFolderInput({ list: listing, read, maxChars: 1000, put: () => {}, snap: new Map(), omitted: omitted2 });
        expect(omitted2.has('local/small.txt')).toBe(false);
    });

    it('hands over the size of each file it leaves out, for the run to list it with', async () => {
        for (const k of Object.keys(live)) delete live[k];
        live['local/big.txt'] = 'x'.repeat(2000); live['local/ok.txt'] = 'ok';
        const sizes = new Map<string, number>(), omitted = new Set<string>();
        await addLiveFolderInput({ list: async () => [{ name: 'local/big.txt', isLocal: true, size: 2000 }, { name: 'local/ok.txt', isLocal: true, size: 2 }], read, maxChars: 1000, put: () => {}, snap: new Map(), omitted, sizes });
        expect([...sizes]).toEqual([['local/big.txt', 2000]]);
    });

    it('skips what the caller names (logs) and entries that are not folder files', async () => {
        for (const k of Object.keys(live)) delete live[k];
        live['local/logs/run.log'] = 'noise'; live['local/keep.txt'] = 'k';
        const files: Record<string, string> = {};
        await addLiveFolderInput({ list: async () => [...(await listing()), { name: 'idb.txt' }], read, maxChars: 1000, put: (n, c) => { files[n] = c; }, snap: new Map(), omitted: new Set(), skip: /^local\/logs\// });
        expect(Object.keys(files)).toEqual(['local/keep.txt']);
    });
});
