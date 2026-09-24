// turn-error.test.ts — a turn that throws reports finishSignal 'error', and the director loop
// stops there instead of running continuation turns against a history whose task message was
// rolled back.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { directorLoop } from '../loop-director.ts';
import { KEYS } from '../storage-keys.ts';

const W = window as any;

beforeAll(async () => {
    await import('../llm-loops.ts');
    await import('../agent-core.ts');
    await import('../chat-state.ts');   // saveHistory, used by runAgentTurn's teardown
});

beforeEach(() => {
    localStorage.clear();
    W.mainAgentRole = null;
    W.setSoftStopPending?.(false);
    W.addVoiceButtons ??= () => {};   // UI hook reached by setInputState; not loaded in this test env
    localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify(['openrouter|test-model']));
    localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
});

describe('directorLoop', () => {
    it('does not continue after an errored turn', async () => {
        const runOne = vi.fn(async () => ({ text: '**Error:** boom', finishSignal: 'error' as const, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, steps: [] }));
        const res = await directorLoop(runOne, W.createSession({ workflowMode: true }), 'task', { maxContinuations: 4 });
        expect(runOne).toHaveBeenCalledTimes(1);
        expect(res.finishSignal).toBe('error');
    });
});

describe('runAgentTurn', () => {
    it('reports error (not running) when the turn throws', async () => {
        // A permanent error: runTurn rethrows it instead of retrying.
        W.fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'The model `test-model` does not exist.' } }),
            { status: 404, headers: { 'content-type': 'application/json' } }));
        const session = W.createSession({ workflowMode: true });
        const res = await W.runAgentTurn('Do the task.', null, session);
        expect(res.finishSignal).toBe('error');
        expect(res.text).toMatch(/^\*\*Error:\*\*/);
    });
});
