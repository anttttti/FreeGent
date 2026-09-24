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

    it('a large array nested under a key is shrunk in place', async () => {
        serve({ query: 'q', results: tools });
        const r = await W.executeToolAsync('fetch_url', { url: 'http://api.test/search' });
        expect(r.content.query).toBe('q');
        expect(r.content.results.length).toBeGreaterThan(0);
        expect(r.content.results).toEqual(tools.slice(0, r.content.results.length));
        expect(JSON.stringify(r.content).length).toBeLessThanOrEqual(8000);
    });
});
