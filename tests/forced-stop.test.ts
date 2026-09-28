// Forced stops end the run (v0.57 fixes review §1).
// v0.57: _gracefulSynthesis text often failed the line-leading BLOCKED check ("… BLOCKED: x" mid-line,
// or the "*(stopped: …)*" fallback), so the turn read as 'running' and directorLoop ran up to 4 more
// 100-step turns after repeat / failure-streak / step-limit stops (1,102 SWE steps).
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { directorLoop, STEP_LIMIT_PROMPT } from '../loop-director.ts';

let L: any;
beforeAll(async () => { L = await import('../llm-loops.ts'); });
afterEach(() => { delete (globalThis as any).callLLMComplete; });

const BLOCKED_RE = /^\*{0,2}BLOCKED\*{0,2}:/im;

describe('_gracefulSynthesis', () => {
    it('ends with a line-leading BLOCKED when the summary puts it mid-line', async () => {
        (globalThis as any).callLLMComplete = vi.fn(async () => 'Edited utils.py but tests still fail. BLOCKED: out of steps.');
        const t = await L._gracefulSynthesis('step budget exhausted');
        expect(t).toMatch(BLOCKED_RE);
        expect(L.getTurnStopInfo().reason).toBe('step budget exhausted');
        const S = await import('../state.ts');
        expect(S._lastTurnBlockedToken).toBe(true);
    });
    it('keeps a summary that already has a line-leading BLOCKED unchanged', async () => {
        (globalThis as any).callLLMComplete = vi.fn(async () => 'Nothing changed.\nBLOCKED: repeated calls');
        expect(await L._gracefulSynthesis('it kept repeating calls')).toBe('Nothing changed.\nBLOCKED: repeated calls');
    });
    it('the fallback text (no summariser, or it throws) is BLOCKED too', async () => {
        expect(await L._gracefulSynthesis('10 consecutive tool failures with no progress')).toMatch(BLOCKED_RE);
        (globalThis as any).callLLMComplete = vi.fn(async () => { throw new Error('down'); });
        expect(await L._gracefulSynthesis('step budget exhausted')).toMatch(BLOCKED_RE);
    });
});

describe('directorLoop after a forced stop', () => {
    const turn = (finishSignal: any, stop: any = { reason: null, edited: false }) => ({ text: '', finishSignal, stop, usage: {} as any, steps: [] });
    const run = (results: any[]) => {
        const prompts: string[] = [];
        const fn = vi.fn(async (p: string) => { prompts.push(p); return results.shift(); });
        return { fn, prompts };
    };
    const opts = { maxContinuations: 4, stepLimitContinuations: 1 };

    it('a repeat or failure-streak stop ends the run', async () => {
        for (const reason of ['it kept repeating calls that had already returned the same result many times', '10 consecutive tool failures with no progress']) {
            const { fn } = run([turn('blocked', { reason, edited: true })]);
            await directorLoop(fn, {} as any, 'task', opts);
            expect(fn).toHaveBeenCalledTimes(1);
        }
    });
    it('a step-limit stop after edits gets exactly one closing turn', async () => {
        const { fn, prompts } = run([
            turn('blocked', { reason: 'step budget exhausted', edited: true }),
            turn('blocked', { reason: 'step budget exhausted', edited: false }),
            turn('running'),
        ]);
        const r = await directorLoop(fn, {} as any, 'task', opts);
        expect(fn).toHaveBeenCalledTimes(2);
        expect(prompts[1]).toBe(STEP_LIMIT_PROMPT);
        expect(r.finishSignal).toBe('blocked');
    });
    it('edits from an earlier turn count', async () => {
        const { fn } = run([
            turn('running', { reason: null, edited: true }),
            turn('blocked', { reason: 'maximum step limit reached', edited: false }),
            turn('complete'),
        ]);
        const r = await directorLoop(fn, {} as any, 'task', opts);
        expect(fn).toHaveBeenCalledTimes(3);
        expect(r.finishSignal).toBe('complete');
    });
    it('a step-limit stop with no edits ends the run; so does the default (0 closing turns)', async () => {
        const a = run([turn('blocked', { reason: 'step budget exhausted', edited: false })]);
        await directorLoop(a.fn, {} as any, 'task', opts);
        expect(a.fn).toHaveBeenCalledTimes(1);
        const b = run([turn('blocked', { reason: 'step budget exhausted', edited: true })]);
        await directorLoop(b.fn, {} as any, 'task', { maxContinuations: 4 });
        expect(b.fn).toHaveBeenCalledTimes(1);
    });
});
