// Small-budget utility calls (callLLMComplete) against models that always reason: Gemma 4 on
// Google's API thinks inline in <thought> tags and rejects thinking-off with HTTP 400, so a
// 40-token suggestion came back with no visible text. An empty reply that streamed reasoning is
// retried once on the same endpoint with room for the reasoning.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeReplayFetch, FAKE_EP } from './replay-harness.ts';
import { NULL_TASK_HANDLE } from '../render-adapter.ts';

const W = window as any;
beforeAll(async () => { await import('../llm-loops.ts'); await import('../workers.ts'); });
beforeEach(() => { localStorage.clear(); });

describe('callLLMComplete — reasoning-only replies', () => {
    it('retries with a larger budget when the reply was all reasoning', async () => {
        const bodies: any[] = [];
        W.fetch = makeReplayFetch([
            { content: '<thought>Target: five words. "Hello, how are you today?"' },
            { content: '<thought>Five words.</thought>Hello, how are you today?' },
        ], { onRequest: (b: any) => bodies.push(b) });
        const out = await W.callLLMComplete('Say hello in five words.', { maxTokens: 40, maxAttempts: 1, endpoint: FAKE_EP }, NULL_TASK_HANDLE);
        expect(out.trim()).toBe('Hello, how are you today?');
        expect(bodies).toHaveLength(2);
        expect(bodies[0].max_tokens).toBe(40);
        expect(bodies[1].max_tokens).toBe(40 + 4096);
    });

    it('does not retry an empty reply without reasoning (provider swallowed the request)', async () => {
        const bodies: any[] = [];
        W.fetch = makeReplayFetch([{ content: '' }, { content: 'should not be requested' }], { onRequest: (b: any) => bodies.push(b) });
        const out = await W.callLLMComplete('Say hello.', { maxTokens: 40, maxAttempts: 1, endpoint: FAKE_EP }, NULL_TASK_HANDLE).catch(() => '');
        expect(out).toBe('');
        expect(bodies).toHaveLength(1);
    });
});
