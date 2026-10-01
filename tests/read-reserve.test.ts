// read-reserve.test.ts — after its refusals are used up, the overlapping-read guard re-serves lines
// only when an earlier copy is no longer fully in context (v0.57 fixes review §4). v0.57 re-served
// unconditionally and marked every range of the file 'pruned' while doing it: pylint-4970 alternated
// two ranges of similar.py for 57 steps, each served in full.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeReplayFetch, FAKE_EP } from './replay-harness.ts';
import { NULL_RENDER_ADAPTER } from '../render-adapter.ts';
import { KEYS } from '../storage-keys.ts';
import { IDBFactory } from 'fake-indexeddb';

const W = window as any;

beforeAll(async () => {
    (globalThis as any).indexedDB = new IDBFactory();
    await import('../llm-loops.ts');
    await import('../chat-state.ts');
    await import('../step-validator.ts');
});

const read = (id: string, s: number, e: number) => ({
    tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'f.py', start_line: s, end_line: e }) } }],
});
const script = () => [
    read('r0', 1, 100),
    read('r1', 10, 20), read('r2', 11, 21),     // redundant, still run
    read('r3', 12, 22), read('r4', 13, 23),     // refused twice
    read('r5', 14, 24),                         // refusals used up
    { content: 'Done.\nCOMPLETED' },
];
const resultFor = (s: number) => (W.conversationLog ?? []).filter((r: any) => Array.isArray(r.toolCalls))
    .flatMap((r: any) => r.toolCalls).findLast((t: any) => t.args?.start_line === s)?.result;

describe('read guard: serve again only when the earlier copy is gone', () => {
    beforeEach(async () => {
        localStorage.clear();
        if (Array.isArray(W.conversationLog)) W.conversationLog.length = 0;
        W.mainAgentRole = null;
        localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify([`${FAKE_EP.provider}|${FAKE_EP.model}`]));
        localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
        W._sessionToolFilter = new Set(['read_file']);
        W.setOpenaiHistory([{ role: 'user', content: 'Fix the bug in f.py.' }]);
        await W.agentWriteFile('f.py', Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n'));
    });

    it('earlier reads still fully shown: a short note, no content', async () => {
        W.fetch = makeReplayFetch(script());
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        expect(String(resultFor(12)?.error ?? '')).toMatch(/read_file refused/);
        const r5 = resultFor(14);
        expect(r5?.error).toBeUndefined();
        expect(r5?.content).toBeUndefined();
        expect(String(r5?.note)).toMatch(/still shown in your earlier read_file results/);
    });

    it('the truncated earlier copy was a whole-file read (no range): the lines are served again', async () => {
        localStorage.setItem('fg_agent_max_tool_result', '800');
        const whole = { tool_calls: [{ id: 'w0', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'f.py' }) } }] };
        W.fetch = makeReplayFetch([whole, ...script().slice(1)]);
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        const r5 = resultFor(14);
        expect(String(r5?.content ?? '')).toContain('line 14');
        expect(String(r5?.note)).toMatch(/shown again below/);
    });

    it('an earlier read was truncated in history: the lines are served again', async () => {
        localStorage.setItem('fg_agent_max_tool_result', '300');   // r0 (100 lines) is cut short
        W.fetch = makeReplayFetch(script());
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        const r5 = resultFor(14);
        expect(String(r5?.content ?? '')).toContain('line 14');
        expect(String(r5?.note)).toMatch(/shown again below/);
    });

    // v0.59: 219 of 245 re-served reads came within 2 steps of a full copy of the same file.
    it('a full copy served in the last few steps: a note, even after an earlier copy was pruned', async () => {
        W.fetch = makeReplayFetch([
            read('r0', 1, 100), read('r0b', 1, 100),   // the second prunes the first copy
            read('r1', 10, 20), read('r2', 11, 21), read('r3', 12, 22), read('r4', 13, 23),
            read('r5', 14, 24),
            { content: 'Done.\nCOMPLETED' },
        ]);
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        const r5 = resultFor(14);
        expect(r5?.content).toBeUndefined();
        expect(String(r5?.note)).toMatch(/still shown in your earlier read_file results/);
    });
});

