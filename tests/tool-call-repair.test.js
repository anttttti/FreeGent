// Tests for tool-call-repair.ts — deterministic repair of malformed tool calls,
// shared by the main loop and both worker branches. Headline coverage: the alias
// normalization that reconciles pre-dispatch repair with executeToolAsync's dispatch
// aliasing ({"bash": "…"} calls flagged empty by the old repair but executed fine by
// dispatch — and fence/token strips silently skipped on aliased code).
import { describe, it, expect } from 'vitest';
import {
    _repairJsonArgs, _repairToolCallArgs, _repairToolNames, _repairExecCodeArgs,
    _repairArgEnvelope, _repairBracketPseudoCalls, _repairInlinePseudoCalls, _repairPathArg, repairAllToolCalls, EXEC_CODE_ALIASES,
} from '../tool-call-repair.ts';

describe('_repairJsonArgs — fence strip only', () => {
    it('strips a ```json fence around valid JSON', () => {
        expect(_repairJsonArgs('```json\n{"a":1}\n```')).toBe('{"a":1}');
    });
    it('returns null for non-fenced invalid JSON (no risky regex fixes)', () => {
        expect(_repairJsonArgs("{'a': 1}")).toBeNull();
    });
    it('returns null when the fence contents are still invalid', () => {
        expect(_repairJsonArgs("```json\n{'a': 1}\n```")).toBeNull();
    });
});

describe('_repairToolCallArgs — OAI tool_calls arguments', () => {
    const tc = (name, args) => ({ function: { name, arguments: args } });
    it('repairs fence-wrapped args in place and reports irreparable ones', () => {
        const calls = [tc('read_file', '```json\n{"path":"a.txt"}\n```'), tc('write_file', 'not json at all')];
        const bad = _repairToolCallArgs(calls);
        expect(calls[0].function.arguments).toBe('{"path":"a.txt"}');
        expect(bad).toEqual(['write_file']);
    });
    it('leaves valid JSON and empty strings untouched', () => {
        const calls = [tc('read_file', '{"path":"a"}'), tc('list_files', '')];
        expect(_repairToolCallArgs(calls)).toEqual([]);
        expect(calls[0].function.arguments).toBe('{"path":"a"}');
    });
});

describe('_repairToolNames — embedded-name extraction', () => {
    const NAMES = ['execute_code', 'search_workspace', 'read_file'];
    it('extracts a known name from streaming/XML garbage (v0.10 log signatures)', () => {
        const calls = [
            { name: '<tool_call>\n<function=execute_code', args: {} },
            { name: 'search_workspace\n<tool_call>\n<parameter="pattern"', args: {} },
        ];
        _repairToolNames(calls, NAMES);
        expect(calls[0].name).toBe('execute_code');
        expect(calls[1].name).toBe('search_workspace');
    });
    it('leaves exact names and unrecoverable garbage unchanged', () => {
        const calls = [{ name: 'read_file', args: {} }, { name: 'totally_unknown', args: {} }];
        _repairToolNames(calls, NAMES);
        expect(calls[0].name).toBe('read_file');
        expect(calls[1].name).toBe('totally_unknown');
    });
});

describe('_repairExecCodeArgs — alias + fence + language-token cleanup', () => {
    it('moves alias-keyed code to "code" and does NOT flag it empty', () => {
        const calls = [{ name: 'execute_code', args: { bash: 'ls -la' } }];
        expect(_repairExecCodeArgs(calls)).toBe(false);
        expect(calls[0].args.code).toBe('ls -la');
    });
    it('applies the fence strip to alias-recovered code too', () => {
        const calls = [{ name: 'execute_code', args: { command: '```python\nprint(1)\n```' } }];
        _repairExecCodeArgs(calls);
        expect(calls[0].args.code).toBe('print(1)');
        expect(calls[0].args.language).toBe('python');
    });
    it('strips a stray leading language token and recovers the language', () => {
        const calls = [{ name: 'execute_code', args: { code: 'bash\ntimeout 5 mysql -u root' } }];
        _repairExecCodeArgs(calls);
        expect(calls[0].args.code).toBe('timeout 5 mysql -u root');
        expect(calls[0].args.language).toBe('bash');
    });
    it('sql token: strips but never sets language=sql (not an interpreter)', () => {
        const calls = [{ name: 'execute_code', args: { code: 'sql\nSELECT 1;' } }];
        _repairExecCodeArgs(calls);
        expect(calls[0].args.code).toBe('SELECT 1;');
        expect(calls[0].args.language).toBeUndefined();
    });
    it('flags true empty code (no key carries any) and skips non-execute_code calls', () => {
        const calls = [
            { name: 'execute_code', args: { irrelevant: 1 } },
            { name: 'read_file', args: { path: 'a' } },
        ];
        expect(_repairExecCodeArgs(calls)).toBe(true);
        expect(calls[1].args).toEqual({ path: 'a' });
    });
    it('alias priority follows EXEC_CODE_ALIASES order (code wins over bash)', () => {
        expect(EXEC_CODE_ALIASES[0]).toBe('code');
        const calls = [{ name: 'execute_code', args: { code: 'echo a', bash: 'echo b' } }];
        _repairExecCodeArgs(calls);
        expect(calls[0].args.code).toBe('echo a');
    });
    it('longest-string fallback recovers code from an unseen alias key', () => {
        const calls = [{ name: 'execute_code', args: { description: 'x', unknown_key: 'ls -la /tmp' } }];
        expect(_repairExecCodeArgs(calls)).toBe(false);
        expect(calls[0].args.code).toBe('ls -la /tmp');
    });
    it('language canonicalization strips XML residue (="bash">)', () => {
        const calls = [{ name: 'execute_code', args: { code: 'echo 1', language: '="bash">' } }];
        _repairExecCodeArgs(calls);
        expect(calls[0].args.language).toBe('bash');
    });
    it('language canonicalization strips XML residue and applies _LANG_CANON (="python3">)', () => {
        const calls = [{ name: 'execute_code', args: { code: 'print(1)', language: '="python3">' } }];
        _repairExecCodeArgs(calls);
        expect(calls[0].args.language).toBe('python');
    });
    it('language canonicalization removes XML-contaminated unknown language', () => {
        const calls = [{ name: 'execute_code', args: { code: 'x', language: '="ruby">' } }];
        _repairExecCodeArgs(calls);
        expect(calls[0].args.language).toBeUndefined();
    });
    it('language canonicalization leaves clean unknown language unchanged', () => {
        const calls = [{ name: 'execute_code', args: { code: 'x', language: 'ruby' } }];
        _repairExecCodeArgs(calls);
        expect(calls[0].args.language).toBe('ruby');
    });
});

describe('_repairArgEnvelope — {arg_keys, arg_values} unwrap', () => {
    it('unwraps a double-serialized envelope into flat args', () => {
        const calls = [{ name: 'execute_code', args: { arg_keys: ['code', 'language'], arg_values: ['echo hi', 'bash'] } }];
        _repairArgEnvelope(calls);
        expect(calls[0].args).toEqual({ code: 'echo hi', language: 'bash' });
    });
    it('unwraps for non-execute_code tools too', () => {
        const calls = [{ name: 'read_file', args: { arg_keys: ['path'], arg_values: ['src/main.py'] } }];
        _repairArgEnvelope(calls);
        expect(calls[0].args).toEqual({ path: 'src/main.py' });
    });
    it('leaves normal args untouched', () => {
        const calls = [{ name: 'execute_code', args: { code: 'ls', language: 'bash' } }];
        _repairArgEnvelope(calls);
        expect(calls[0].args).toEqual({ code: 'ls', language: 'bash' });
    });
    it('ignores mismatched arg_keys/arg_values lengths', () => {
        const orig = { arg_keys: ['a', 'b'], arg_values: ['x'] };
        const calls = [{ name: 'foo', args: { ...orig } }];
        _repairArgEnvelope(calls);
        expect(calls[0].args).toEqual(orig);
    });
});

const TOOL_NAMES = ['web_search', 'run_workers', 'fetch_url', 'read_file'];

describe('_repairBracketPseudoCalls — [[{…}]] / [{…}] text format', () => {
    it('parses double-bracket format [[{name, parameters}]]', () => {
        const text = '[[{"name": "web_search", "parameters": {"query": "Clank expansion 2026"}}]]';
        const r = _repairBracketPseudoCalls(text, TOOL_NAMES);
        expect(r).toHaveLength(1);
        expect(r[0].name).toBe('web_search');
        expect(r[0].args).toEqual({ query: 'Clank expansion 2026' });
    });
    it('parses malformed double-bracket with missing final ] (nemotron-3-ultra-free pattern)', () => {
        const text = '[[\n{"name": "run_workers", "parameters": {"agents": [{"id": "w1", "task": "search", "role": "researcher"}]}}\n]';
        const r = _repairBracketPseudoCalls(text, TOOL_NAMES);
        expect(r).toHaveLength(1);
        expect(r[0].name).toBe('run_workers');
        expect(r[0].args.agents).toHaveLength(1);
    });
    it('parses single-bracket format [{name, arguments}]', () => {
        const text = '[{"name": "fetch_url", "arguments": {"url": "https://example.com"}}]';
        const r = _repairBracketPseudoCalls(text, TOOL_NAMES);
        expect(r).toHaveLength(1);
        expect(r[0].name).toBe('fetch_url');
        expect(r[0].args).toEqual({ url: 'https://example.com' });
    });
    it('parses multiple calls in one array', () => {
        const text = '[[{"name": "web_search", "parameters": {"query": "foo"}}, {"name": "fetch_url", "parameters": {"url": "https://x.com"}}]]';
        const r = _repairBracketPseudoCalls(text, TOOL_NAMES);
        expect(r).toHaveLength(2);
        expect(r[0].name).toBe('web_search');
        expect(r[1].name).toBe('fetch_url');
    });
    it('accepts "args" and "input" as parameter-envelope keys', () => {
        const r1 = _repairBracketPseudoCalls('[{"name":"web_search","args":{"query":"q"}}]', TOOL_NAMES);
        expect(r1?.[0].args).toEqual({ query: 'q' });
        const r2 = _repairBracketPseudoCalls('[{"name":"web_search","input":{"query":"q"}}]', TOOL_NAMES);
        expect(r2?.[0].args).toEqual({ query: 'q' });
    });
    it('ignores objects whose name is not in the tool list', () => {
        const text = '[[{"name": "unknown_tool", "parameters": {}}]]';
        expect(_repairBracketPseudoCalls(text, TOOL_NAMES)).toBeNull();
    });
    it('returns null for plain text with no bracket wrapper', () => {
        expect(_repairBracketPseudoCalls('I need to search for something.', TOOL_NAMES)).toBeNull();
    });
    it('returns null for empty tool list', () => {
        const text = '[[{"name": "web_search", "parameters": {"query": "q"}}]]';
        expect(_repairBracketPseudoCalls(text, [])).toBeNull();
        expect(_repairBracketPseudoCalls(text, null)).toBeNull();
    });
    it('returns null for a plain JSON array (not a tool-call envelope)', () => {
        expect(_repairBracketPseudoCalls('["a", "b", "c"]', TOOL_NAMES)).toBeNull();
    });
});

// glm5.3-flash wrote its tool calls as text: `read_file("game.js")`, and ended a turn with
// {"tool":"read_file","path":"fg-tasks/ledger.md"} as the answer (2026-09-29).
describe('_repairInlinePseudoCalls — whole reply is a call-syntax or flat-JSON pseudo-call', () => {
    const NAMES = ['read_file', 'write_file', 'execute_code', 'list_files'];
    const ORDER = { read_file: ['path', 'start_line', 'end_line'], execute_code: ['language', 'code'] };
    const r = (t) => _repairInlinePseudoCalls(t, NAMES, ORDER);
    it('python-style call, positional and keyword args', () => {
        expect(r('read_file("game.js")')).toEqual([{ name: 'read_file', args: { path: 'game.js' } }]);
        expect(r("read_file('a.js', 10, end_line=20)")).toEqual([{ name: 'read_file', args: { path: 'a.js', start_line: 10, end_line: 20 } }]);
        expect(r('read_file(path="a, b.js")')).toEqual([{ name: 'read_file', args: { path: 'a, b.js' } }]);
        expect(r('list_files()')).toEqual([{ name: 'list_files', args: {} }]);
    });
    it('several call lines and a fence around the reply', () => {
        expect(r('```\nread_file("a.js")\nread_file("b.js")\n```')).toEqual([
            { name: 'read_file', args: { path: 'a.js' } }, { name: 'read_file', args: { path: 'b.js' } }]);
    });
    it('flat JSON and JSON with an args envelope', () => {
        expect(r('{"tool":"read_file","path":"fg-tasks/ledger.md"}')).toEqual([{ name: 'read_file', args: { path: 'fg-tasks/ledger.md' } }]);
        expect(r('{"name":"read_file","arguments":{"path":"x"}}')).toEqual([{ name: 'read_file', args: { path: 'x' } }]);
        expect(r('{"name":"read_file","arguments":"{\\"path\\":\\"x\\"}"}')).toEqual([{ name: 'read_file', args: { path: 'x' } }]);
    });
    it('mixed or unparseable replies are left alone', () => {
        expect(r('I will now read the file.\nread_file("game.js")')).toBeNull();
        expect(r('The bug is in read_file("x") handling.')).toBeNull();
        expect(r('read_file(game.js)')).toBeNull();
        expect(r('read_file("a", "b", "c", "d")')).toBeNull();
        expect(r('{"tool":"unknown_tool","path":"x"}')).toBeNull();
        expect(r('{"path":"x"}')).toBeNull();
    });
});

describe('_repairPathArg — other names for the path argument of file tools', () => {
    it('moves file_name / file_path / filename to path', () => {
        const calls = [
            { name: 'read_file', args: { file_name: 'game.js' } },
            { name: 'write_file', args: { file_path: 'a.js', content: 'x' } },
            { name: 'replace_in_file', args: { filename: 'b.js', old_string: 'a', new_string: 'b' } },
        ];
        _repairPathArg(calls);
        expect(calls.map(c => c.args.path)).toEqual(['game.js', 'a.js', 'b.js']);
        expect(calls[0].args).toEqual({ path: 'game.js' });
    });
    it('leaves an existing path, and non-file tools, alone', () => {
        const calls = [
            { name: 'read_file', args: { path: 'a.js', file_name: 'b.js' } },
            { name: 'generate_image', args: { prompt: 'cat', filename: 'cat.png' } },
        ];
        _repairPathArg(calls);
        expect(calls[0].args.path).toBe('a.js');
        expect(calls[1].args).toEqual({ prompt: 'cat', filename: 'cat.png' });
    });
    it('runs inside repairAllToolCalls', () => {
        const { norm } = repairAllToolCalls([{ function: { name: 'read_file', arguments: '{"file_name":"memory/log.md"}' } }]);
        expect(norm[0].args).toEqual({ path: 'memory/log.md' });
    });
});
