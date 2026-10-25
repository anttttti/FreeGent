// The task-intent check on an interactive send is a model call for ambiguous task wording. A slow, rate limited or
// out-of-quota utility model used to hold the whole send back (the user's message was not shown until it answered);
// with a time limit the check gives up and counts as "no match", as when the call fails.
import { describe, it, expect, beforeAll } from 'vitest';

describe('isTaskCompletionRequest time limit', () => {
    let isTaskCompletionRequest: any;
    beforeAll(async () => { await import('../step-validator.ts'); ({ isTaskCompletionRequest } = await import('../turn-context.ts')); });

    // "backlog" is task vocabulary without a completion phrasing: the regex cannot decide, so the model is asked.
    const AMBIGUOUS = 'is the backlog in a good state?';

    it('returns promptly when the model never answers', async () => {
        const hung = () => new Promise(() => {});
        const t0 = Date.now();
        expect(await isTaskCompletionRequest(AMBIGUOUS, hung, 100)).toBe(false);
        expect(Date.now() - t0).toBeLessThan(1500);
    });
    it('still uses the model answer when it comes in time', async () => {
        const yes = async () => 'yes';
        expect(await isTaskCompletionRequest(AMBIGUOUS, yes, 2000)).toBe(true);
    });
    it('a message with no task wording makes no model call', async () => {
        let calls = 0;
        expect(await isTaskCompletionRequest('what is the capital of France?', async () => { calls++; return 'yes'; }, 100)).toBe(false);
        expect(calls).toBe(0);
    });
});
