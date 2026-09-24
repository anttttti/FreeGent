// compaction.test.ts — compactHistory: the request repeats the main loop's prefix (system prompt,
// tools, messages) plus one instruction, with a small output cap; a vLLM context overflow is
// retried at once with a halved budget; the rebuilt history keeps anchor + summary + harness
// facts + a verbatim tail of complete tool-call pairs; a failed summary still shrinks history.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { NULL_RENDER_ADAPTER } from '../render-adapter.ts';
import { buildRequestMessages } from '../payload-builder.ts';
import { parseContextOverflow } from '../retry.ts';

const W = window as any;
const EP = { provider: 'vllm', url: 'http://vllm.test/v1/chat/completions', model: 'm', key: '' };
const PREFIX = { system: 'MAIN SYSTEM PROMPT', tools: [{ type: 'function', function: { name: 'execute_code', parameters: {} } }] };

beforeAll(async () => {
    await import('../llm-loops.ts');
    await import('../llm-shared.ts');
});

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('fg_openai_context', '60000');
    // Benchmark retry settings: any retry that used the global delay would stall this test.
    localStorage.setItem('fg_retry_mode', 'fixed');
    localStorage.setItem('fg_retry_fixed_ms', '120000');
});

function history(): any[] {
    const h: any[] = [{ role: 'user', content: 'Fix the bug in calc.py.' }];
    for (let i = 0; i < 8; i++) {
        h.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'execute_code', arguments: JSON.stringify({ code: `step ${i}` }) } }] });
        h.push({ role: 'tool', tool_call_id: `c${i}`, name: 'execute_code', content: JSON.stringify({ stdout: `out ${i}`, exit_code: 0 }) });
    }
    h.push({ role: 'assistant', content: null, tool_calls: [{ id: 'w1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'calc.py', content: 'x' }) } }] });
    h.push({ role: 'tool', tool_call_id: 'w1', name: 'write_file', content: JSON.stringify({ ok: true }) });
    return h;
}

function serve(replies: Array<{ status?: number; body: any }>) {
    const bodies: any[] = [];
    W.fetch = vi.fn(async (_u: string, init: any) => {
        bodies.push(JSON.parse(init.body));
        const r = replies.shift() ?? { body: { choices: [{ message: { content: 'GOAL: x' } }] } };
        return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    });
    return bodies;
}

const ok = (content: string) => ({ body: { choices: [{ message: { content } }], usage: {} } });

describe('compactHistory request', () => {
    it('repeats the main prefix and appends one instruction, with a small output cap', async () => {
        const bodies = serve([ok('GOAL: fix calc.py\nNEXT: run tests')]);
        const h = history();
        const s = W.createSession({ workflowMode: true });
        await W.compactHistory(NULL_RENDER_ADAPTER, EP, s, h, PREFIX);
        const req = bodies[0];
        expect(req.messages[0]).toEqual({ role: 'system', content: PREFIX.system });
        expect(req.tools).toEqual(PREFIX.tools);
        expect(req.messages.slice(1, -1)).toEqual(buildRequestMessages(h, 'vllm'));
        expect(req.messages.at(-1).content).toMatch(/^Summarize this agent session/);
        expect(req.tool_choice).toBe('none');
        expect(req.max_tokens).toBeLessThanOrEqual(2000);
    });

    it('retries a vLLM overflow immediately with a halved budget', async () => {
        const overflow = { status: 400, body: { error: { message: "This model's maximum context length is 60000 tokens. However, you requested 2000 output tokens and your prompt contains at least 58001 input tokens, for a total of at least 60001 tokens." } } };
        const bodies = serve([overflow, ok('GOAL: fix calc.py')]);
        const s = W.createSession({ workflowMode: true });
        const t0 = Date.now();
        await W.compactHistory(NULL_RENDER_ADAPTER, EP, s, history(), PREFIX);
        expect(Date.now() - t0).toBeLessThan(5000);
        expect(bodies).toHaveLength(2);
        expect(bodies[1].max_tokens).toBe(Math.floor(bodies[0].max_tokens / 2));
    });
});

describe('compactHistory result', () => {
    it('rebuilds anchor + summary with harness facts + a tail of complete tool pairs', async () => {
        serve([ok('GOAL: fix calc.py\nNEXT: run tests')]);
        const h = history();
        const s = W.createSession({ workflowMode: true });
        const ret = await W.compactHistory(NULL_RENDER_ADAPTER, EP, s, h, PREFIX);
        expect(ret).toBeUndefined();
        expect(s.history[0].role).toBe('user');
        expect(s.history[0].content).toContain('Fix the bug in calc.py.');   // anchor (pinned outside workflow mode)
        expect(s.history[1].content).toMatch(/^\[SYSTEM: The conversation history above has been compacted/);
        expect(s.history[1].content).toContain('GOAL: fix calc.py');
        expect(s.history[1].content).toContain('Files written this session: calc.py');
        const tail = s.history.slice(2);
        expect(tail.length).toBeGreaterThan(0);
        expect(tail[0].role).toBe('assistant');                  // starts at a tool call, not an orphan result
        expect(tail).toEqual(h.slice(h.length - tail.length));    // verbatim
    });

    it('a TASK_COMPLETE-style reply is just a summary — it never ends the task', async () => {
        serve([ok('TASK_COMPLETE:\nThe fix is done.')]);
        const s = W.createSession({ workflowMode: true });
        const ret = await W.compactHistory(NULL_RENDER_ADAPTER, EP, s, history(), PREFIX);
        expect(ret).toBeUndefined();
        expect(s.history[1].content).toContain('The fix is done.');
    });

    it('a failed summary still shrinks history to anchor + stub + tail (no throw)', async () => {
        serve([ok('<tool_call>{"name":"execute_code"}</tool_call>')]);
        const h = history();
        const s = W.createSession({ workflowMode: true });
        await W.compactHistory(NULL_RENDER_ADAPTER, EP, s, h, PREFIX);
        expect(s.history.length).toBeLessThan(h.length);
        expect(s.history[1].content).toMatch(/summarizer failed/);
        expect(s.history[1].content).toContain('Files written this session: calc.py');
    });
});

describe('parseContextOverflow — vLLM lower-bound wording', () => {
    it('halves the requested output instead of trusting "at least N"', () => {
        const e = new Error("maximum context length is 60000 tokens. However, you requested 16000 output tokens and your prompt contains at least 44001 input tokens, for a total of at least 60001 tokens.");
        expect(parseContextOverflow(e)).toBe(8000);
    });
    it('reports no headroom once the halved budget is tiny', () => {
        const e = new Error("maximum context length is 60000 tokens. However, you requested 300 output tokens and your prompt contains at least 59701 input tokens, for a total of at least 60001 tokens.");
        expect(parseContextOverflow(e)).toBe(0);
    });
});
