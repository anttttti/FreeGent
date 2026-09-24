// tool-result-fidelity.test.js — tool results reach the model intact: execute_code keeps stdout
// and stderr (exit 0 with an error signature gets a note, no LLM judge), and oversized fetch_url
// JSON is shrunk to valid JSON instead of a broken string slice.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const W = globalThis;

describe('execute_code result fidelity', () => {
    let origExec, llmSpy;
    const run = (res) => { W.nativeExec = async () => res; return W.executeToolAsync('execute_code', { language: 'bash', code: 'x' }); };
    beforeEach(() => {
        W.mainAgentRole = null;
        origExec = W.nativeExec;
        llmSpy = vi.fn(async () => 'ISSUE: judged');
        W.callLLMComplete = llmSpy;
    });
    afterEach(() => { W.nativeExec = origExec; });

    it('exit 0 + traceback in stderr: keeps all output and adds a note', async () => {
        const res = { stdout: 'repro output', stderr: 'Traceback (most recent call last):\n  File "x.py"\nImportError: cannot import name y', exit_code: 0 };
        const r = await run(res);
        expect(r.stdout).toBe('repro output');
        expect(r.stderr).toBe(res.stderr);
        expect(r.note).toMatch(/stderr contains errors/);
        expect(llmSpy).not.toHaveBeenCalled();
    });

    it.each([
        ['gcc -v style output', 'Using built-in specs.\nCOLLECT_GCC=gcc\nThread model: posix\ngcc version 13.2.0 (Ubuntu)'],
        ['a warning', 'x.py:3: DeprecationWarning: foo is deprecated'],
        ['progress output', '  % Total    % Received % Xferd\n100  1234  100  1234'],
    ])('exit 0 + %s: output kept unchanged, no note', async (_label, stderr) => {
        const res = { stdout: 'out', stderr, exit_code: 0 };
        const r = await run(res);
        expect(r).toEqual(res);
        expect(llmSpy).not.toHaveBeenCalled();
    });

    it('non-zero exit: result unchanged (the exit code already signals failure)', async () => {
        const res = { stdout: '', stderr: 'Error: boom', exit_code: 1 };
        expect(await run(res)).toEqual(res);
    });
});

describe('fetch_url JSON fitting', () => {
    let llmSpy;
    const serve = (json) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(json),
        { status: 200, headers: { 'content-type': 'application/json' } })));
    beforeEach(() => { W.mainAgentRole = null; llmSpy = vi.fn(); W.callLLMComplete = llmSpy; });
    afterEach(() => vi.unstubAllGlobals());

    const tools = Array.from({ length: 100 }, (_, i) => ({ name: `tool_${i}`, description: 'x'.repeat(150), parameters: { q: 'string' } }));

    it('small responses are returned as-is', async () => {
        serve({ ok: 1, items: [1, 2] });
        const r = await W.executeToolAsync('fetch_url', { url: 'http://api.test/x' });
        expect(r).toEqual({ status: 200, content: { ok: 1, items: [1, 2] } });
        expect(llmSpy).not.toHaveBeenCalled();
    });

    it('large arrays keep whole leading items, stay within budget, and count the rest', async () => {
        serve(tools);
        const r = await W.executeToolAsync('fetch_url', { url: 'http://api.test/search' });
        expect(Array.isArray(r.content)).toBe(true);
        expect(JSON.stringify(r.content).length).toBeLessThanOrEqual(8000);
        expect(r.content).toEqual(tools.slice(0, r.content.length));
        expect(r.truncated).toBe(true);
        expect(r.note).toContain(`dropped ${100 - r.content.length} array item(s)`);
        expect(llmSpy).not.toHaveBeenCalled();
    });

    it('a long string with escaped characters stays within the budget', async () => {
        serve({ log: 'line "quoted"\n\t'.repeat(2000) });   // every char pair escapes in JSON
        const r = await W.executeToolAsync('fetch_url', { url: 'http://api.test/log' });
        expect(typeof r.content.log).toBe('string');
        expect(r.content.log.endsWith('…')).toBe(true);
        expect(JSON.stringify(r.content).length).toBeLessThanOrEqual(8000);
    });

    it('a large array nested under a key is shrunk in place', async () => {
        serve({ query: 'q', results: tools });
        const r = await W.executeToolAsync('fetch_url', { url: 'http://api.test/search' });
        expect(r.content.query).toBe('q');
        expect(r.content.results.length).toBeGreaterThan(0);
        expect(r.content.results).toEqual(tools.slice(0, r.content.results.length));
        expect(JSON.stringify(r.content).length).toBeLessThanOrEqual(8000);
    });
});

describe('execute_code language', () => {
    let origExec, seen;
    const run = (args, res = { stdout: '', stderr: '', exit_code: 0 }) => {
        W.nativeExec = async (language) => { seen = language; return res; };
        return W.executeToolAsync('execute_code', args);
    };
    beforeEach(() => { W.mainAgentRole = null; origExec = W.nativeExec; seen = null; });
    afterEach(() => { W.nativeExec = origExec; });

    it.each([
        ['import os\nprint(os.getcwd())', 'python'],
        ['x = [1, 2]\ndef f(a):\n    return a\nprint(f(x))', 'python'],
        ['#!/usr/bin/env python3\nx = 1', 'python'],
        ['ls -la\ngrep -r foo .', 'bash'],
        ['python3 - <<EOF\nimport sys\nprint(sys.version)\nEOF', 'bash'],   // bash wrapping python
        ['python3 -c "import sys; print(1)"', 'bash'],
        ['#!/bin/bash\nimport_data.sh', 'bash'],
    ])('language omitted: %j runs as %s', async (code, lang) => {
        await run({ code });
        expect(seen).toBe(lang);
    });

    it('an explicit language is never overridden', async () => {
        await run({ code: 'import os\nprint(1)', language: 'bash' });
        expect(seen).toBe('bash');
    });

    it('explicit bash that fails on Python-looking code gets a hint', async () => {
        const r = await run({ code: 'import os\nprint(1)', language: 'bash' },
            { stdout: '', stderr: "bash: line 1: import: command not found\nbash: line 2: syntax error near unexpected token `1'", exit_code: 2 });
        expect(r.note).toMatch(/looks like Python code but ran as bash/);
    });

    it('no hint when explicit bash succeeds or the code is not Python', async () => {
        expect((await run({ code: 'import os\nprint(1)', language: 'bash' })).note).toBeUndefined();
        const r = await run({ code: 'ls /nope', language: 'bash' }, { stdout: '', stderr: 'ls: cannot access', exit_code: 2 });
        expect(r.note).toBeUndefined();
    });
});
