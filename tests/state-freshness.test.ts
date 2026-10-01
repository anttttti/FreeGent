// State between tool calls: whatever one call changes, the next call sees — through the caches in
// between (history's "already read" / "already listed" answers, Pyodide's imported modules, the
// shell's node module cache) and the state a runtime keeps from call to call (Python globals,
// shell variables, the working directory). On both backends (tests/tool-backends.ts); where they
// differ by design, the test says so.
import { truncateResultForHistory } from '../history';
import { BACKENDS } from './tool-backends';

const W = globalThis as any;
const tool = (name: string, args: any) => W.executeToolAsync(name, args);
const run = async (language: string, code: string) => {
    const r = await tool('execute_code', { language, code });
    if (r?.error || r?.exit_code) throw new Error(`${language}: ${JSON.stringify(r).slice(0, 400)}`);
    return String(r.stdout ?? '');
};
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// What the model gets back, after the history step that answers repeats with "already …".
let seen: { seenReadFiles: Map<string, any>; seenListFiles: Set<string> };
const forModel = async (name: string, args: any) => truncateResultForHistory(name, await tool(name, args), seen);
const listedNames = async (path = '') => {
    const r = await forModel('list_files', { path });
    return r.files ? r.files.map((f: any) => f.name) : r.note;
};

// Ways to change the workspace behind the file tools' back.
const CHANGERS: Record<string, { create: string[]; edit: string[]; remove: string[] }> = {
    bash:       { create: ['bash', 'echo new > d/new.txt'], edit: ['bash', "sed -i 's/one/ONE/' d/f.txt"], remove: ['bash', 'rm d/f.txt'] },
    python:     { create: ['python', 'open("d/new.txt", "w").write("new\\n")'], edit: ['python', 'p = "d/f.txt"; t = open(p).read(); open(p, "w").write(t.replace("one", "ONE"))'], remove: ['python', 'import os; os.remove("d/f.txt")'] },
    javascript: { create: ['javascript', 'require("fs").writeFileSync("d/new.txt", "new\\n")'], edit: ['javascript', 'const fs = require("fs"); fs.writeFileSync("d/f.txt", fs.readFileSync("d/f.txt", "utf8").replace("one", "ONE"))'], remove: ['javascript', 'require("fs").unlinkSync("d/f.txt")'] },
};

describe.each(BACKENDS)('$name', be => {
    beforeEach(async () => {
        await be.setup();
        seen = { seenReadFiles: new Map(), seenListFiles: new Set() };
        await W.agentWriteFile('d/f.txt', 'one\ntwo\n');
    }, 120_000);
    afterEach(() => be.teardown());

    describe('history answers repeats only while nothing changed', () => {
        it('an unchanged listing and an unchanged file are answered "already …"', async () => {
            expect(await listedNames('d')).toEqual(['d/f.txt']);
            expect(await listedNames('d')).toMatch(/Already listed "d" this session, and nothing has changed/);
            expect((await forModel('read_file', { path: 'd/f.txt' })).content).toBe('one\ntwo\n');
            expect((await forModel('read_file', { path: 'd/f.txt' })).note).toMatch(/Already read/);
        });

        it.each(Object.keys(CHANGERS))('a file %s creates shows in the next listing', async who => {
            expect(await listedNames('d')).toEqual(['d/f.txt']);
            await run(...(CHANGERS[who].create as [string, string]));
            expect(await listedNames('d')).toEqual(['d/f.txt', 'd/new.txt']);
        });

        it.each(Object.keys(CHANGERS))('a file %s deletes leaves the next listing', async who => {
            expect(await listedNames('')).toEqual(['d/f.txt']);
            await run(...(CHANGERS[who].remove as [string, string]));
            expect(await listedNames('')).toEqual([]);
        });

        it.each(Object.keys(CHANGERS))('an edit by %s is read fresh, even after the per-file read cap', async who => {
            for (let i = 0; i < 8; i++) await forModel('read_file', { path: 'd/f.txt' });
            await run(...(CHANGERS[who].edit as [string, string]));
            expect((await forModel('read_file', { path: 'd/f.txt' })).content).toBe('ONE\ntwo\n');
        });

        it('an edit by a file tool is read and listed fresh', async () => {
            await forModel('read_file', { path: 'd/f.txt' });
            await listedNames('d');
            await tool('write_file', { path: 'd/f.txt', content: 'changed\n' });
            await tool('write_file', { path: 'd/g.txt', content: 'g' });
            expect((await forModel('read_file', { path: 'd/f.txt' })).content).toBe('changed\n');
            expect(await listedNames('d')).toEqual(['d/f.txt', 'd/g.txt']);
        });
    });

    describe('code sees the current files', () => {
        it('a Python module edited between runs is imported fresh (file tool and bash edits)', async () => {
            await tool('write_file', { path: 'm.py', content: 'VALUE = 1\n' });
            expect(await run('python', 'import m\nprint(m.VALUE)')).toBe('1\n');
            await tool('write_file', { path: 'm.py', content: 'VALUE = 2\n' });
            expect(await run('python', 'import m\nprint(m.VALUE)')).toBe('2\n');
            await run('bash', "sed -i 's/2/3/' m.py");
            expect(await run('python', 'import m\nprint(m.VALUE)')).toBe('3\n');
            await run('bash', 'mkdir -p pkg && echo "X = 1" > pkg/mod.py');
            expect(await run('python', 'from pkg import mod\nprint(mod.X)')).toBe('1\n');
            await run('bash', 'echo "X = 2" > pkg/mod.py');
            expect(await run('python', 'from pkg import mod\nprint(mod.X)')).toBe('2\n');
            // and no bytecode left in the workspace
            expect((await W.agentListFiles()).map((f: any) => f.name).filter((n: string) => n.includes('__pycache__'))).toEqual([]);
        });

        it('python3 and node started from bash see edits between runs', async () => {
            await run('bash', 'echo "VALUE = 1" > m.py && echo "module.exports = 1" > m.js');
            expect(await run('bash', `python3 -c 'import m; print(m.VALUE)'; node -e 'console.log(require("./m.js"))'`)).toBe('1\n1\n');
            await run('bash', 'echo "VALUE = 2" > m.py && echo "module.exports = 2" > m.js');
            expect(await run('bash', `python3 -c 'import m; print(m.VALUE)'; node -e 'console.log(require("./m.js"))'`)).toBe('2\n2\n');
        });

        it('a file deleted by one tool is gone for the code of every other', async () => {
            await run('bash', 'rm d/f.txt');
            expect(await run('python', 'import os\nprint(os.path.exists("d/f.txt"))')).toBe('False\n');
            expect(await run('javascript', 'console.log(require("fs").existsSync("d/f.txt"))')).toBe('false\n');
            await W.agentWriteFile('d/f.txt', 'back');
            await tool('delete_file', { path: 'd/f.txt' });
            expect(await run('python', 'import os\nprint(os.path.exists("d/f.txt"))')).toBe('False\n');
            expect(await run('bash', '[ -e d/f.txt ] && echo there || echo gone')).toBe('gone\n');
        });
    });

    describe('what a runtime keeps from one call to the next', () => {
        it('every call starts in the workspace (Python os.chdir and bash cd do not carry over)', async () => {
            await run('python', 'import os\nos.chdir("d")');
            expect(await run('python', 'import os\nprint(os.getcwd())')).toBe(be.root() + '\n');
            await run('bash', 'cd d');
            expect(await run('bash', 'pwd')).toBe(be.root() + '\n');
            expect(await run('bash', `python3 -c 'import os; print(os.getcwd())'`)).toBe(be.root() + '\n');
        });

        it('Python names, imports, the environment and sys.path do not carry over', async () => {
            await run('python', 'import os, sys, json\nleftover = 42\nos.environ["FG_LEFT"] = "x"\nsys.path.append("/nowhere")');
            expect(await run('python', 'import os, sys\nprint(globals().get("leftover"), "json" in globals(), os.environ.get("FG_LEFT"), "/nowhere" in sys.path)'))
                .toBe('None False None False\n');
        });

        it('shell variables, functions, aliases and options do not carry over', async () => {
            await run('bash', 'export FG_TEST_VAR=kept; f() { echo fn; }; alias ll="ls -l"; set -e');
            expect(await run('bash', 'echo "${FG_TEST_VAR:-unset}"; type f >/dev/null 2>&1 && echo has-f || echo no-f; alias ll >/dev/null 2>&1 && echo has-alias || echo no-alias; false; echo after-false'))
                .toBe('unset\nno-f\nno-alias\nafter-false\n');
        });

        it('files do carry over: the workspace and /tmp', async () => {
            await run('bash', 'echo w > w.txt; echo t > /tmp/fg-carry.txt');
            expect(await run('bash', 'cat w.txt /tmp/fg-carry.txt; rm /tmp/fg-carry.txt')).toBe('w\nt\n');
        });

        it('python3 started from bash gets fresh names every run', async () => {
            await run('bash', `python3 -c 'leftover = 1'`);
            expect(await run('bash', `python3 -c 'print("leftover" in globals())'`)).toBe('False\n');
        });
    });
});
