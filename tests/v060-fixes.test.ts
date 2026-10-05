// v060-fixes.test.ts — smaller fixes from the v0.60 benchmark reports: fetch_url body repair and
// schema type, early stop of repeating output, stub packages in the environment check, and the
// stuck nudge's wording for different probes with the same output.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { _repairFetchBody, repairAllToolCalls } from '../tool-call-repair.ts';
import { streamOAICompat, _degenerateTail, DEGENERATE_MIN_CHARS } from '../stream-decode.ts';
import { STUCK_SAME_OUTPUT_MSG, STUCK_SAME_HTML_MSG, sameOutputMsg } from '../detectors.ts';
import { envConfigEdits } from '../llm-loops.ts';

const W = window as any;
beforeAll(async () => { await import('../llm-loops.ts'); await import('../tool-schemas.ts'); });

describe('fetch_url body', () => {
    // v0.60 AutomationBench: 153 POST /execute calls held a complete body under params/parameters.
    it('moves params/parameters into body for a POST without one', () => {
        const calls = [
            { name: 'fetch_url', args: { method: 'POST', url: 'http://gw/execute', params: { tool: 't', params: { a: 1 } } } },
            { name: 'fetch_url', args: { method: 'POST', url: 'http://gw/execute', parameters: { tool: 't' } } },
        ];
        _repairFetchBody(calls);
        expect(calls[0].args).toEqual({ method: 'POST', url: 'http://gw/execute', body: { tool: 't', params: { a: 1 } } });
        expect((calls[1].args as any).body).toEqual({ tool: 't' });
    });

    it('leaves GET query params, existing bodies and other tools alone', () => {
        const calls = [
            { name: 'fetch_url', args: { url: 'http://x/search', params: { q: 'a' } } },
            { name: 'fetch_url', args: { method: 'POST', url: 'http://x', body: { a: 1 }, params: { b: 2 } } },
            { name: 'execute_code', args: { code: 'ls', params: { a: 1 } } },
        ];
        const before = JSON.stringify(calls);
        _repairFetchBody(calls);
        expect(JSON.stringify(calls)).toBe(before);
    });

    it('lifts params into an empty body, but never over a body with content', () => {
        const calls = [
            { name: 'fetch_url', args: { method: 'POST', url: 'u', body: {}, params: { a: 1 } } },
            { name: 'fetch_url', args: { method: 'POST', url: 'u', body: '', json: '{"b":2}' } },
            { name: 'fetch_url', args: { method: 'POST', url: 'u', body: { keep: 1 }, params: { a: 1 } } },
        ];
        _repairFetchBody(calls);
        expect((calls[0].args as any).body).toEqual({ a: 1 });
        expect((calls[1].args as any).body).toBe('{"b":2}');
        expect((calls[2].args as any).body).toEqual({ keep: 1 });
    });

    // v0.61 AutomationBench: 39 calls died on "Request with GET/HEAD method has a body".
    it('makes a body with no method a POST, and leaves an explicit GET alone', () => {
        const calls = [
            { name: 'fetch_url', args: { url: 'http://gw/execute', body: { tool: 't' } } },
            { name: 'fetch_url', args: { url: 'http://gw/x', method: 'GET', body: { a: 1 } } },
            { name: 'fetch_url', args: { url: 'http://gw/search?q=a' } },
        ];
        _repairFetchBody(calls);
        expect((calls[0].args as any).method).toBe('POST');
        expect((calls[1].args as any).method).toBe('GET');
        expect((calls[2].args as any).method).toBeUndefined();
    });

    it('explains a GET with a body instead of surfacing the browser error', async () => {
        const r = await W.executeToolAsync('fetch_url', { url: 'http://gw.example/x', method: 'GET', body: { a: 1 } });
        expect(r.error).toMatch(/cannot carry a body.*"POST"/);
    });

    it('runs as part of repairAllToolCalls', () => {
        const { norm } = repairAllToolCalls([{ function: { name: 'fetch_url', arguments: JSON.stringify({ method: 'POST', url: 'u', data: '{"x":1}' }) } }]);
        expect(norm[0].args.body).toBe('{"x":1}');
    });

    // An untyped property reaches Gemma's chat template as type:"" (v0.60: 57% of POSTs had no body).
    it('the schema gives body a type', () => {
        const fetch = W.activeTools(false, new Set(['fetch_url']), true).find((t: any) => t.name === 'fetch_url');
        expect(fetch.parameters.properties.body.type).toBe('object');
    });
});

describe('repeating output', () => {
    const fill = (unit: string, n = DEGENERATE_MIN_CHARS + 500) => unit.repeat(Math.ceil(n / unit.length));

    // Shapes of v0.60's cut-offs: repeated lines, a URL query of repeated terms, a periodic tail.
    it('flags repeated lines, repeated query terms and periodic tails', () => {
        const prose = 'Checked the config loader and the registry; neither defines make_config. ';
        expect(_degenerateTail(prose.repeat(10) + fill("I'll try to search for \"Hours Tracker\" in the API.\n"))).toBeTruthy();
        expect(_degenerateTail('http://gw/search?q=' + fill('timesheet_list_files|hours_tracker_list_files|'))).toBeTruthy();
        expect(_degenerateTail(fill('# I already did that.\\n# Let me check utils.go.\\n'))).toBeTruthy();
    });

    it('leaves normal long output alone', () => {
        const code = Array.from({ length: 200 }, (_, i) => `def f${i}(x):\n    return x * ${i} + ${i * 7 % 13}\n`).join('\n');
        expect(_degenerateTail(code)).toBeNull();
        expect(_degenerateTail('short ' + 'a|'.repeat(50))).toBeNull();   // under the minimum length
        const table = Array.from({ length: 150 }, (_, i) => `| row ${i} | ${(i * 37) % 101} | ok |`).join('\n');
        expect(_degenerateTail(table)).toBeNull();
    });

    it('stops the stream early and reports finish_reason "repetition"', async () => {
        const enc = new TextEncoder();
        const piece = '|timesheet_list_files|hours_tracker_list_files';
        const events = [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'fetch_url', arguments: '{"url": "http://gw/search?q=a' } }] } }] },
            ...Array.from({ length: 400 }, () => ({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] } }] }))];
        const lines = events.map(e => `data: ${JSON.stringify(e)}\n`);
        let i = 0, cancelled = false;
        const resp = { body: {
            getReader: () => ({ read: async () => i < lines.length ? { value: enc.encode(lines[i++]), done: false } : { value: undefined, done: true },
                cancel: async () => {}, releaseLock: () => {} }),
            cancel: async () => { cancelled = true; },
        } };
        const msg: any = await streamOAICompat(resp, () => {});
        expect(msg.finish_reason).toBe('repetition');
        expect(msg.degenerate).toBeTruthy();
        expect(cancelled).toBe(true);
        expect(i).toBeLessThan(lines.length);
    });
});

describe('repetitive file payloads (R10)', () => {
    const stream = async (name: string, rows: number) => {
        const enc = new TextEncoder();
        const row = 'id,name,value\\n1,sample,42\\n';
        const events = [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name, arguments: '{"path":"data.csv","content":"' } }] } }] },
            ...Array.from({ length: rows }, () => ({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: row } }] } }] })),
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] }, finish_reason: 'tool_calls' }] }];
        const lines = events.map(e => `data: ${JSON.stringify(e)}\n`).concat('data: [DONE]\n');
        let i = 0;
        const resp = { body: {
            getReader: () => ({ read: async () => i < lines.length ? { value: enc.encode(lines[i++]), done: false } : { value: undefined, done: true },
                cancel: async () => {}, releaseLock: () => {} }),
            cancel: async () => {},
        } };
        return streamOAICompat(resp, () => {}) as Promise<any>;
    };
    it('does not cut off a valid repetitive write_file', async () => {
        const msg = await stream('write_file', 400);   // ~11K chars of identical rows
        expect(msg.finish_reason).not.toBe('repetition');
        expect(msg.degenerate).toBeFalsy();
    });
    it('still cuts off the same runaway in a non-content tool', async () => {
        const msg = await stream('execute_code', 400);
        expect(msg.finish_reason).toBe('repetition');
    });
});

describe('environment check: stub packages', () => {
    afterEach(() => { delete (globalThis as any).fgChangedFiles; delete (globalThis as any).fgNewFiles; });

    // v0.60 django-12747 shipped asgiref/ and pytz/, astropy-13398 erfa/.
    it('names a new top-level package the task does not mention', async () => {
        (globalThis as any).fgChangedFiles = async () => ['django/db/models/deletion.py', 'asgiref/__init__.py'];
        (globalThis as any).fgNewFiles = async () => ['asgiref/__init__.py', 'asgiref/local.py', 'django/new_mod/__init__.py', 'repro.py'];
        expect(await envConfigEdits('Fix QuerySet.delete() results.')).toEqual(['asgiref/']);
        expect(await envConfigEdits('Add an asgiref compatibility package.')).toEqual([]);
    });
});

describe('stuck nudge wording', () => {
    it('says the probes differed when they did', () => {
        expect(STUCK_SAME_OUTPUT_MSG).toMatch(/were different but all printed the same output/);
    });

    // v0.61 TAC / AutomationBench: API tasks were told to "make the change in the code itself".
    it('gives advice that holds for API work as well as code edits', () => {
        expect(STUCK_SAME_OUTPUT_MSG).not.toMatch(/make the change in the code|give your answer/i);
        expect(STUCK_SAME_OUTPUT_MSG).toMatch(/URL, method, headers or payload/);
        expect(STUCK_SAME_OUTPUT_MSG).toMatch(/the code itself/);
    });

    it('says an HTML page is a web page, not data, when that is what repeated', () => {
        const page = '<!DOCTYPE html><html><head><title>Rocket.Chat</title></head>';
        expect(sameOutputMsg([page, page, page])).toBe(STUCK_SAME_HTML_MSG);
        expect(sameOutputMsg(['  <html lang="en">…'])).toBe(STUCK_SAME_HTML_MSG);
        expect(STUCK_SAME_HTML_MSG).toMatch(/\/api\/ prefix/);
        expect(sameOutputMsg(['[]'])).toBe(STUCK_SAME_OUTPUT_MSG);
        expect(sameOutputMsg([page, '{"ok":true}'])).toBe(STUCK_SAME_OUTPUT_MSG);
        expect(sameOutputMsg([])).toBe(STUCK_SAME_OUTPUT_MSG);
    });
});
