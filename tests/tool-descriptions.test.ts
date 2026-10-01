// What the tool descriptions and the system prompt tell the model, checked against what the tools
// do. Each test quotes a claim — it must still be in the text the model gets — and then checks it,
// so a change to either the wording or the behaviour shows up here. Browser workspace with the
// WASM shell and Pyodide (tests/fake-sandbox.ts), as a default browser session runs.
import { setupBrowserTools } from './fake-sandbox';
import { LazySnapshot } from '../workers';

const W = globalThis as any;
const tool = (name: string, args: any, ctx: any = null) => W.executeToolAsync(name, args, ctx);
const run = async (language: string, code: string) => {
    const r = await tool('execute_code', { language, code });
    if (r?.error) throw new Error(`${language}: ${r.error}`);
    return r;
};

/** The description of a tool, or of one of its parameters, as the model gets it. */
function described(name: string, param?: string): string {
    W.enabledTools.add(name);   // the write tools are opt-in
    const spec = W.activeTools(false, new Set([name]), true).map((t: any) => t.function ?? t).find((t: any) => t.name === name);
    if (!spec) throw new Error(`no tool ${name}`);
    return param ? String(spec.parameters?.properties?.[param]?.description ?? '') : String(spec.description ?? '');
}
// The system prompt's workspace and languages sections (system-prompt.ts), as the browser session builds them.
const prompt = () => `${W._buildWorkspaceDesc()}\n${W._buildLangsDesc()}`;
/** The claim must be in the text, word for word. */
const claims = (text: string, claim: string) => expect(text, `claim: ${claim}`).toContain(claim);

beforeEach(setupBrowserTools, 120_000);

describe('execute_code', () => {
    it('"bash: a browser shell … built-in versions of the usual Unix tools (…)": each one listed is there', async () => {
        const d = described('execute_code');
        expect(d).not.toMatch(/musl|x86/);   // it is not a real Linux userland
        const listed = d.match(/built-in versions of the usual Unix tools \(([^)]*)\)/)?.[1];
        expect(listed, 'the description lists the tools').toBeTruthy();
        const names = listed!.split(',').map(s => s.trim()).filter(s => /^[\w-]+$/.test(s));
        expect(names.length).toBeGreaterThan(5);
        const r = await run('bash', names.map(n => `type ${n} >/dev/null 2>&1 && echo "ok ${n}" || echo "missing ${n}"`).join('\n'));
        expect(r.stdout).toBe(names.map(n => `ok ${n}\n`).join(''));
    });

    it('"no apt, compilers or other native programs": they are not there', async () => {
        claims(described('execute_code'), 'no apt, compilers or other native programs');
        // (make is one of the built-in tools, not a native program)
        const r = await run('bash', 'for c in apt-get apt gcc cc clang x86 sudo; do type $c >/dev/null 2>&1 && echo "has $c"; done; true');
        expect(r.stdout).toBe('');
    });

    it('"bash starts in /workspace (the workspace)": relative and /workspace paths both name workspace files', async () => {
        claims(described('execute_code'), 'bash starts in /workspace (the workspace)');
        await W.agentWriteFile('a.txt', 'A');
        expect((await run('bash', 'pwd; cat a.txt; echo; cat /workspace/a.txt')).stdout).toBe('/workspace\nA\nA');
    });

    it('"Python: workspace files pre-loaded, writes sync back"', async () => {
        claims(described('execute_code'), 'Python: workspace files pre-loaded, writes sync back');
        await W.agentWriteFile('in.txt', 'in');
        await run('python', 'open("out.txt", "w").write(open("in.txt").read() + "+out")');
        expect(await W.agentReadFile('out.txt')).toBe('in+out');
    });

    it('"JavaScript: virtual fs — use fs.readFileSync/writeFileSync/existsSync/readdirSync and require("path"); no npm packages"', async () => {
        claims(described('execute_code'), 'JavaScript: virtual fs — use fs.readFileSync/writeFileSync/existsSync/readdirSync and require("path"); no npm packages');
        await W.agentWriteFile('j.txt', 'J');
        const r = await run('javascript', [
            'const fs = require("fs"), path = require("path");',
            'fs.writeFileSync("k.txt", fs.readFileSync("j.txt", "utf8") + "K");',
            'console.log(fs.existsSync("k.txt"), fs.readdirSync(".").includes("k.txt"), path.join("a", "b"));',
            'try { require("lodash"); } catch (e) { console.log("no lodash"); }',
        ].join('\n'));
        expect(r.stdout).toBe('true true a/b\nno lodash\n');
    });

    it('"Each call starts fresh in the workspace: variables, cd, exports and imports do not carry over to the next call; files do."', async () => {
        claims(described('execute_code'), 'Each call starts fresh in the workspace: variables, cd, exports and imports do not carry over to the next call; files do.');
        await run('bash', 'export V=1; cd /tmp; echo f > /workspace/f.txt');
        expect((await run('bash', 'echo "${V:-unset}"; pwd; cat f.txt')).stdout).toBe('unset\n/workspace\nf\n');
        await run('python', 'import json\nx = 1');
        expect((await run('python', 'print("x" in globals(), "json" in globals())')).stdout).toBe('False False\n');
    });
});

describe('system prompt', () => {
    it('"src/main.js names the same file in read_file/write_file … and in bash, Python and JavaScript, which all start in the workspace directory (mounted at /workspace, so /workspace/src/main.js also works)"', async () => {
        claims(prompt(), '`src/main.js` names the same file in read_file/write_file');
        claims(prompt(), 'which all start in the workspace directory (mounted at `/workspace`, so `/workspace/src/main.js` also works)');
        await tool('write_file', { path: 'src/main.js', content: 'M' });
        expect((await run('bash', 'cat src/main.js /workspace/src/main.js')).stdout).toBe('MM');
        expect((await run('python', 'print(open("src/main.js").read() + open("/workspace/src/main.js").read())')).stdout).toBe('MM\n');
        expect((await run('javascript', 'const fs = require("fs"); console.log(fs.readFileSync("src/main.js", "utf8") + fs.readFileSync("/workspace/src/main.js", "utf8"))')).stdout).toBe('MM\n');
        expect((await run('bash', 'python3 -c \'import os; print(os.getcwd())\'; node -e \'console.log(process.cwd())\'')).stdout).toBe('/workspace\n/workspace\n');
    });

    it('"bash (browser shell with Unix tools and curl/wget …)": curl and wget are there', async () => {
        claims(prompt(), '**bash** (browser shell with Unix tools and curl/wget');
        expect((await run('bash', 'type curl >/dev/null && type wget >/dev/null && echo both')).stdout).toBe('both\n');
    });

    it('"`python3` inside bash is also Pyodide and also starts in the workspace", and no stale /shiro path advice', async () => {
        claims(prompt(), '`python3` inside bash is also Pyodide and also starts in the workspace');
        expect(prompt()).not.toContain('/shiro');
        expect((await run('bash', 'python3 -c \'import sys, os; print(sys.platform, os.getcwd())\'')).stdout).toBe('emscripten /workspace\n');
    });

    it('no "local/" paths without a synced folder: the prompt does not offer them, and they fail', async () => {
        expect(prompt()).not.toMatch(/Use "local\/" prefix/);
        await W.agentWriteFile('x.txt', 'x');
        expect((await tool('read_file', { path: 'local/x.txt' })).error).toBeTruthy();
        expect((await tool('read_file', { path: 'x.txt' })).content).toBe('x');
    });
});

describe('file tools', () => {
    const lines200 = Array.from({ length: 200 }, (_, i) => `L${i + 1}`).join('\n');

    it('read_file: "1-based first line" / "last line inclusive", and ranges under 50 lines are widened to 50', async () => {
        claims(described('read_file', 'start_line'), '1-based first line');
        claims(described('read_file', 'end_line'), '1-based last line inclusive');
        claims(described('read_file'), 'A range shorter than 50 lines is widened to 50 lines around it.');
        await W.agentWriteFile('l.txt', lines200);
        const wide = (await tool('read_file', { path: 'l.txt', start_line: 60, end_line: 140 })).content.split('\n');
        expect([wide[0], wide[wide.length - 1]]).toEqual(['L60', 'L140']);
        const narrow = (await tool('read_file', { path: 'l.txt', start_line: 100, end_line: 101 })).content.split('\n');
        expect([narrow[0], narrow[narrow.length - 1], narrow.length]).toEqual(['L76', 'L126', 51]);
    });

    it('read_file: "local/foo" and "foo" — only claimed for a synced local folder', async () => {
        claims(described('read_file'), 'When a local folder is synced, "local/foo" and "foo" are the same file');
    });

    it('list_files: "A folder (lists the files in it) or a name prefix"', async () => {
        claims(described('list_files', 'path'), 'A folder (lists the files in it) or a name prefix');
        for (const n of ['src/a.js', 'src/b/c.py', 'src2/d.js', 'notes/041-x.md', 'notes/042-y.md']) await W.agentWriteFile(n, '1');
        const names = async (path: string) => (await tool('list_files', { path })).files.map((f: any) => f.name);
        expect(await names('src')).toEqual(['src/a.js', 'src/b/c.py']);
        expect(await names('notes/042')).toEqual(['notes/042-y.md']);
    });

    it('append_file: "A newline is added before the content when the file does not already end with one"', async () => {
        claims(described('append_file', 'content'), 'A newline is added before the content when the file does not already end with one');
        await W.agentWriteFile('a.txt', 'one');
        await tool('append_file', { path: 'a.txt', content: 'two\n' });
        await tool('append_file', { path: 'a.txt', content: 'three' });
        expect(await W.agentReadFile('a.txt')).toBe('one\ntwo\nthree');
    });

    it('replace_in_file: "use start_line/end_line to restrict the search region" and "Empty string to delete"', async () => {
        claims(described('replace_in_file'), 'use start_line/end_line to restrict the search region');
        claims(described('replace_in_file', 'new_string'), 'Empty string to delete');
        await W.agentWriteFile('r.txt', 'x = 1\ny = 2\nx = 1\n');
        await tool('replace_in_file', { path: 'r.txt', old_string: 'x = 1', new_string: 'x = 3', start_line: 3, end_line: 3 });
        expect(await W.agentReadFile('r.txt')).toBe('x = 1\ny = 2\nx = 3\n');
        await tool('replace_in_file', { path: 'r.txt', old_string: 'y = 2\n', new_string: '' });
        expect(await W.agentReadFile('r.txt')).toBe('x = 1\nx = 3\n');
    });

    it('apply_patch: "Auto-corrects @@ offset if context lines exist", and the header name is used only when no path is given', async () => {
        claims(described('apply_patch'), 'Auto-corrects @@ offset if context lines exist');
        claims(described('apply_patch', 'patch'), 'The header file names are used only when path is not given');
        await W.agentWriteFile('p.txt', 'a\nb\nc\nd\ne\n');
        // wrong line numbers in the hunk header
        expect(await tool('apply_patch', { path: 'p.txt', patch: '--- a/other.txt\n+++ b/other.txt\n@@ -10,3 +10,3 @@\n c\n-d\n+D\n e\n' })).toMatchObject({ success: true, path: 'p.txt' });
        expect(await W.agentReadFile('p.txt')).toBe('a\nb\nc\nD\ne\n');
        expect(await tool('apply_patch', { patch: '--- a/p.txt\n+++ b/p.txt\n@@ -1,2 +1,2 @@\n-a\n+A\n b\n' })).toMatchObject({ success: true, path: 'p.txt' });
        expect(await W.agentReadFile('p.txt')).toBe('A\nb\nc\nD\ne\n');
    });

    it('undo_write: "Revert the most recent write_file or replace_in_file on a path"', async () => {
        claims(described('undo_write'), 'Revert the most recent write_file or replace_in_file on a path');
        await tool('write_file', { path: 'u.txt', content: 'one' });
        await tool('replace_in_file', { path: 'u.txt', old_string: 'one', new_string: 'two' });
        await tool('undo_write', { path: 'u.txt' });
        expect(await W.agentReadFile('u.txt')).toBe('one');
        await tool('write_file', { path: 'u.txt', content: 'three' });
        await tool('undo_write', { path: 'u.txt' });
        expect(await W.agentReadFile('u.txt')).toBe('one');
    });

    it('search_workspace: literal (case-insensitive) or regex, "|" for OR, names/contents scope, path_filter with "|", context up to 50 lines', async () => {
        claims(described('search_workspace', 'pattern'), 'Literal string (default, case-insensitive) or regex when is_regex=true. Use | for multi-term OR');
        claims(described('search_workspace', 'scope'), '"names" = filenames only; "contents" = contents only');
        claims(described('search_workspace', 'path_filter'), 'Supports | for OR');
        claims(described('search_workspace', 'context_lines'), 'max 50');
        await W.agentWriteFile('src/alpha.py', 'def Foo():\n    return 1\n');
        await W.agentWriteFile('lib/beta.js', 'const bar = 2;\n');
        await W.agentWriteFile('doc/foo.md', 'nothing here\n');
        const hits = async (args: any) => {
            const r = await tool('search_workspace', args);
            // matches read "> path:line: text" (contents) or a path (names)
            return [...new Set((r.matches ?? []).map((m: string) => String(m).replace(/^>\s*/, '').replace(/\s+\(filename match\)$/, '').split(':')[0].trim()))].sort();
        };
        expect(await hits({ pattern: 'foo', scope: 'contents' })).toEqual(['src/alpha.py']);
        expect(await hits({ pattern: 'foo|BAR', scope: 'contents' })).toEqual(['lib/beta.js', 'src/alpha.py']);
        expect(await hits({ pattern: 'foo', scope: 'names' })).toEqual(['doc/foo.md']);
        expect(await hits({ pattern: 'def \\w+\\(', is_regex: true, scope: 'contents' })).toEqual(['src/alpha.py']);
        expect(await hits({ pattern: 'o', scope: 'contents', path_filter: 'src/|doc/' })).toEqual(['doc/foo.md', 'src/alpha.py']);
    });
});

describe('run_workers', () => {
    it('"File edits a worker makes are merged after all finish; files its code writes are shared at once"', async () => {
        claims(described('run_workers'), 'File edits a worker makes are merged after all finish; files its code writes are shared at once');
        const ctx = async () => ({ snapshot: new LazySnapshot(await W.agentListFiles()), staging: new Map(), depth: 0 });
        const a = await ctx(), b = await ctx();
        await tool('write_file', { path: 'edit.txt', content: 'staged' }, a);
        expect((await tool('read_file', { path: 'edit.txt' }, b)).error).toBeTruthy();
        await tool('execute_code', { language: 'bash', code: 'echo made > made.txt' }, a);
        expect((await tool('execute_code', { language: 'bash', code: 'cat made.txt' }, b)).stdout).toBe('made\n');
    });
});
