// What the tools promise the model: each file tool and execute_code takes its arguments (and the
// aliases models use for them), resolves every form of a path to the same workspace file, and
// answers in the documented shape — normalized paths, sizes in bytes, exact content, numeric exit
// codes. All through executeToolAsync, on both backends (tests/tool-backends.ts): the browser
// and headless.
import { BACKENDS } from './tool-backends';

const W = globalThis as any;
const tool = (name: string, args: any) => W.executeToolAsync(name, args);
const names = async () => (await W.agentListFiles()).map((f: any) => f.name).sort();
const utf8Len = (s: string) => Buffer.byteLength(s, 'utf8');

describe.each(BACKENDS)('$name', be => {
const stored = async (name: string) => {
    const b = await be.stored(name);
    if (!b) return null;
    // text as text; anything else as one char per byte
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b); } catch { return b.toString('latin1'); }
};
beforeEach(be.setup, 120_000);
afterEach(() => be.teardown());

// ── write_file ────────────────────────────────────────────────────────────────

describe('write_file', () => {
    it.each(['path', 'filename', 'file', 'filepath'])('takes the path as "%s"', async key => {
        expect(await tool('write_file', { [key]: 'w.txt', content: 'x' })).toEqual({ success: true, path: 'w.txt', bytes: 1 });
        expect(await stored('w.txt')).toBe('x');
    });

    it.each(['content', 'text', 'body', 'data'])('takes the content as "%s"', async key => {
        await tool('write_file', { path: 'w.txt', [key]: 'ä😀\r\n' });
        expect(await stored('w.txt')).toBe('ä😀\r\n');
    });

    it('answers with the workspace name and the size in bytes, and makes the folders', async () => {
        const content = '﻿ä😀\r\nend';
        expect(await tool('write_file', { path: `${be.root()}/deep/er/x.txt`, content }))
            .toEqual({ success: true, path: 'deep/er/x.txt', bytes: utf8Len(content) });
        expect(await stored('deep/er/x.txt')).toBe(content);
    });

    it('writes base64 content as binary', async () => {
        const r = await tool('write_file', { path: 'b.bin', content: Buffer.from([0, 255, 1, 2]).toString('base64'), encoding: 'base64' });
        expect(r).toEqual({ success: true, path: 'b.bin', bytes: 4 });
        expect([...(await be.stored('b.bin'))!]).toEqual([0, 255, 1, 2]);
        if (be.name === 'browser') expect((await W.readWorkspaceFile('b.bin')).encoding).toBe('base64');
    });

    it('asks for a path when there is none', async () => {
        const r = await tool('write_file', { content: 'x' });
        expect(r.error).toMatch(/"path" is required/);
        expect(r.error).not.toMatch(/execute_code/);
        expect(r.note).toBe('Received keys: content');
    });

    // Uploaded chat 2026-10-08: the model sent history's abbreviated form of its own earlier writes
    // back as new calls, believed the file damaged, and tried to "restore" it 30 times.
    it.each([
        ['a diff', { path: 'a.js', content: '--- a.js\n+++ a.js\n@@ -1,3 +1,4 @@\n+// header\n var a = 1;', _contentCompressed: true }],
        ['the flag without an underscore', { path: 'a.js', content: 'var b = 2;', contentCompressed: true }],
        ['the stub', { path: 'a.js', content: '[write_file: a.js — no changes]' }],
        ['a bare diff', { path: 'a.js', content: '--- a.js\n+++ a.js\n@@ -1 +1 @@\n-x\n+y\n' }],
    ])('refuses %s as new content and says the file is untouched', async (_n, args) => {
        await W.agentWriteFile('a.js', 'var a = 1;\n'.repeat(40));
        const r = await tool('write_file', args);
        expect(r.error).toMatch(/was NOT changed/);
        expect(r.error).toMatch(/nothing to restore/);
        expect(r.error).toMatch(/\(440 characters\)/);
        expect(await stored('a.js')).toBe('var a = 1;\n'.repeat(40));
    });

    it('lets a patch file hold a diff', async () => {
        const diff = '--- a.js\n+++ a.js\n@@ -1 +1 @@\n-x\n+y\n';
        expect((await tool('write_file', { path: 'fix.patch', content: diff })).success).toBe(true);
        expect(await stored('fix.patch')).toBe(diff);
    });

    it('refuses text with NUL characters and says where', async () => {
        const r = await tool('write_file', { path: 'n.js', content: 'const a = [0, 1,\0 0];\nlet b;\n' });
        expect(r.error).toMatch(/1 NUL character.*line 1 near "const a = \[0, 1,␀ 0\];/);
        expect(await stored('n.js')).toBeNull();
        await W.agentWriteFile('r.txt', 'one two\n');
        const e = await tool('replace_in_file', { path: 'r.txt', old_string: 'two', new_string: 'x\0y' });
        expect(e.error).toMatch(/new_string: .*1 NUL character/);
        expect(await stored('r.txt')).toBe('one two\n');
    });

    // v0.66: 24 of 47 pathless write_file calls carried `language` — code meant to be run.
    it('points a pathless call that carries a language to execute_code', async () => {
        const r = await tool('write_file', { content: 'print(1)', language: 'python' });
        expect(r.error).toMatch(/"path" is required/);
        expect(r.error).toMatch(/execute_code/);
    });
});

// ── read_file ─────────────────────────────────────────────────────────────────

describe('read_file', () => {
    const lines200 = Array.from({ length: 200 }, (_, i) => `L${i + 1}`).join('\n');
    const lineSpan = (c: string) => { const l = c.split('\n'); return [l[0], l[l.length - 1], l.length]; };

    it.each([
        ['path', 'r.txt'], ['filename', 'r.txt'], ['file', 'r.txt'], ['filepath', 'r.txt'],
        ['paths', ['r.txt']], ['paths', '["r.txt"]'],
    ])('takes the path as "%s"', async (key, value) => {
        await W.agentWriteFile('r.txt', 'hello\n');
        expect((await tool('read_file', { [key]: value })).content).toBe('hello\n');
    });

    it('returns the content exactly, with the workspace name and its size', async () => {
        const content = '﻿a,b\r\nä,😀\r\nno final newline';
        await W.agentWriteFile('sub/r.csv', content);
        for (const p of ['sub/r.csv', `${be.root()}/sub/r.csv`, './sub//r.csv', 'workspace/sub/r.csv'])
            expect(await tool('read_file', { path: p })).toEqual({ path: 'sub/r.csv', content, length: content.length, lines_returned: 3 });
    });

    it.each([
        [{ start_line: 60, end_line: 140 }], [{ start: 60, end: 140 }],
        [{ line_range: [60, 140] }], [{ line_range: '[60, 140]' }],
    ])('reads a line range given as %j', async range => {
        await W.agentWriteFile('long.txt', lines200);
        const r = await tool('read_file', { path: 'long.txt', ...range });
        expect(lineSpan(r.content)).toEqual(['L60', 'L140', 81]);
        expect(r).toMatchObject({ path: 'long.txt', start_line: 60, end_line: 140, total_lines: 200, lines_returned: 81 });
    });

    it('widens a narrow range to 50 lines around it, and reads on when the end is before the start', async () => {
        await W.agentWriteFile('long.txt', lines200);
        expect(lineSpan((await tool('read_file', { path: 'long.txt', start_line: 100, end_line: 101 })).content)).toEqual(['L76', 'L126', 51]);
        const r = await tool('read_file', { path: 'long.txt', start_line: 150, end_line: 10 });
        expect(lineSpan(r.content)).toEqual(['L150', 'L200', 51]);
        expect(r.note).toMatch(/end_line \(10\) was before start_line \(150\)/);
    });

    it('refuses binary files and reports missing ones', async () => {
        await W.agentWriteFile('x.bin', Buffer.from([0, 1, 2]).toString('base64'), 'base64');
        expect((await tool('read_file', { path: 'x.bin' })).error).toMatch(/binary file/);
        expect((await tool('read_file', { path: 'nope.txt' })).error).toMatch(/not found|No such/i);
    });
});

// ── append_file, replace_in_file, apply_patch, delete_file, undo_write ────────

describe('append_file', () => {
    it('adds a newline only when the file does not end in one, and answers in bytes', async () => {
        await W.agentWriteFile('a.txt', 'one');
        expect(await tool('append_file', { path: `${be.root()}/a.txt`, content: 'twö' })).toEqual({ success: true, path: 'a.txt', bytes: utf8Len('one\ntwö') });
        await tool('append_file', { path: './a.txt', text: 'three\n' });
        await tool('append_file', { file: 'a.txt', data: 'four' });
        expect(await stored('a.txt')).toBe('one\ntwö\nthree\nfour');
    });

    it('creates the file when it does not exist', async () => {
        await tool('append_file', { path: 'new/n.txt', content: 'first\r\n' });
        expect(await stored('new/n.txt')).toBe('first\r\n');
    });
});

describe('replace_in_file', () => {
    it.each([
        ['old_string', 'new_string'], ['old_str', 'new_str'], ['old_text', 'new_text'],
        ['old', 'new'], ['search', 'replacement'], ['find', 'replace'],
    ])('takes %s / %s, and changes only the match (CRLF and unicode around it stay)', async (o, n) => {
        await W.agentWriteFile('r.txt', 'ä\r\nbeta\r\n😀\r\n');
        const r = await tool('replace_in_file', { path: `${be.root()}/r.txt`, [o]: 'beta', [n]: 'BETA' });
        expect(r).toMatchObject({ success: true, path: 'r.txt', replacements_made: 1, bytes: utf8Len('ä\r\nBETA\r\n😀\r\n') });
        expect(await stored('r.txt')).toBe('ä\r\nBETA\r\n😀\r\n');
    });

    it('reports text that is not there and leaves the file alone', async () => {
        await W.agentWriteFile('r.txt', 'alpha\n');
        expect((await tool('replace_in_file', { path: 'r.txt', old_string: 'zeta', new_string: 'x' })).error).toBeTruthy();
        expect(await stored('r.txt')).toBe('alpha\n');
    });

    // v0.66 SWE workers: 41 "not found within lines X–Y" failures, the range a few lines off.
    it('applies a unique match that lies outside the given line range, and says where', async () => {
        await W.agentWriteFile('r.txt', 'one\ntwo\nthree\nfour\nfive\n');
        const r = await tool('replace_in_file', { path: 'r.txt', old_string: 'two', new_string: 'TWO', start_line: 4, end_line: 5 });
        expect(r.success).toBe(true);
        expect(r.note).toMatch(/applied at line 2/);
        expect(await stored('r.txt')).toBe('one\nTWO\nthree\nfour\nfive\n');
    });

    it('does not guess when the text outside the range occurs more than once', async () => {
        await W.agentWriteFile('r.txt', 'dup\ndup\nthree\nfour\n');
        const r = await tool('replace_in_file', { path: 'r.txt', old_string: 'dup', new_string: 'x', start_line: 3, end_line: 4 });
        expect(r.error).toMatch(/not found/);
        expect(await stored('r.txt')).toBe('dup\ndup\nthree\nfour\n');
    });
});

describe('apply_patch', () => {
    const patch = '--- a/p.txt\n+++ b/p.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n';
    it('applies a unified diff to the named file', async () => {
        await W.agentWriteFile('p.txt', 'one\ntwo\nthree\n');
        expect(await tool('apply_patch', { path: `${be.root()}/p.txt`, patch })).toMatchObject({ success: true, path: 'p.txt', bytes: 14 });
        expect(await stored('p.txt')).toBe('one\nTWO\nthree\n');
    });
    it('takes the path from the diff header when none is given', async () => {
        await W.agentWriteFile('p.txt', 'one\ntwo\nthree\n');
        expect(await tool('apply_patch', { patch })).toMatchObject({ success: true, path: 'p.txt' });
        expect(await stored('p.txt')).toBe('one\nTWO\nthree\n');
    });
});

describe('delete_file and undo_write', () => {
    it('deletes by any path form, and reports a missing file', async () => {
        await W.agentWriteFile('d/x.txt', 'x');
        expect(await tool('delete_file', { path: `${be.root()}/d//x.txt` })).toEqual({ success: true });
        expect(await names()).toEqual([]);
        expect((await tool('delete_file', { path: 'd/x.txt' })).error).toBeTruthy();
    });

    it('undo_write restores the content before the last write, by any path form', async () => {
        await tool('write_file', { path: 'u.txt', content: 'v1' });
        await tool('write_file', { path: `${be.root()}/u.txt`, content: 'v2 ä' });
        expect(await tool('undo_write', { path: `${be.root()}/./u.txt` })).toMatchObject({ success: true, path: 'u.txt', bytes: 2 });
        expect(await stored('u.txt')).toBe('v1');
    });
});

// ── list_files ────────────────────────────────────────────────────────────────

describe('list_files', () => {
    beforeEach(async () => {
        for (const [n, c] of [['src/a.js', 'a'], ['src/lib/b.py', 'ää'], ['src2/c.js', 'c'], ['top.txt', '😀']])
            await W.agentWriteFile(n, c);
    });
    const listed = async (path?: string) => {
        const r = await tool('list_files', path === undefined ? {} : { path });
        return [r.path, r.files.map((f: any) => f.name)];
    };

    it.each([undefined, '', '.', './', '/', 'ROOT', 'ROOT/'])('lists everything for %j', async p => {
        const [path, files] = await listed(p?.replace('ROOT', be.root()));
        expect([path, files.sort()]).toEqual(['', ['src/a.js', 'src/lib/b.py', 'src2/c.js', 'top.txt']]);
    });

    it.each(['src', 'src/', './src', 'ROOT/src', 'ROOT/src/', 'workspace/src'])('lists the folder for %j — not src2', async p => {
        expect(await listed(p.replace('ROOT', be.root()))).toEqual(['src', ['src/a.js', 'src/lib/b.py']]);
    });

    it('lists a subfolder, and treats a filter that is no folder as a name prefix', async () => {
        expect(await listed('src/lib')).toEqual(['src/lib', ['src/lib/b.py']]);
        expect(await listed('sr')).toEqual(['sr', ['src/a.js', 'src/lib/b.py', 'src2/c.js']]);
    });

    it('gives sizes in bytes', async () => {
        const r = await tool('list_files', {});
        expect(Object.fromEntries(r.files.map((f: any) => [f.name, f.size]))).toEqual({ 'src/a.js': 1, 'src/lib/b.py': 4, 'src2/c.js': 1, 'top.txt': 4 });
    });
});

// ── execute_code ──────────────────────────────────────────────────────────────

describe('execute_code', () => {
    it.each(['code', 'script', 'command', 'cmd', 'source', 'commands', 'bash', 'shell_command'])('takes the code as "%s"', async key => {
        expect(await tool('execute_code', { language: 'bash', [key]: 'echo hi' })).toMatchObject({ stdout: 'hi\n', exit_code: 0 });
    });

    it.each([
        ['bash', 'echo from-bash'], ['sh', 'echo from-bash'], ['shell', 'echo from-bash'], ['Bash', 'echo from-bash'],
        ['python', 'print("from-python")'], ['python3', 'print("from-python")'], ['py', 'print("from-python")'], ['Python', 'print("from-python")'],
        ['javascript', 'console.log("from-js")'], ['js', 'console.log("from-js")'], ['node', 'console.log("from-js")'], ['JavaScript', 'console.log("from-js")'],
    ])('runs language %j in the right runtime', async (language, code) => {
        const r = await tool('execute_code', { language, code });
        expect([r.stdout, r.exit_code]).toEqual([code.match(/from-\w+/)![0] + '\n', 0]);
    });

    it.each(['lang', 'type'])('takes the language as "%s"', async key => {
        expect((await tool('execute_code', { [key]: 'javascript', code: 'console.log(typeof process.exit)' })).stdout).toBe('function\n');
    });

    it('answers { stdout, stderr, exit_code } with the program\'s own exit code and exact output', async () => {
        for (const [language, code, out, err, rc] of [
            ['bash', 'printf "no newline"; echo e >&2; exit 3', 'no newline', 'e\n', 3],
            ['python', 'import sys\nsys.stdout.write("x\\r\\ny")\nprint("e", file=sys.stderr)\nsys.exit(4)', 'x\r\ny', 'e\n', 4],
            ['javascript', 'process.stdout.write("z"); console.error("e"); process.exit(5);', 'z', 'e\n', 5],
        ] as const) {
            const r = await tool('execute_code', { language, code });
            expect({ stdout: r.stdout, stderr: r.stderr, exit_code: r.exit_code }, language).toEqual({ stdout: out, stderr: err, exit_code: rc });
        }
    });

    it('runs Python when no language is given and the code is Python, bash otherwise', async () => {
        expect((await tool('execute_code', { code: 'import sys\nprint(sys.version_info[0])' })).stdout).toBe('3\n');
        expect((await tool('execute_code', { code: 'echo $((6 * 7))' })).stdout).toBe('42\n');
    });

    it('starts every bash call in the workspace, whatever an earlier call cd-ed to', async () => {
        await tool('execute_code', { language: 'bash', code: 'mkdir -p sub && cd sub && cd /tmp' });
        expect((await tool('execute_code', { language: 'bash', code: 'pwd; echo x > rel.txt' })).stdout).toBe(be.root() + '\n');
        await tool('execute_code', { language: 'bash', code: 'rmdir sub' });
        expect(await names()).toEqual(['rel.txt']);
    });

    it('reports JavaScript\'s written and deleted files by workspace name', async () => {
        await W.agentWriteFile('old.txt', 'o');
        const r = await tool('execute_code', { language: 'javascript', code:
            'const fs = require("fs"), p = require("path"); fs.mkdirSync(p.join(process.cwd(), "o"), { recursive: true }); fs.writeFileSync(p.join(process.cwd(), "o/x.txt"), "1"); fs.writeFileSync("./y.txt", "2"); fs.unlinkSync("old.txt");' });
        expect(r.files_written?.sort()).toEqual(['o/x.txt', 'y.txt']);
        if (be.name === 'browser') expect(r.files_deleted).toEqual(['old.txt']);
        expect(await names()).toEqual(['o/x.txt', 'y.txt']);
    });

    it('asks for code when there is none', async () => {
        expect((await tool('execute_code', { language: 'bash' })).error).toMatch(/No code provided/);
    });
});
});
