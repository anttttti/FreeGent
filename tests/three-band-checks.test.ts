// Three-band checks (step-validator.ts) replacing regex-only judgments:
//  - autopilot step output (autopilot.ts _shouldReplan)
//  - task-intent detection (turn-context.ts isTaskCompletionRequest)
//  - merged-file placeholder detection (workers.ts _mergeLostContent)
// Deterministic bands never call the model; ambiguous text does, and the answer is followed.
import { describe, it, expect, beforeAll, vi } from 'vitest';

let AP: any, TC: any, WK: any;
const W = window as any;
beforeAll(async () => {
    await import('../step-validator.ts');
    AP = await import('../autopilot.ts');
    TC = await import('../turn-context.ts');
    WK = await import('../workers.ts');
});
const judge = (answer: string) => vi.fn(async () => answer);

describe('autopilot step output', () => {
    const replan = (text: string, llm: any) => { W.callLLMComplete = llm; return AP._shouldReplan(text, [], 0, false, ''); };

    it('empty output or a stall marker → replan, no model call', async () => {
        const llm = judge('NO');
        expect(await replan('', llm)).toMatch(/no meaningful output/);
        expect(await replan('*(max steps reached)*', llm)).toMatch(/no meaningful output/);
        expect(llm).not.toHaveBeenCalled();
    });

    it('a short but complete result → no replan, no model call (the old <50-char rule replanned it)', async () => {
        const llm = judge('YES');
        expect(await replan('Fixed in parser.py:88; tests pass.', llm)).toBeNull();
        expect(await replan('STATUS: complete', llm)).toBeNull();
        expect(llm).not.toHaveBeenCalled();
    });

    it('short output without clear markers → the model decides', async () => {
        expect(await replan('Looked at the config.', judge('YES'))).toMatch(/no meaningful output/);
        expect(await replan('Looked at the config.', judge('NO'))).toBeNull();
    });
});

describe('task-intent detection', () => {
    it('regex matches → task request; no task vocabulary → not; neither costs a model call', async () => {
        const llm = judge('NO');
        expect(await TC.isTaskCompletionRequest('Work on task 38', llm)).toBe(true);
        expect(await TC.isTaskCompletionRequest('Make the player jump higher', llm)).toBe(false);
        expect(llm).not.toHaveBeenCalled();
    });

    it('task wording the regex misses goes to the model', async () => {
        const yes = judge('YES');
        expect(await TC.isTaskCompletionRequest('start on the backlog', yes)).toBe(true);
        expect(await TC.isTaskCompletionRequest('do #3 next', yes)).toBe(true);
        expect(yes).toHaveBeenCalledTimes(2);
        expect(await TC.isTaskCompletionRequest('what does the tasks page show?', judge('NO'))).toBe(false);
    });
});

describe('merge placeholder detection', () => {
    const full = 'def a():\n    return 1\n\ndef b():\n    return 2\n';

    it('explicit placeholders in any comment syntax fail without a model call', async () => {
        const llm = judge('NO');
        for (const c of ['def a():\n    # ... existing code ...\n', '<div>\n<!-- rest unchanged -->\n</div>', 'function f() {\n  // ...\n}', 'x = 1\n(same as before)\n'])
            expect(await WK._mergeLostContent(c, 40, llm)).toBe(true);
        expect(llm).not.toHaveBeenCalled();
    });

    it('complete content passes; a bare Python ... stub body is not a placeholder', async () => {
        const llm = judge('YES');
        expect(await WK._mergeLostContent(full, full.length, llm)).toBe(false);
        const stub = 'class A:\n    def run(self) -> None:\n        ...\n';
        expect(await WK._mergeLostContent(stub, stub.length, llm)).toBe(false);
        expect(llm).not.toHaveBeenCalled();
    });

    it('noticeably shorter with no markers → the model decides', async () => {
        expect(await WK._mergeLostContent(full, full.length * 2, judge('YES'))).toBe(true);
        expect(await WK._mergeLostContent(full, full.length * 2, judge('NO'))).toBe(false);
    });
});
