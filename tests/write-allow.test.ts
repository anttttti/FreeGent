// fg-run --write-allow: the file-writing tools may only touch the listed paths.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { parseWriteAllow, setWriteAllow, checkWriteAllowed, isWriteAllowActive } from '../write-allow.ts';

const W: any = window;
beforeAll(async () => { await import('../tools.ts'); });
afterEach(() => setWriteAllow(null));

describe('parseWriteAllow / checkWriteAllowed', () => {
    it('normalises entries and matches a directory or an exact file, not a sibling with the same prefix', () => {
        setWriteAllow(parseWriteAllow('out/, ./notes/report.md,/workspace/tmp'));
        expect(isWriteAllowActive()).toBe(true);
        for (const ok of ['out/a.ts', 'out/deep/b.txt', 'notes/report.md', 'tmp/x', './out/c']) expect(checkWriteAllowed('write_file', ok), ok).toBeNull();
        for (const bad of ['storage-usage.ts', 'outside/a.ts', 'notes/report.md.bak', 'out/../storage-usage.ts', '', undefined]) {
            expect(checkWriteAllowed('write_file', bad), String(bad)).toMatch(/outside the paths this run may write\. Allowed: out, notes\/report\.md, tmp/);
        }
    });
    it('refuses a list that is empty or tries to climb out', () => {
        expect(() => parseWriteAllow(' , ')).toThrow(/no paths/);
        expect(() => parseWriteAllow('out/../src')).toThrow(/\.\./);
    });
    it('no list: everything is allowed', () => {
        setWriteAllow(null);
        expect(checkWriteAllowed('write_file', 'anything/at/all')).toBeNull();
    });
});

describe('the tools obey it', () => {
    let files: Map<string, string>;
    beforeEach(() => {
        W.mainAgentRole = null; files = new Map();
        W.agentWriteFile = async (p: string, c: string) => { files.set(p, c); };
        W.agentReadFile = async (p: string) => { if (!files.has(p)) throw new Error('File not found: ' + p); return files.get(p); };
        W.agentListFiles = async () => [...files.keys()].map(name => ({ name }));
        W.agentDeleteFile = async (p: string) => { files.delete(p); };
    });
    const run = (name: string, args: any) => W.executeToolAsync(name, args, null);
    it('write_file, append_file, delete_file and apply_patch outside the list are refused and write nothing; inside they work', async () => {
        files.set('storage-usage.ts', 'ORIGINAL');
        setWriteAllow(parseWriteAllow('out/'));
        for (const [tool, args] of [['write_file', { path: 'storage-usage.ts', content: 'X' }], ['append_file', { path: 'storage-usage.ts', content: 'X' }],
            ['delete_file', { path: 'storage-usage.ts' }], ['apply_patch', { patch: '--- a/storage-usage.ts\n+++ b/storage-usage.ts\n@@ -1 +1 @@\n-ORIGINAL\n+X\n' }]] as const) {
            const r = await run(tool, args);
            expect(r.error, tool).toMatch(/outside the paths this run may write/);
        }
        expect(files.get('storage-usage.ts')).toBe('ORIGINAL');
        const ok = await run('write_file', { path: 'out/report.md', content: 'hi' });
        expect(ok.error).toBeUndefined();
        expect(files.get('out/report.md')).toBe('hi');
    });
});
