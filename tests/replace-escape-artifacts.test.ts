// replace_in_file: double-encoded arguments and an off-by-a-few line window (SWE v0.70: 227 of 309
// calls failed; ~94 of the 202 "not found" carried literal \n / \" / \\ sequences).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../tools.ts';

const W = globalThis as any;
let files: Map<string, string>; let orig: any;
beforeEach(() => {
    files = new Map();
    orig = { r: W.agentReadFile, w: W.agentWriteFile, l: W.agentListFiles };
    W.agentReadFile = async (p: string) => { if (!files.has(p)) throw new Error(`File not found: ${p}`); return files.get(p); };
    W.agentWriteFile = async (p: string, c: string) => { files.set(p, c); };
    W.agentListFiles = async () => [...files.keys()].map(name => ({ name }));
});
afterEach(() => { W.agentReadFile = orig.r; W.agentWriteFile = orig.w; W.agentListFiles = orig.l; });
const rep = (args: any) => W.executeToolAsync('replace_in_file', args, null);

describe('replace_in_file escape artifacts', () => {
    it('reads literal \\n and \\" as newline and quote when that is the only way it matches', async () => {
        files.set('m.py', 'def f(x):\n    return "a" + x\n\ndef g():\n    pass\n');
        const r = await rep({ path: 'm.py',
            old_string: 'def f(x):\\n    return \\"a\\" + x',
            new_string: 'def f(x):\\n    return \\"b\\" + x' });
        expect(r.error).toBeUndefined();
        expect(files.get('m.py')).toBe('def f(x):\n    return "b" + x\n\ndef g():\n    pass\n');
        expect(r.note).toContain('escape sequences');
    });

    it('reads doubled backslashes in a multi-line string', async () => {
        files.set('l.py', 'x = 1\nreturn (r"\\left\\["\n      + y)\n');
        const r = await rep({ path: 'l.py', old_string: 'return (r"\\\\left\\\\["\n      + y)', new_string: 'return (r"\\\\left\\\\("\n      + y)' });
        expect(r.error).toBeUndefined();
        expect(files.get('l.py')).toBe('x = 1\nreturn (r"\\left\\("\n      + y)\n');
    });

    it('a legitimate \\n in the file still matches exactly, with no decoding', async () => {
        files.set('p.py', 'print("a\\n")\n');
        const r = await rep({ path: 'p.py', old_string: 'print("a\\n")', new_string: 'print("b\\n")' });
        expect(r.error).toBeUndefined();
        expect(files.get('p.py')).toBe('print("b\\n")\n');
        expect(r.note).not.toContain('escape sequences');
    });

    it('does not apply an ambiguous decoded match', async () => {
        files.set('d.py', 'a = "x"\nb = "x"\n');
        const r = await rep({ path: 'd.py', old_string: 'a = \\"x\\"\\nb = \\"x\\"', new_string: 'z' });
        expect(r.error).toBeUndefined();   // the two lines together are unique
        const r2 = await rep({ path: 'd.py', old_string: '= \\"x\\"', new_string: '= "y"' });
        expect(r2.error).toMatch(/not found/);
    });
});


describe('replace_in_file: the closest region is shown', () => {
    it('shows the lines old_string nearly matches, with their numbers', async () => {
        files.set('c.py', 'import os\n\ndef load(path):\n    with open(path) as f:\n        data = f.read()\n    return data.strip()\n\ndef other():\n    pass\n');
        const r = await rep({ path: 'c.py',
            old_string: 'def load(path):\n    with open(path, "r") as fh:\n        data = fh.read()\n    return data.strip()',
            new_string: 'x' });
        expect(r.error).toMatch(/not found/);
        expect(r.error).toMatch(/closest to your old_string is at lines 3–6/);
        expect(r.error).toContain('    with open(path) as f:');
    });
    it('says nothing when nothing is close', async () => {
        files.set('c.py', 'a = 1\nb = 2\n');
        const r = await rep({ path: 'c.py', old_string: 'completely different\ntext here entirely', new_string: 'x' });
        expect(r.error).toMatch(/not found/);
        expect(r.error).not.toMatch(/closest to your old_string/);
    });
});

describe('new_string decoding is narrowed (review 2026-10-14)', () => {
    it('keeps a source-level \\n in new_string that already has real newlines', async () => {
        files.set('n.py', 'def f(items):\n    return items\n');
        // old_string arrives double-escaped on one line; new_string is real multi-line code with a "\n" literal
        const r = await rep({ path: 'n.py',
            old_string: 'def f(items):\\n    return items',
            new_string: 'def f(items):\n    return "\\n".join(items)' });
        expect(r.error).toBeUndefined();
        expect(files.get('n.py')).toBe('def f(items):\n    return "\\n".join(items)\n');
    });
});
