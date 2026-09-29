// The browser shell (shiro/shell-singleton.ts) as the agent gets it: the commands the bash
// guidance promises are registered and run, against an in-memory workspace.
import { describe, it, expect, vi, beforeAll } from 'vitest';

const files = vi.hoisted(() => new Map<string, { content: string; encoding: string | null }>());
vi.mock('../workspace', () => ({
    agentWriteFile:    async (name: string, content: string, encoding: string | null = null) => { files.set(name, { content, encoding }); },
    agentDeleteFile:   async (name: string) => { files.delete(name); },
    agentListFiles:    async () => [...files.keys()].map(name => ({ name })),
    readWorkspaceFile: async (name: string) => files.has(name) ? { name, ...files.get(name)! } : null,
}));

import { getShell } from '../shiro/shell-singleton';

let sh: any;
// Line endings normalised as exec-sandbox/entry.ts does (shell.exec returns terminal output).
const run = async (cmd: string) => {
    const r = await sh.exec(cmd);
    const lf = (s: string) => s.replace(/\r\n/g, '\n');
    return { out: lf(r.stdout), err: lf(r.stderr), code: r.exitCode ?? 0 };
};

beforeAll(async () => {
    files.set('a.txt', { content: 'one\ntwo\nthree\n', encoding: null });
    files.set('b.txt', { content: 'one\nTWO\nthree\n', encoding: null });
    files.set('data.json', { content: '{"items":[{"n":1},{"n":2}]}', encoding: null });
    sh = await getShell();
});

describe('browser shell commands', () => {
    it('registers every command the guidance lists', async () => {
        for (const c of ['curl', 'wget', 'npm', 'npx', 'diff', 'jq', 'rg', 'gzip', 'gunzip', 'mktemp',
                         'grep', 'sed', 'awk', 'find', 'sort', 'tar', 'xargs', 'python3', 'node'])
            expect((await run(`type ${c}`)).code, c).toBe(0);
    });

    it('diff', async () => {
        const r = await run('diff /workspace/a.txt /workspace/b.txt');
        expect(r.code).toBe(1);
        expect(r.out).toMatch(/two/);
        expect(r.out).toMatch(/TWO/);
    });

    it('jq', async () => {
        expect((await run("jq '.items[].n' /workspace/data.json")).out.trim()).toBe('1\n2');
    });

    it('rg', async () => {
        expect((await run('rg -n thr /workspace/a.txt')).out).toMatch(/3:three/);
    });

    it('gzip round trip', async () => {
        const r = await run('cp /workspace/a.txt /workspace/c.txt && gzip /workspace/c.txt && gunzip -c /workspace/c.txt.gz');
        expect(r.out).toBe('one\ntwo\nthree\n');
    });

    it('mktemp', async () => {
        const r = await run('mktemp');
        expect(r.code).toBe(0);
        expect(r.out.trim()).toMatch(/tmp\./);
    });
});
