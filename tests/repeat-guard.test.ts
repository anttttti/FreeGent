// repeat-guard.test.ts — a tool call that keeps returning the same result (digits ignored) is
// refused after REPEAT_LIMIT repeats and the turn ends after a few refusals; calls whose results
// change keep running. Stuck nudges give advice for the tool that repeated.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { makeReplayFetch, FAKE_EP } from './replay-harness.ts';
import { NULL_RENDER_ADAPTER } from '../render-adapter.ts';
import { KEYS } from '../storage-keys.ts';
import { REPEAT_LIMIT, newRepeatGuard, _callSig, _resultSig, _repeatRefused, _updateRepeatGuard, _updateStuckDetector } from '../detectors.ts';

const W = window as any;

beforeAll(async () => {
    await import('../llm-loops.ts');
    await import('../chat-state.ts');
    await import('../step-validator.ts');
});

describe('repeat guard helpers', () => {
    it('ignores digits in results (PIDs, timestamps) but not other changes', () => {
        const a = _resultSig([{ name: 'execute_code', result: { stdout: 'root 647 20.0 bash -c ps aux | grep postgres' } }]);
        const b = _resultSig([{ name: 'execute_code', result: { stdout: 'root 673 14.2 bash -c ps aux | grep postgres' } }]);
        const c = _resultSig([{ name: 'execute_code', result: { stdout: 'postgres: server started' } }]);
        expect(a).toBe(b);
        expect(a).not.toBe(c);
    });

    it('refuses only once a call has repeated REPEAT_LIMIT times with the same result', () => {
        const sig = _callSig([{ name: 'execute_code', args: { code: 'ps aux' } }]);
        let g = newRepeatGuard();
        for (let i = 0; i < REPEAT_LIMIT; i++) {
            expect(_repeatRefused(g, sig)).toBe(false);
            g = _updateRepeatGuard(g, sig, 'same');
        }
        expect(_repeatRefused(g, sig)).toBe(true);
        expect(_repeatRefused(g, _callSig([{ name: 'execute_code', args: { code: 'ls' } }]))).toBe(false);
    });
});

describe('stuck nudge text', () => {
    it('gives command advice for execute_code, not file-reading advice', () => {
        const sig = JSON.stringify([{ n: 'execute_code', res: { stdout: 'x' } }]);
        let r: any = { resultHashes: [] };
        for (let i = 0; i < 3; i++) r = _updateStuckDetector(sig, new Set(), r.resultHashes);
        expect(r.stuckMsg).toMatch(/running the same command again/);
        expect(r.stuckMsg).not.toMatch(/start_line/);
    });
});

describe('runTurn with a looping call', () => {
    beforeEach(() => {
        localStorage.clear();
        W.mainAgentRole = null;
        localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify([`${FAKE_EP.provider}|${FAKE_EP.model}`]));
        localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
        W._sessionToolFilter = new Set(['execute_code']);
        W.setOpenaiHistory([{ role: 'user', content: 'Wait for postgres, then load the CSV.' }]);
    });
    const psCall = (i: number) => ({ tool_calls: [{ id: `p${i}`, type: 'function', function: { name: 'execute_code', arguments: '{"language":"bash","code":"ps aux | grep postgres"}' } }] });

    it('stops executing after REPEAT_LIMIT identical results and ends the turn', async () => {
        let pid = 600;
        const exec = vi.fn(async () => ({ stdout: `root ${pid++} 0.0 grep postgres`, stderr: '', exit_code: 0 }));
        W.nativeExec = exec;
        W.fetch = makeReplayFetch(Array.from({ length: 20 }, (_, i) => psCall(i)));
        const result = await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        expect(exec).toHaveBeenCalledTimes(REPEAT_LIMIT);
        expect(result).toMatch(/stopped|BLOCKED/);
        const refusals = W.openaiHistory.filter((m: any) => m.role === 'tool' && String(m.content).includes('Not executed: this exact call already ran'));
        expect(refusals.length).toBeGreaterThan(0);
    });

    it('keeps running a repeated call whose results change', async () => {
        let n = 0;
        const exec = vi.fn(async () => ({ stdout: ['starting', 'initializing', 'recovering', 'waiting'][n++ % 4] + ' postgres', stderr: '', exit_code: 0 }));
        W.nativeExec = exec;
        W.fetch = makeReplayFetch([...Array.from({ length: 12 }, (_, i) => psCall(i)), { content: 'Loaded.\nCOMPLETED' }]);
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        expect(exec).toHaveBeenCalledTimes(12);
    });
});
