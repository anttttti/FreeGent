// Paths across the tools: every way of naming a workspace file — "a/b.txt", "./a/b.txt",
// "/workspace/a/b.txt", "a//b.txt", "x/../a/b.txt" — reaches the same workspace file, whether the
// file tools, the shell (bash, python3, node), execute_code Python or execute_code JavaScript use
// it, and nothing makes a stray /workspace/workspace/ or a file named "../x". Writes into a
// directory that doesn't exist fail as they do in bash, Python and Node instead of creating it.
// Runs on the real workspace (fake IndexedDB) and a real Pyodide. The shell, Python and Node
// sides are also compared with the real tools by scripts/shell-diff.sh and scripts/exec-diff.sh.
import { IDBFactory } from 'fake-indexeddb';
import { workspaceName, setWorkspaceAdapter } from '../workspace';
import { NodeFsAdapter } from '../node-fs-adapter';
import { _normToolPath } from '../tools';
import { getShell, resetShell } from '../shiro/shell-singleton';
import { __setPyodideForTest } from '../shiro/commands/python';
import { runInPyodide, encodeInputFile, decodeOutputFile } from '../pyodide-run';
import { runJs } from '../exec-sandbox/js-run';
import { loadNodePyodide } from './parity-utils';

const W = globalThis as any;
const names = async () => (await W.agentListFiles()).map((f: any) => f.name).sort();

let py: any;
beforeAll(async () => { py = await loadNodePyodide(); }, 60_000);
beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    await W.initDB();
    W.mainAgentRole = null;
    resetShell();
    __setPyodideForTest(py);
});
afterEach(() => setWorkspaceAdapter(null));

// ── names ─────────────────────────────────────────────────────────────────────

describe('workspaceName', () => {
    it.each([
        ['a/b.txt', 'a/b.txt'], ['./a/b.txt', 'a/b.txt'], ['/workspace/a/b.txt', 'a/b.txt'],
        ['/a/b.txt', 'a/b.txt'], ['a//b.txt', 'a/b.txt'], ['a/./b.txt', 'a/b.txt'],
        ['x/../a/b.txt', 'a/b.txt'], ['./x/./../a//b.txt', 'a/b.txt'], ['a/b/', 'a/b'],
        ['/workspace', ''], ['/workspace/', ''], ['.', ''], ['workspace/a.txt', 'workspace/a.txt'],
        ['/workspacefoo/a', 'workspacefoo/a'],
    ])('%s → %s', (p, want) => expect(workspaceName(p)).toBe(want));

    it.each(['../x', '/workspace/../etc/passwd', 'a/../../x'])('refuses %s (outside the workspace)', p =>
        expect(() => workspaceName(p)).toThrow(/outside the workspace/));
});

describe('_normToolPath', () => {
    it('normalizes like workspaceName, and leaves a path outside the workspace for the tool to refuse', () => {
        expect(_normToolPath('/workspace/x/../a//b.txt')).toBe('a/b.txt');
        expect(_normToolPath('./a/./b.txt')).toBe('a/b.txt');
        expect(_normToolPath('../x')).toBe('../x');
    });
});

describe('NodeFsAdapter (headless) stays inside its root', () => {
    const a = new NodeFsAdapter('/tmp/fg-root') as any;
    it('maps the root, its absolute paths and relative ones inside it', () => {
        expect(a._resolve('x/y.txt')).toBe('/tmp/fg-root/x/y.txt');
        expect(a._resolve('/tmp/fg-root/x/y.txt')).toBe('/tmp/fg-root/x/y.txt');
        expect(a._resolve('/tmp/fg-root')).toBe('/tmp/fg-root');
    });
    it('refuses a sibling directory that shares the prefix, and climbing out', () => {
        expect(() => a._resolve('/tmp/fg-root2/x')).toThrow(/absolute container path/);
        expect(() => a._resolve('../fg-root2/x')).toThrow(/escapes workspace/);
    });
});

// ── the same file from every tool ─────────────────────────────────────────────

describe('file tools', () => {
    it.each(['a/b.txt', './a/b.txt', '/workspace/a/b.txt', '/a/b.txt', 'a//b.txt', 'a/./b.txt'])(
        'write_file %s → a/b.txt, readable by every form', async p => {
            expect((await W.executeToolAsync('write_file', { path: p, content: 'v\n' })).error).toBeUndefined();
            expect(await names()).toEqual(['a/b.txt']);
            for (const q of ['a/b.txt', '/workspace/a/b.txt', './a//b.txt'])
                expect((await W.executeToolAsync('read_file', { path: q })).content ?? '').toContain('v');
        });

    it('write_file "workspace/app.js" means the workspace root unless there is a workspace folder', async () => {
        await W.executeToolAsync('write_file', { path: 'workspace/app.js', content: '1' });
        expect(await names()).toEqual(['app.js']);
        await W.agentWriteFile('workspace/keep.txt', 'k');
        await W.executeToolAsync('write_file', { path: 'workspace/app2.js', content: '2' });
        expect(await names()).toEqual(['app.js', 'workspace/app2.js', 'workspace/keep.txt']);
    });

    it('append_file, replace_in_file and delete_file name the same file', async () => {
        await W.executeToolAsync('write_file', { path: '/workspace/n.txt', content: 'one\n' });
        await W.executeToolAsync('append_file', { path: './n.txt', content: 'two\n' });
        await W.executeToolAsync('replace_in_file', { path: '/workspace/./n.txt', old_string: 'one', new_string: 'ONE' });
        expect(await W.agentReadFile('n.txt')).toBe('ONE\ntwo\n');
        await W.executeToolAsync('delete_file', { path: '/workspace//n.txt' });
        expect(await names()).toEqual([]);
    });

    it('refuses ".." paths (the intent check blocks them before the tool runs) and stores nothing', async () => {
        for (const path of ['../x.txt', 'x/../a/b.txt']) {
            const r = await W.executeToolAsync('write_file', { path, content: 'x' });
            expect(String(r.error ?? r)).toMatch(/BLOCKED|outside the workspace/);
        }
        expect(await names()).toEqual([]);
    });
});

describe('shell (bash, python3, node)', () => {
    const sh = async (cmd: string) => (await getShell()).exec(cmd);

    it('starts in /workspace, and every path form reaches the workspace file', async () => {
        await W.agentWriteFile('a/b.txt', 'v\n');
        expect((await sh('pwd')).stdout).toBe('/workspace\n');
        // (x/../a/b.txt resolves lexically here; bash would first need x to exist.)
        expect((await sh('cat a/b.txt ./a//b.txt /workspace/a/./b.txt x/../a/b.txt')).stdout).toBe('v\n'.repeat(4));
        await sh('echo 1 > ./a/c.txt; echo 2 > /workspace/a//d.txt; cd a && echo 3 > ../e.txt && echo 4 > f.txt; cd /workspace');
        expect(await names()).toEqual(['a/b.txt', 'a/c.txt', 'a/d.txt', 'a/f.txt', 'e.txt']);
    });

    it('fails a write into a missing directory, as bash does, instead of creating it', async () => {
        const r = await sh('echo x > workspace/app.js; echo "rc=$?"; cp a.txt nodir/ 2>/dev/null; echo "rc=$?"');
        expect(r.stdout).toBe('rc=1\nrc=1\n');
        expect(await names()).toEqual([]);
    });

    it('python3 runs in the same /workspace: cwd, __file__ and written paths', async () => {
        await W.agentWriteFile('src/s.py', 'import os\nprint(os.getcwd(), os.path.abspath(__file__))\nopen("../p1.txt", "w").write("1")\n');
        expect((await sh('cd src && python3 s.py; cd /workspace')).stdout).toBe('/workspace/src /workspace/src/s.py\n');
        await sh(`python3 -c 'import os; open("/workspace/p2.txt", "w").write("2"); os.makedirs("d/e"); open(os.path.join(os.getcwd(), "d", "e", "p3.txt"), "w").write("3")'`);
        expect(await names()).toEqual(['d/e/p3.txt', 'p1.txt', 'p2.txt', 'src/s.py']);
    });

    it('node: cwd, written paths, and ENOENT for a missing directory', async () => {
        const r = await sh(`node -e 'const fs = require("fs"), path = require("path"); console.log(process.cwd()); fs.writeFileSync("/workspace/n1.txt", "1"); fs.writeFileSync(path.join(process.cwd(), "n2.txt"), "2"); try { fs.writeFileSync("nodir/x", "x") } catch (e) { console.log(e.code) }'`);
        expect(r.stdout).toBe('/workspace\nENOENT\n');
        expect(await names()).toEqual(['n1.txt', 'n2.txt']);
    });
});

describe('execute_code Python and JavaScript', () => {
    it('Python: every path form names the workspace file; missing directories raise', async () => {
        await W.agentWriteFile('a/b.txt', 'v\n');
        const files = Object.fromEntries((await W.listWorkspaceFiles()).map((r: any) => [r.name, encodeInputFile(r)]));
        const r = await runInPyodide(py, { files, code: [
            'import os',
            'print(os.getcwd(), open("/workspace/a/b.txt").read() == open("./a//b.txt").read())',
            'open("a/./c.txt", "w").write("1")',
            'open("/workspace/a/../d.txt", "w").write("2")',
            'open(os.path.join(os.getcwd(), "a", "e.txt"), "w").write("3")',
            'try:\n    open("workspace/x.txt", "w")\nexcept FileNotFoundError:\n    print("ENOENT")',
        ].join('\n') });
        expect(r.stdout).toBe('/workspace True\nENOENT\n');
        expect(Object.keys(r.changedFiles).sort()).toEqual(['a/c.txt', 'a/e.txt', 'd.txt']);
        for (const [n, c] of Object.entries(r.changedFiles)) await W.agentWriteFile(n, decodeOutputFile(c!).data);
        expect(await names()).toEqual(['a/b.txt', 'a/c.txt', 'a/e.txt', 'd.txt']);
    });

    it('JavaScript: every path form names the workspace file; missing directories throw ENOENT', async () => {
        const r: any = await runJs([
            'const fs = require("fs"), path = require("path");',
            'console.log(process.cwd(), fs.readFileSync("/workspace/a/b.txt", "utf8") === fs.readFileSync("./a//b.txt", "utf8"));',
            'fs.writeFileSync("a/./c.txt", "1");',
            'fs.writeFileSync("/workspace/a/../d.txt", "2");',
            'fs.writeFileSync(path.join(process.cwd(), "a", "e.txt"), "3");',
            'try { fs.writeFileSync("workspace/x.txt", "x"); } catch (e) { console.log(e.code); }',
        ].join('\n'), { 'a/b.txt': 'v\n' });
        expect(r.stdout).toBe('/workspace true\nENOENT\n');
        expect(Object.keys(r.written).sort()).toEqual(['a/c.txt', 'a/e.txt', 'd.txt']);
    });
});
