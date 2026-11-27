// EV015-EV017: uniq groups by the comparison key like GNU, and takes INPUT [OUTPUT] operands.
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
const run = async (cmd: string) => { const r = await sh.exec(cmd); return { out: r.stdout, code: r.exitCode ?? 0 }; };
beforeAll(async () => { sh = await getShell(); });

describe('uniq', () => {
    it('keeps the first line of a group whose key is empty (EV015)', async () => {
        expect((await run("printf 'a\\nb\\nc\\n' | uniq -f1")).out).toBe('a\n');
        expect((await run("printf 'ab\\nac\\n' | uniq -s2")).out).toBe('ab\n');
    });
    it('compares what follows the skipped fields as written (EV016)', async () => {
        expect((await run("printf 'a x  y\\nb x y\\n' | uniq -f1")).out).toBe('a x  y\nb x y\n');
        expect((await run("printf '  a x\\nb x\\n' | uniq -f1")).out).toBe('  a x\n');
    });
    it('reads a file operand as text like stdin does, a leading BOM included', async () => {
        files.set('bom.txt', { content: '\uFEFFa\na\nb\n', encoding: null });
        expect((await run('uniq bom.txt')).out).toBe((await run('cat bom.txt | uniq')).out);
        expect((await run('uniq bom.txt')).out).toBe('\uFEFFa\na\nb\n');   // the BOM is part of the first line, as for GNU uniq
    });
    it('reads "-" as stdin and writes the second operand (EV017)', async () => {
        expect((await run("printf 'a\\na\\nb\\n' | uniq -")).out).toBe('a\nb\n');
        files.set('in.txt', { content: 'a\na\nb\n', encoding: null });
        const r = await run('uniq in.txt out.txt');
        expect(r.code).toBe(0);
        expect(files.get('out.txt')?.content).toBe('a\nb\n');
    });
});
