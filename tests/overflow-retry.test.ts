// A request the endpoint refuses as over its context window: the turn compacts and sends the step again, it does not stop.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { FAKE_EP } from './replay-harness.ts';
import { NULL_RENDER_ADAPTER } from '../render-adapter.ts';
import { parseContextOverflow } from '../retry.ts';
import { KEYS } from '../storage-keys.ts';
import { pushHistory } from './history-helpers.ts';

const W = window as any;
beforeAll(async () => { await import('../llm-loops.ts'); await import('../llm-shared.ts'); await import('../step-validator.ts'); });
beforeEach(() => {
    localStorage.clear();
    W.mainAgentRole = null;
    localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify(['openrouter|qwen/qwen3-30b-a3b']));
    localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
});

const ok = (message: any) => new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 50, completion_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } });
let WORDING = "This model's maximum context length is 8000 tokens. However, your messages resulted in 9000 tokens. Please reduce the length of the messages.";
const overflow = () => new Response(JSON.stringify({ error: { message: WORDING } }), { status: 400, headers: { 'content-type': 'application/json' } });

// Provider wordings of "the prompt does not fit": each must be read as an overflow (compact and send again), not as a failure to retry unchanged or to stop on.
const WORDINGS: Array<[string, string, (n: number | null) => boolean]> = [
    ['openrouter', "[openrouter|x] HTTP 400: This endpoint's maximum context length is 262144 tokens. However, you requested about 270000 tokens (260000 of text input, 10000 in the output).", n => n === 262144 - 260000 - 256],
    ['anthropic', 'HTTP 400: prompt is too long: 210000 tokens > 200000 maximum', n => n !== null && n <= 0],
    ['gemini', 'HTTP 400: The input token count (1100000) exceeds the maximum number of tokens allowed (1048576).', n => n !== null && n <= 0],
    ['mistral', 'HTTP 400: Prompt contains 140000 tokens, too large for model with 131072 maximum context length', n => n !== null && n <= 0],
    ['generic code', 'HTTP 400: context_length_exceeded', n => n !== null && n <= 0],
    ['configured limit', 'HTTP 400: Input tokens exceed the configured limit of 262144 tokens. Your messages resulted in 270000 tokens.', n => n !== null && n <= 0],
    ['groq TPM rate limit is not one', 'HTTP 413: Request too large for model `llama` on tokens per minute (TPM): Limit 6000, Requested 8000', n => n === null],
    ['max_tokens cap is not one', 'HTTP 400: `max_tokens` must be less than or equal to `8192`, the maximum value for `max_tokens`', n => n === null],
];
describe('parseContextOverflow reads the providers\' wordings', () => {
    it.each(WORDINGS)('%s', (_n, msg, check) => { expect(check(parseContextOverflow(new Error(msg)))).toBe(true); });
});

describe('context overflow in a turn', () => {
    it.each([[1, 'vllm/openai'], [2, 'vllm/openai'], [1, WORDINGS[1][1]], [2, WORDINGS[2][1]]])('refused at step %i (%s): compacts, sends the step again and finishes', async (refuseAt, wording) => {
        if (wording !== 'vllm/openai') WORDING = wording as string;
        const s = W.createSession({ workflowMode: true });
        pushHistory(s, { role: 'user', content: 'Do the task.' });
        W._sessionToolFilter = new Set(['list_files', 'execute_code']);
        const kinds: string[] = [];
        let main = 0;
        W.fetch = vi.fn(async (u: string, init: any) => {
            if (!String(u).includes('/chat/completions')) return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({}) } as any;
            const b = JSON.parse(init.body);
            const last = String(b.messages.at(-1)?.content ?? '');
            if (/This is a summarization request/.test(last)) { kinds.push('compact'); return ok({ role: 'assistant', content: 'GOAL: x\nDONE: listed' }); }
            const n = main++;
            if (n === refuseAt) { kinds.push('refused'); return overflow(); }
            if (n < 2 && n !== refuseAt || (n === 2 && refuseAt === 1)) { kinds.push('tool'); return ok({ role: 'assistant', content: null, tool_calls: [{ id: `c${n}`, type: 'function', function: { name: 'list_files', arguments: JSON.stringify({ path: `d${n}` }) } }] }); }
            kinds.push('final'); return ok({ role: 'assistant', content: 'Done.\nCOMPLETED' });
        });
        const text = await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER, { session: s, maxSteps: 10 });
        expect(kinds.at(-1)).toBe('final');
        expect(text).toMatch(/Done/);
        expect(kinds.slice(kinds.indexOf('refused'), kinds.indexOf('refused') + 3)).toEqual(['refused', 'compact', refuseAt === 1 ? 'tool' : 'final']);   // the refused step is sent again after the compaction
    });
});
