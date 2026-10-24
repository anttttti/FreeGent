// Two traps that cost the self-analysis runs (bench/selfanalysis) 5-22 steps each:
//   * a tool call typed into the shell as the code of execute_code (`read_file{path: "a.ts"}`);
//   * an inline `python3 -c "..."` / heredoc whose quoting the model rewrites again and again.
import { describe, it, expect, beforeAll } from 'vitest';
import { pseudoToolInShell, inlineScriptSyntaxFailure, _updateEnvFailureDetector, INLINE_SCRIPT_SIG } from '../detectors.ts';
import { _knownToolNames } from '../model-caps.ts';

const W: any = window;
beforeAll(async () => { await import('../tools.ts'); });
const names = ['read_file', 'write_file', 'search_workspace', 'execute_code'];

describe('pseudoToolInShell', () => {
    it('finds a tool call typed as a command, in brace, paren and keyword forms', () => {
        expect(pseudoToolInShell('read_file{path: "a.ts"}', names)).toBe('read_file');
        expect(pseudoToolInShell('  search_workspace(pattern="x", path=".")', names)).toBe('search_workspace');
        expect(pseudoToolInShell('# look at it\nwrite_file {"path": "a"}', names)).toBe('write_file');
    });
    it('leaves real commands, other words, later lines and function definitions alone', () => {
        expect(pseudoToolInShell('ls -la', names)).toBeNull();
        expect(pseudoToolInShell('cat read_file.txt', names)).toBeNull();
        expect(pseudoToolInShell('echo hi\nread_file(x)', names)).toBeNull();
        expect(pseudoToolInShell('read_file() { cat "$1"; }\nread_file a.txt', names)).toBeNull();
        expect(pseudoToolInShell('my_tool(x)', names)).toBeNull();
        expect(pseudoToolInShell('', names)).toBeNull();
    });
    it('is wired into execute_code: an error that names the tool, nothing run, also for the code sent as `cmd`', async () => {
        for (const args of [{ language: 'bash', code: 'read_file{path: "a.ts"}' }, { cmd: 'read_file(path="a.ts")' }]) {
            const r = await W.executeToolAsync('execute_code', args, null);
            expect(r.error).toMatch(/read_file is a tool, not a shell command/);
            expect(r.exit_code).toBeUndefined();
        }
        expect(_knownToolNames().has('read_file')).toBe(true);
    });
});

describe('inline script syntax loop', () => {
    const fail = (code: string, stderr: string) => ({ name: 'execute_code', args: { language: 'bash', code }, result: { exit_code: 1, stderr, stdout: '' } });
    it('recognises a python -c / heredoc that failed on syntax, not other failures', () => {
        const a = { language: 'bash', code: `python3 -c "print(f\\"{d['a']}\\")"` };
        expect(inlineScriptSyntaxFailure(a, { stderr: 'SyntaxError: f-string expression part cannot include a backslash' })).toBe(true);
        expect(inlineScriptSyntaxFailure({ language: 'bash', code: 'python3 - <<EOF\nprint(1)\nEOF' }, { stderr: "syntax error near unexpected token `('" })).toBe(true);
        expect(inlineScriptSyntaxFailure(a, { stderr: 'FileNotFoundError: no such file' })).toBe(false);                 // a runtime error of the program
        expect(inlineScriptSyntaxFailure({ language: 'bash', code: 'python3 script.py' }, { stderr: 'SyntaxError: bad' })).toBe(false);   // a file, nothing to unquote
        expect(inlineScriptSyntaxFailure({ language: 'python', code: 'python3 -c "x"' }, { stderr: 'SyntaxError' })).toBe(false);
    });
    it('two such failures in a row get the write-it-to-a-file nudge, although their error lines differ', () => {
        let st = { envFailSig: '', envFailCount: 0, envFailTotal: 0, envFailMsg: null as string | null };
        const step = (r: any) => { st = _updateEnvFailureDetector([r], st.envFailSig, st.envFailCount, st.envFailTotal); return st.envFailMsg; };
        expect(step(fail(`python3 -c "print(f'{d["a"]}')"`, 'SyntaxError: f-string: expecting }'))).toBeNull();
        expect(st.envFailSig).toBe(INLINE_SCRIPT_SIG);
        const msg = step(fail('python3 - <<EOF\nprint(1)\nEOF', "bash: syntax error near unexpected token `('"));
        expect(msg).toMatch(/write_file/);
        expect(msg).toMatch(/out\/step\.py/);
    });
    it('the environment path is unchanged: three identical failures of anything else still get the old message', () => {
        let st = { envFailSig: '', envFailCount: 0, envFailTotal: 0, envFailMsg: null as string | null };
        const same = { name: 'execute_code', args: { language: 'bash', code: 'make' }, result: { exit_code: 2, stderr: 'make: *** No rule to make target', stdout: '' } };
        let msg: string | null = null;
        for (let i = 0; i < 3; i++) { st = _updateEnvFailureDetector([same], st.envFailSig, st.envFailCount, st.envFailTotal); msg = st.envFailMsg; }
        expect(msg).toMatch(/failed 3 times in a row/);
    });
});
