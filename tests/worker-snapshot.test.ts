// worker-snapshot.test.ts — run_workers' workspace view: the file list is taken up front and a
// file's content is read on first access, once, then kept; worker tools read and edit through it.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { setWorkspaceAdapter } from '../workspace.ts';

const W = window as any;
let LazySnapshot: any;
let disk: Record<string, string>;
let reads: ReturnType<typeof vi.fn>;

beforeAll(async () => {
    ({ LazySnapshot } = await import('../workers.ts'));
});

beforeEach(() => {
    W.mainAgentRole = null;
    disk = { 'a.py': 'print("a")\n', 'b.py': 'x = 1\n', 'docs/readme.md': '# hi\n' };
    reads = vi.fn(async (p: string) => { if (!(p in disk)) throw new Error('ENOENT'); return disk[p]; });
    // workers.ts / tools.ts read through workspace.ts, which delegates to an injected adapter.
    setWorkspaceAdapter({
        agentReadFile: reads,
        agentListFiles: async () => Object.keys(disk).map(name => ({ name, size: disk[name].length })),
        agentWriteFile: async (p: string, c: string) => { disk[p] = c; },
        agentDeleteFile: async (p: string) => { delete disk[p]; },
        agentFileMtime: async () => null,
        agentListFilesInDir: async () => [],
    } as any);
});
afterAll(() => setWorkspaceAdapter(null));

const snapshot = async () => W.takeWorkspaceSnapshot();

describe('LazySnapshot', () => {
    it('lists files without reading any', async () => {
        const snap = await snapshot();
        expect(snap).toBeInstanceOf(LazySnapshot);
        expect(snap.size).toBe(3);
        expect(snap.has('a.py')).toBe(true);
        expect(reads).not.toHaveBeenCalled();
    });

    it('reads a file on first access, once, and keeps that content', async () => {
        const snap = await snapshot();
        expect(await snap.get('a.py')).toBe('print("a")\n');
        disk['a.py'] = 'changed on disk\n';
        expect(await snap.get('a.py')).toBe('print("a")\n');
        expect(reads).toHaveBeenCalledTimes(1);
        expect(await snap.get('missing.py')).toBeUndefined();
    });
});

describe('worker tools through the snapshot', () => {
    const ctx = async () => ({ snapshot: await snapshot(), staging: new Map(), depth: 0 });

    it('read_file returns snapshot content', async () => {
        const context = await ctx();
        const r = await W.executeToolAsync('read_file', { path: 'b.py' }, context);
        expect(r.content).toContain('x = 1');
    });

    it('replace_in_file stages an edit based on the snapshot content', async () => {
        const context = await ctx();
        const r = await W.executeToolAsync('replace_in_file', { path: 'b.py', old_string: 'x = 1', new_string: 'x = 2' }, context);
        expect(r.success).toBe(true);
        expect(context.staging.get('b.py')).toBe('x = 2\n');
        expect(disk['b.py']).toBe('x = 1\n');   // disk untouched until the run commits
    });

    it('list_files shows snapshot files, staged files, and omits staged deletions', async () => {
        const context = await ctx();
        context.staging.set('new.py', 'y = 3\n');
        context.staging.set('a.py', null);
        const r = await W.executeToolAsync('list_files', {}, context);
        const names = r.files.map((f: any) => f.name).sort();
        expect(names).toEqual(['b.py', 'docs/readme.md', 'new.py']);
        expect(reads).not.toHaveBeenCalled();   // listing needs no content reads
    });
});
