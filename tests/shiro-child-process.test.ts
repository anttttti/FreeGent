// The browser shell's child_process: a child gets its own working directory and its arguments reach it literally (explorations D024, D025).
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
beforeAll(async () => {
    files.set('control.txt', { content: 'parent', encoding: null });
    files.set('sub/control.txt', { content: 'child', encoding: null });
    sh = await getShell();
});
const runNode = async (body: string): Promise<any> => {
    files.set('t.js', { content: `const cp = require('child_process'); const { promisify } = require('util');\n(async () => { const out = []; ${body}; console.log(JSON.stringify(out)); })();`, encoding: null });
    return JSON.parse((await sh.exec('node t.js')).stdout);
};

describe('child_process in the browser shell', () => {
    it('applies cwd in every API and leaves the parent\'s directory alone', async () => {
        expect(await runNode(`
            out.push(String(await cp.execFileSync('cat', ['control.txt'], { cwd: 'sub' })));
            out.push(String(await cp.execSync('cat control.txt', { cwd: 'sub' })));
            out.push((await promisify(cp.execFile)('cat', ['control.txt'], { cwd: 'sub' })).stdout);
            out.push(String(await cp.execSync('cat control.txt')));   // after the children: still the parent's directory
        `)).toEqual(['child', 'child', 'child', 'parent']);
    });
    it('passes arguments literally: spaces, an apostrophe, a $ sign; echo\'s own flag is the shell\'s to handle', async () => {
        expect(await runNode(`
            out.push(String(await cp.execFileSync('echo', ['a b', 'c d'])));
            out.push(String(await cp.execFileSync('echo', ["it's"])));
            out.push(String(await cp.execFileSync('echo', ['$FG_UNSET_VALUE'])));
            out.push(String(await cp.execFileSync('echo', ['-n', 'x'])) + '|');
        `)).toEqual(['a b c d\n', "it's\n", '$FG_UNSET_VALUE\n', 'x|']);
    });
});
