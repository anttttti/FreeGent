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

describe('_gracefulSynthesis keeps an answer on the last line (v0.58 CTF 48)', () => {
    it('BLOCKED comes first, so the graded last line is the summary or answer', async () => {
        (globalThis as any).callLLMComplete = vi.fn(async () => 'picoCTF{c0nv3rt1ng_fr0m_ba5e_64_e3152bf4}');
        const t = await L._gracefulSynthesis('it kept repeating calls that had already returned the same result many times');
        expect(t).toMatch(BLOCKED_RE);
        expect(t.trim().split('\n').at(-1)).toBe('picoCTF{c0nv3rt1ng_fr0m_ba5e_64_e3152bf4}');
        const { _stripTerminal } = await import('../turn-protocol.ts');
        expect(_stripTerminal(t).trim().split('\n').at(-1)).toBe('picoCTF{c0nv3rt1ng_fr0m_ba5e_64_e3152bf4}');
    });
    it('the summary request carries the task and the recent tool outputs', async () => {
        const { makeReplayFetch, FAKE_EP } = await import('./replay-harness.ts');
        const { NULL_RENDER_ADAPTER } = await import('../render-adapter.ts');
        await import('../step-validator.ts');
        localStorage.clear();
        localStorage.setItem('fg_main_models', JSON.stringify(['openrouter|qwen/qwen3-30b-a3b']));
        localStorage.setItem('fg_openrouter_key', 'test-key');
        (window as any).mainAgentRole = null;
        (window as any)._sessionToolFilter = new Set(['list_files']);
        const s = (window as any).createSession({ workflowMode: true });
        s.history.push({ role: 'user', content: 'Decode the flag in flag.txt.' });
        const prompts: string[] = [];
        (globalThis as any).callLLMComplete = vi.fn(async (p: string) => { prompts.push(p); return 'FLAG-VALUE'; });
        const call = (i: number) => ({ tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'list_files', arguments: JSON.stringify({ path: `d${i}` }) } }] });
        (window as any).fetch = makeReplayFetch(Array.from({ length: 6 }, (_, i) => call(i)));
        const origList = (window as any).agentListFiles;
        (window as any).agentListFiles = async () => [{ name: 'flag.txt', size: 12 }];
        let text = '';
        try { text = await (window as any).runTurn(FAKE_EP, NULL_RENDER_ADAPTER, { session: s, maxSteps: 3 }); }
        finally { (window as any).agentListFiles = origList; }
        expect(prompts.at(-1)).toContain('Task:\nDecode the flag in flag.txt.');
        expect(prompts.at(-1)).toContain('Most recent tool outputs:');
        expect(text.trim().split('\n').at(-1)).toBe('FLAG-VALUE');
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
        expect(prompts[1]).toBe(STEP_LIMIT_PROMPT(undefined));
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
