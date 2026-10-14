// Every auxiliary model call is recorded (uploads review 2026-10-14, 9.1): a QA review or a summary used
// to leave no trace in the turn log, so it was in no request total.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeReplayFetch, FAKE_EP } from './replay-harness.ts';
import { NULL_TASK_HANDLE } from '../render-adapter.ts';

const W = window as any;
beforeAll(async () => { await import('../llm-loops.ts'); await import('../workers.ts'); await import('../convo-log.ts'); });
beforeEach(() => { localStorage.clear(); W.conversationLog.length = 0; });

describe('callLLMComplete logging', () => {
    it('records a non-judge label with its name and token usage', async () => {
        W.fetch = makeReplayFetch([{ content: 'NO', usage: { prompt_tokens: 120, completion_tokens: 3 } }]);
        await W.callLLMComplete('Check the criteria.', { maxTokens: 20, maxAttempts: 1, endpoint: FAKE_EP, label: 'qa:acceptance' }, NULL_TASK_HANDLE);
        const rec = W.conversationLog.find((e: any) => e.name === 'qa:acceptance');
        expect(rec).toBeTruthy();
        expect(rec.type).toBe('validation');
        expect(rec.promptTokens).toBe(120);
        expect(rec.response).toBe('NO');
    });
});
