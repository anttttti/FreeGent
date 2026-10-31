// edit_assist (experiment): replace_in_file's old_string/new_string edits helped from the text alone — a close match where the
// model has seen the text, an edit already made, a repeated boundary line, an edit that would break parsing.
import { _resetSeenForTest, assistLocate } from '../edit-assist.ts';

const W = globalThis as any;
let files: Map<string, string>;
let saved: any;

beforeEach(() => {
    files = new Map();
    saved = { read: W.agentReadFile, write: W.agentWriteFile, env: process.env.FG_EXPERIMENTS };
    W.agentReadFile = async (p: string) => { if (!files.has(p)) throw new Error(`File not found: ${p}`); return files.get(p); };
    W.agentWriteFile = async (p: string, c: string) => { files.set(p, c); };
    process.env.FG_EXPERIMENTS = 'edit_assist';
    _resetSeenForTest();
});
afterEach(() => {
    W.agentReadFile = saved.read; W.agentWriteFile = saved.write;
    if (saved.env === undefined) delete process.env.FG_EXPERIMENTS; else process.env.FG_EXPERIMENTS = saved.env;
});

const SRC = ['def f(x):', '    if x is None:', '        return 0', '    y = x * 2', '    return y + 1', ''].join('\n');
const run = (name: string, args: any) => W.executeToolAsync(name, args, null);

describe('edit_assist', () => {
    it('makes a misremembered edit where the model read the text, keeping the file\'s own lines it did not change', async () => {
        files.set('a.py', SRC);
        await run('read_file', { path: 'a.py' });
        const r = await run('replace_in_file', { path: 'a.py',
            old_string: 'def f(x):\n    if x == None:\n        return 0\n    y = x * 2',
            new_string: 'def f(x):\n    if x == None:\n        return -1\n    y = x * 2' });
        expect(r.success).toBe(true);
        expect(r.note).toMatch(/most nearly matches lines 1–4 \(1 of its lines differ/);
        // Line 2 was kept by the edit: the file's "is None", not the model's "== None".
        expect(files.get('a.py')).toBe(SRC.replace('return 0', 'return -1'));
    });

    it('does not guess where the model has not seen the text, and the tool schema is unchanged', async () => {
        files.set('a.py', SRC);
        const r = await run('replace_in_file', { path: 'a.py', old_string: 'def f(x):\n    if x == None:\n        return 0', new_string: 'def f(x):\n    return 1' });
        expect(r.error).toMatch(/old_string not found/);
        expect(files.get('a.py')).toBe(SRC);
    });

    it('needs one clear region: two equally close ones are no match', () => {
        const lines = ['a = compute(1)', 'b = a + 1', 'x', 'a = compute(2)', 'b = a + 1'];
        expect(assistLocate(lines, 'a = compute(3)\nb = a + 1', 'a = compute(3)\nb = a + 2')).toBeNull();
    });

    it('keeps a line of the file the old_string left out', () => {
        const lines = ['    a = 1', '    log("x")', '    b = 2', '    return a + b'];
        const hit = assistLocate(lines, '    a = 1\n    b = 2\n    return a + b', '    a = 1\n    b = 3\n    return a + b')!;
        expect(hit.out).toEqual(['    a = 1', '    log("x")', '    b = 3', '    return a + b']);
    });

    it('does not double a line of an earlier edit that a stale old_string leaves out and new_string inserts', () => {
        const lines = ['    def __init__(self, a=1,', '                 b=None,', '                 c=False):', '        self.b = b'];
        const hit = assistLocate(lines, '    def __init__(self, a=1,\n                 b=None):\n        self.b = b',
            '    def __init__(self, a=1,\n                 b=None,\n                 c=False):\n        self.b = b\n        self.c = c')!;
        expect(hit.out).toEqual([...lines, '        self.c = c']);
    });

    it('re-indents new_string by the one shift between old_string and the file', () => {
        const lines = ['class A:', '    def g(self):', '        if ok:', '            go()', '        stop()'];
        const hit = assistLocate(lines, 'if ok:\n    go()\nstop()', 'if ok:\n    go()\n    again()\nstop()')!;
        expect(hit.out).toEqual(['        if ok:', '            go()', '            again()', '        stop()']);
    });

    it('says when new_string is already in the file, then refuses a repeat', async () => {
        files.set('a.py', SRC);
        const args = { path: 'a.py', old_string: '    if x is False:\n        return 0', new_string: '    if x is None:\n        return 0' };
        const first = await run('replace_in_file', args);
        expect(first).toMatchObject({ success: true, replacements_made: 0 });
        expect(first.note).toMatch(/already stands at line 2/);
        expect((await run('replace_in_file', args)).error).toMatch(/sent twice/);
    });

    it('takes old_string equal to new_string, when the file has it, as nothing to change', async () => {
        files.set('a.py', SRC);
        const r = await run('replace_in_file', { path: 'a.py', old_string: '    y = x * 2', new_string: '    y = x * 2' });
        expect(r).toMatchObject({ success: true, replacements_made: 0 });
        expect(r.note).toMatch(/line 4: there is nothing to change/);
    });

    it('drops a repeat of the line just above the replaced lines, and says where the change is', async () => {
        files.set('a.py', SRC);
        const r = await run('replace_in_file', { path: 'a.py', old_string: '    y = x * 2\n', new_string: '        return 0\n    y = x * 3\n' });
        expect(r.success).toBe(true);
        expect(r.note).toMatch(/Change applied at lines 4–4\. new_string began with line 3/);
        expect(files.get('a.py')).toBe(SRC.replace('x * 2', 'x * 3'));
    });

    it('refuses an edit that leaves a parsing file unparseable, and reads over-escaped quotes once', async () => {
        const js = 'function f(a) {\n  if (a) {\n    return "x";\n  }\n  return "y";\n}\n';
        files.set('a.js', js);
        const broken = await run('replace_in_file', { path: 'a.js', old_string: '  if (a) {\n    return "x";', new_string: '  if (a) {\n    return "z";\n  }\n  }' });
        expect(broken.error).toMatch(/would leave "a\.js" unparseable/);
        expect(files.get('a.js')).toBe(js);
        const esc = await run('replace_in_file', { path: 'a.js', old_string: '    return "x";', new_string: '    return \\"z\\";' });
        expect(esc.success).toBe(true);
        expect(esc.note).toMatch(/over-escaped/);
        expect(files.get('a.js')).toContain('    return "z";');
    });

    it('takes old_string equal to new_string at another indentation as nothing to change, and shows the lines', async () => {
        files.set('a.py', SRC);
        const r = await run('replace_in_file', { path: 'a.py', old_string: '        y = x * 2\n        return y + 1', new_string: '        y = x * 2\n        return y + 1' });
        expect(r).toMatchObject({ success: true, replacements_made: 0 });
        expect(r.note).toMatch(/lines 4–5 read like that \(at another indentation\): there is nothing to change/);
        expect(r.note).toMatch(/The lines now:\nL3:         return 0\nL4:     y = x \* 2\nL5:     return y \+ 1/);
    });

    it('tells two equal regions apart by the line range the model gave', () => {
        const block = ['        hint=(', "            'use ForeignKey(\"%s\").'", '        ) % (', '            NAME,', '        ),'];
        const lines = ['def a():', ...block, 'x = 1', 'y = 2', 'z = 3', 'def b():', ...block];
        const old = block.map(l => '    ' + l).join('\n'), neu = old.replace('ForeignKey', 'ManyToManyField');
        expect(assistLocate(lines, old, neu)).toBeNull();
        const hit = assistLocate(lines, old, neu, { s: 12, e: 16 })!;
        expect([hit.s, hit.e]).toEqual([11, 15]);
        expect(hit.out[1]).toBe("            'use ManyToManyField(\"%s\").'");
        expect(assistLocate(lines, old, neu, { s: 2, e: 4 })!.s).toBe(2);
    });

    it('reads an old_string sent with escaped line breaks as lines, and says so', async () => {
        files.set('a.py', SRC);
        await run('read_file', { path: 'a.py' });
        const r = await run('replace_in_file', { path: 'a.py', old_string: '    if x == None:\\n        return 0\\n    y = x * 2', new_string: '    if x == None:\\n        return -1\\n    y = x * 2' });
        expect(r.success).toBe(true);
        expect(r.note).toMatch(/held escaped line breaks/);
        expect(files.get('a.py')).toBe(SRC.replace('return 0', 'return -1'));
    });

    it('says "except for indentation" when that is the only difference', async () => {
        files.set('a.py', SRC);
        await run('read_file', { path: 'a.py' });
        const r = await run('replace_in_file', { path: 'a.py', old_string: '        y = x * 2\n        return y + 1', new_string: '        y = x * 3\n        return y + 1' });
        expect(r.note).toMatch(/it matches lines 4–5 except for indentation, so the change was made there with new_string re-indented/);
        expect(files.get('a.py')).toBe(SRC.replace('x * 2', 'x * 3'));
    });

    it('shows the lines as they stand when a change already in the file is sent again', async () => {
        files.set('a.py', SRC);
        const args = { path: 'a.py', old_string: '    if x is not None:\n        return 0\n', new_string: '    if x is None:\n        return 0\n' };
        expect((await run('replace_in_file', args)).note).toMatch(/The lines now:\nL1: def f\(x\):\nL2:     if x is None:\nL3:         return 0\nL4:/);
        expect((await run('replace_in_file', args)).error).toMatch(/sent twice[\s\S]*The lines now:\nL1: def f/);
    });

    it('counts text the model wrote as seen: a misremembered edit of its own file is placed', async () => {
        expect((await run('write_file', { path: 'b.py', content: SRC })).success).toBe(true);
        const r = await run('replace_in_file', { path: 'b.py',
            old_string: 'def f(x):\n    if x == None:\n        return 0\n    y = x * 2', new_string: 'def f(x):\n    if x == None:\n        return -1\n    y = x * 2' });
        expect(r.error ?? '').toBe('');
        expect(files.get('b.py')).toBe(SRC.replace('return 0', 'return -1'));
    });

    it('is off without the experiment: old_string equal to new_string is the usual error', async () => {
        delete process.env.FG_EXPERIMENTS;
        files.set('a.py', SRC);
        expect((await run('replace_in_file', { path: 'a.py', old_string: '    y = x * 2', new_string: '    y = x * 2' })).error).toMatch(/identical/);
    });
});
