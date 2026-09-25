// output-cap.test.ts — runaway generations: local endpoints get an absolute per-step output cap,
// and a tool call cut off at max_tokens is discarded (not executed, not kept in history) and the
// model is told why — even when the stream reports finish_reason "tool_calls" (vLLM does).
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { makeReplayFetch, FAKE_EP } from './replay-harness.ts';
import { NULL_RENDER_ADAPTER } from '../render-adapter.ts';
import { KEYS } from '../storage-keys.ts';

const W = window as any;

beforeAll(async () => {
    await import('../llm-loops.ts');
    await import('../chat-state.ts');
    await import('../step-validator.ts');
});

beforeEach(() => {
    localStorage.clear();
    W.mainAgentRole = null;
    // Single-model pool, so a truncated response is not retried on another model.
    localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify([`${FAKE_EP.provider}|${FAKE_EP.model}`]));
    localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
    W._sessionToolFilter = new Set(['execute_code']);
});

describe('per-step output cap (local endpoints)', () => {
    it('caps max_tokens at 8192 instead of 25% of the context window', async () => {
        localStorage.setItem('fg_openai_context', '60000');
        const bodies: any[] = [];
        W.fetch = makeReplayFetch([{ content: 'ok' }], { onRequest: b => bodies.push(b) });
        const ep = { provider: 'vllm', url: 'http://vllm.test/v1/chat/completions', model: 'm', key: '' };
        const res = await W.callOAI(() => {}, null, { localHistory: [{ role: 'user', content: 'hi' }], endpointOverride: ep });
        expect(bodies[0].max_tokens).toBe(8192);
        expect(res._maxTokens).toBe(8192);
    });
});

describe('tool call cut off at max_tokens', () => {
    it('is discarded and the model is told why, even without finish_reason "length"', async () => {
        const exec = vi.fn(async () => ({ stdout: 'ran', stderr: '', exit_code: 0 }));
        W.nativeExec = exec;
        W.setOpenaiHistory([{ role: 'user', content: 'Solve the puzzle.' }]);
        W.fetch = makeReplayFetch([
            // Runaway: completion_tokens at the cap; the replay sends no finish_reason at all.
            { tool_calls: [{ id: 'run1', type: 'function', function: { name: 'execute_code', arguments: '{"language":"python","code":"# Let\'s try...\\n# Let\'s try..."}' } }],
              usage: { completion_tokens: 999_999 } },
            { content: 'The answer is 7.\nCOMPLETED' },
        ]);
        const result = await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        expect(exec).not.toHaveBeenCalled();
        const hist = W.openaiHistory;
        expect(hist.some((m: any) => m.tool_calls?.some((tc: any) => tc.id === 'run1'))).toBe(false);
        expect(hist.some((m: any) => typeof m.content === 'string' && m.content.includes('cut off at 999999 tokens while writing tool-call arguments'))).toBe(true);
        expect(result).toContain('The answer is 7.');
    });

    it('a normal-size tool call still runs', async () => {
        const exec = vi.fn(async () => ({ stdout: 'ran', stderr: '', exit_code: 0 }));
        W.nativeExec = exec;
        W.setOpenaiHistory([{ role: 'user', content: 'Solve the puzzle.' }]);
        W.fetch = makeReplayFetch([
            { tool_calls: [{ id: 'ok1', type: 'function', function: { name: 'execute_code', arguments: '{"language":"bash","code":"echo hi"}' } }],
              usage: { completion_tokens: 40 } },
            { content: 'Done.\nCOMPLETED' },
        ]);
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        expect(exec).toHaveBeenCalledTimes(1);
    });
});

describe('tool call cut off by the context clamp', () => {
    // Local endpoint with a small window: max_tokens is clamped below the 8192 step cap.
    const LOCAL_EP = { provider: 'vllm', url: 'http://vllm.test/v1/chat/completions', model: 'm', key: '' };
    const cutCall = { tool_calls: [{ id: 'cut1', type: 'function', function: { name: 'execute_code', arguments: '{"language":"bash","code":"echo"}' } }],
                      usage: { completion_tokens: 999_999 } };

    async function run(contextTokens: string) {
        localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify([`${LOCAL_EP.provider}|${LOCAL_EP.model}`]));
        localStorage.setItem('fg_openai_context', contextTokens);
        W.nativeExec = vi.fn(async () => ({ stdout: '', stderr: '', exit_code: 0 }));
        W.setOpenaiHistory([{ role: 'user', content: 'Solve the puzzle.' }]);
        const bodies: any[] = [];
        W.fetch = makeReplayFetch([cutCall, { content: 'Summary of the work so far.' }, { content: 'The answer is 7.\nCOMPLETED' }],
            { onRequest: b => bodies.push(b) });
        await W.runTurn(LOCAL_EP, NULL_RENDER_ADAPTER);
        return bodies;
    }

    it('compacts before retrying when max_tokens was clamped below the step cap', async () => {
        const bodies = await run('6000');
        expect(bodies[0].max_tokens).toBeLessThan(8192);
        expect(bodies[1].tool_choice).toBe('none');   // the compaction request
    });

    it('retries without compacting when the cut-off was at the full step cap', async () => {
        const bodies = await run('60000');
        expect(bodies[0].max_tokens).toBe(8192);
        expect(bodies.some(b => b.tool_choice === 'none')).toBe(false);
    });
});
