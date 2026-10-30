// codex R279-R284: mv -n overwrote, mv to a missing "dir/" renamed, cp -r into itself never ended, rm -f hid real failures, rm -- was not
// understood, and a directory move that failed half-way left a split tree that could not be moved again.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const files = vi.hoisted(() => new Map<string, { content: string; encoding: string | null }>());
const failWrite = vi.hoisted(() => ({ path: '', del: '' }));
vi.mock('../workspace', () => ({
    agentWriteFile:    async (name: string, content: string, encoding: string | null = null) => { if (name === failWrite.path) throw new Error('QuotaExceededError'); files.set(name, { content, encoding }); },
    agentDeleteFile:   async (name: string) => { if (name === failWrite.del) throw new Error('NotAllowedError: the folder refused'); files.delete(name); },
    agentListFiles:    async () => [...files.keys()].map(name => ({ name })),
    readWorkspaceFile: async (name: string) => files.has(name) ? { name, ...files.get(name)! } : null,
}));
import { getShell } from '../shiro/shell-singleton';

let sh: any;
const run = async (cmd: string) => { const r = await sh.exec(cmd); return { out: r.stdout.replace(/\r\n/g, '\n'), err: r.stderr.replace(/\r\n/g, '\n'), code: r.exitCode ?? 0 }; };
const text = (p: string) => files.get(p)?.content;
beforeAll(async () => { sh = await getShell(); });
beforeEach(async () => { files.clear(); failWrite.path = ''; failWrite.del = ''; });

describe('mv', () => {
    it('-n keeps an existing destination (R280)', async () => {
        files.set('a.txt', { content: 'A', encoding: null }); files.set('b.txt', { content: 'B', encoding: null });
        expect((await run('mv -n a.txt b.txt')).code).toBe(0);
        expect(text('b.txt')).toBe('B');
        expect(text('a.txt')).toBe('A');
    });
    it('to a missing "dir/" fails instead of renaming (R281)', async () => {
        files.set('a.txt', { content: 'A', encoding: null });
        const r = await run('mv a.txt missing/');
        expect(r.code).toBe(1);
        expect(r.err).toMatch(/Not a directory/);
        expect(text('a.txt')).toBe('A');
    });
    it('a directory move that fails half-way leaves the source whole and can be retried (R279)', async () => {
        for (const n of ['1', '2', '3']) files.set(`src/f${n}.txt`, { content: n, encoding: null });
        failWrite.path = 'dst/f2.txt';
        expect((await run('mv src dst')).code).not.toBe(0);
        expect(['src/f1.txt', 'src/f2.txt', 'src/f3.txt'].every(p => files.has(p))).toBe(true);
        expect([...files.keys()].some(k => k.startsWith('dst/'))).toBe(false);
        failWrite.path = '';
        expect((await run('mv src dst')).code).toBe(0);
        expect(['dst/f1.txt', 'dst/f2.txt', 'dst/f3.txt'].every(p => files.has(p))).toBe(true);
    });
});

describe('cp -r into itself (R282)', () => {
    it('is refused, and nothing is copied', async () => {
        files.set('dir/x.txt', { content: 'x', encoding: null });
        const r = await run('cp -r dir dir/sub');
        expect(r.code).toBe(1);
        expect(r.err).toMatch(/into itself/);
        expect([...files.keys()]).toEqual(['dir/x.txt']);
    });
});

describe('rm', () => {
    it('honours -- before a name that starts with a dash (R284)', async () => {
        files.set('-file', { content: 'x', encoding: null });
        expect((await run('rm -- -file')).code).toBe(0);
        expect(files.has('-file')).toBe(false);
        expect((await run('rm')).err).toMatch(/missing operand/);
    });
    it('-f still reports a failure that is not "no such file" (R283)', async () => {
        files.set('keep/a.txt', { content: 'a', encoding: null });
        failWrite.del = 'keep/a.txt';
        const r = await run('rm -rf keep');
        expect(r.code).toBe(1);
        expect(r.err).toMatch(/cannot remove 'keep'.*refused/);
        expect((await run('rm -f nothing-here.txt')).code).toBe(0);
    });
});
