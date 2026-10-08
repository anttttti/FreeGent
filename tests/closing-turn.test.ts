// Closing turn after a step-limit stop (v0.58 fixes §1). v0.58 gave the closing turn the full
// 100-step budget and every tool: 35 SWE runs, 2,064 steps, 53.8M prompt tokens; Lite
// xarray-4094's closing turn re-edited its fix through run_workers and lost it.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { directorLoop, STEP_LIMIT_PROMPT } from '../loop-director.ts';
import { makeReplayFetch, FAKE_EP } from './replay-harness.ts';
import { NULL_RENDER_ADAPTER } from '../render-adapter.ts';
import { KEYS } from '../storage-keys.ts';
import { pushHistory, historyOf } from './history-helpers.ts';

const W = window as any;

beforeAll(async () => {
    await import('../llm-loops.ts');
    await import('../step-validator.ts');
});

beforeEach(() => {
    localStorage.clear();
    W.mainAgentRole = null;
    localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify(['openrouter|qwen/qwen3-30b-a3b']));
    localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
});

const turn = (finishSignal: any, stop: any = { reason: null, edited: false }) => ({ text: '', finishSignal, stop, usage: {} as any, steps: [] });

describe('directorLoop closing turn options', () => {
    it('passes its own step budget and excluded tools, and names the budget in the prompt', async () => {
        const calls: any[] = [];
        const results = [turn('blocked', { reason: 'step budget exhausted', edited: true }), turn('complete')];
        const fn = vi.fn(async (p: string, _s: any, o: any) => { calls.push({ p, o }); return results.shift() as any; });
        await directorLoop(fn, {} as any, 'task', { maxContinuations: 4, stepLimitContinuations: 1, closingSteps: 25, closingExcludeTools: ['run_workers'] });
        expect(fn).toHaveBeenCalledTimes(2);
        expect(calls[0].o?.maxSteps).toBeUndefined();
        expect(calls[1].o).toMatchObject({ forceToolCall: true, maxSteps: 25, excludeTools: ['run_workers'] });
        expect(calls[1].p).toBe(STEP_LIMIT_PROMPT(25));
        expect(calls[1].p).toContain('(25 steps)');
    });

    it('names test/packaging config edits to restore in the closing prompt', async () => {
        const calls: any[] = [];
        const results = [turn('blocked', { reason: 'maximum step limit reached', edited: true }), turn('complete')];
        const fn = vi.fn(async (p: string, _s: any, o: any) => { calls.push({ p, o }); return results.shift() as any; });
        await directorLoop(fn, {} as any, 'task', { maxContinuations: 4, stepLimitContinuations: 1, closingSteps: 25,
            closingEnvCheck: async () => ['tests/conftest.py'] });
        expect(calls[1].p).toBe(STEP_LIMIT_PROMPT(25, ['tests/conftest.py']));
        expect(calls[1].p).toMatch(/first restore these test\/packaging configuration edits.*tests\/conftest\.py/);
        expect(calls[1].p).toContain('if the task asks for an answer');
    });

    it('blind continuations keep the normal budget and all tools', async () => {
        const calls: any[] = [];
        const results = [turn('running'), turn('complete')];
        const fn = vi.fn(async (p: string, _s: any, o: any) => { calls.push({ p, o }); return results.shift() as any; });
        await directorLoop(fn, {} as any, 'task', { maxContinuations: 4, stepLimitContinuations: 1, closingSteps: 25, closingExcludeTools: ['run_workers'] });
        expect(calls[1].o).toEqual({ forceToolCall: true });
    });
});

describe('runTurn per-turn budget and excluded tools', () => {
    const listCall = (i: number) => ({ tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'list_files', arguments: JSON.stringify({ path: `dir${i}` }) } }] });

    function session() {
        const s = W.createSession({ workflowMode: true });
        pushHistory(s, { role: 'user', content: 'Do the task.' });
        W._sessionToolFilter = new Set(['list_files', 'execute_code']);
        return s;
    }

    it('stops as BLOCKED at maxSteps, with a steps-left note before it', async () => {
        const s = session();
        const bodies: any[] = [];
        W.fetch = makeReplayFetch(Array.from({ length: 10 }, (_, i) => listCall(i)), { onRequest: b => bodies.push(b) });
        const text = await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER, { session: s, maxSteps: 4 });
        expect(bodies.filter(b => b.tools?.length).length).toBe(4);   // + the stop-summary request
        expect(W.getTurnStopInfo().reason).toBe('step budget exhausted');
        expect(text).toMatch(/^BLOCKED:/m);
        const notes = historyOf(s).filter((m: any) => m.role === 'user' && /steps left in this turn/.test(String(m.content)));
        expect(notes).toHaveLength(1);
    });

    it('interactive chat gets the softer note, then the pause message', async () => {
        const s = W.createSession({ workflowMode: false });
        pushHistory(s, { role: 'user', content: 'Do the task.' });
        W._sessionToolFilter = new Set(['list_files', 'execute_code']);
        const bodies: any[] = [];
        W.fetch = makeReplayFetch(Array.from({ length: 10 }, (_, i) => listCall(i)), { onRequest: b => bodies.push(b) });
        const text = await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER, { session: s, maxSteps: 4 });
        expect(text).toMatch(/\*\*Paused:\*\* this turn reached its limit of 4 steps/);
        const sent = JSON.stringify(bodies.at(-1).messages);
        expect(sent).toContain('steps left in this turn before it pauses');
        expect(sent).not.toContain('Finish now');
    });

    it('leaves excluded tools out of the request and refuses a call to one', async () => {
        const s = session();
        const bodies: any[] = [];
        W.fetch = makeReplayFetch([listCall(0), { content: 'Done.\nCOMPLETED' }], { onRequest: b => bodies.push(b) });
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER, { session: s, excludeTools: ['list_files'] });
        for (const b of bodies) expect((b.tools ?? []).map((t: any) => t.function.name)).not.toContain('list_files');
        const toolMsg = historyOf(s).find((m: any) => m.role === 'tool');
        expect(String(toolMsg?.content)).toMatch(/list_files is not available in this turn/);
    });
});
