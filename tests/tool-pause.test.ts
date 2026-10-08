// tool-pause.test.ts — a turn stuck re-requesting workspace reads gets the read tool taken away for a
// couple of steps instead of more stubs or a turn stop (v0.60 fixes). v0.60 SWE runs with 5+
// "still shown above" stubs resolved 0 of 8: the model re-asked the same lines 13–45 times until
// the repeat guard ended the run, 5 of them with an empty patch.
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

const call = (id: string, name: string, args: any) => ({
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const read = (id: string, s: number, e: number) => call(id, 'read_file', { path: 'f.py', start_line: s, end_line: e });
const toolNames = (body: any) => (body?.tools ?? []).map((t: any) => t.function?.name);
const results = () => (W.conversationLog ?? []).filter((r: any) => Array.isArray(r.toolCalls)).flatMap((r: any) => r.toolCalls);

describe('tool pause', () => {
    beforeEach(async () => {
        localStorage.clear();
        if (Array.isArray(W.conversationLog)) W.conversationLog.length = 0;
        W.mainAgentRole = null;
        localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify([`${FAKE_EP.provider}|${FAKE_EP.model}`]));
        localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
        W._sessionToolFilter = new Set(['read_file', 'list_files', 'search_workspace']);
        W.setChatHistory([{ role: 'user', content: 'Fix the bug in f.py.' }]);
        await W.agentWriteFile('f.py', Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n'));
    });

    it('after two stubs, the next re-read is served once and read_file leaves the tool list for 2 steps', async () => {
        const bodies: any[] = [];
        W.fetch = makeReplayFetch([
            read('r0', 1, 100),
            read('r1', 10, 20), read('r2', 11, 21),   // redundant, still run
            read('r3', 12, 22), read('r4', 13, 23),   // refused twice
            read('r5', 14, 24), read('r6', 15, 25),   // stubbed twice
            read('r7', 16, 26),                       // served once more; read_file paused
            call('s8', 'search_workspace', { pattern: 'line 16' }),
            call('s9', 'search_workspace', { pattern: 'line 17' }),
            { content: 'Done.\nCOMPLETED' },
        ], { onRequest: b => bodies.push(b) });
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        const r = results();
        expect(String(r.find((t: any) => t.args?.start_line === 14)?.result?.note)).toMatch(/still shown/);
        const r7 = r.find((t: any) => t.args?.start_line === 16)?.result;
        expect(String(r7?.content ?? '')).toContain('line 16');
        expect(String(r7?.note)).toMatch(/read_file is paused for the next 2 steps/);
        expect(toolNames(bodies[7])).toContain('read_file');
        expect(toolNames(bodies[8])).not.toContain('read_file');
        expect(toolNames(bodies[9])).not.toContain('read_file');
        expect(toolNames(bodies[10])).toContain('read_file');
    });

    it('a repeat refusal of a workspace read pauses that tool and does not end the turn', async () => {
        const ls = (id: string) => call(id, 'list_files', { path: '' });
        const search = (id: string, p: string) => call(id, 'search_workspace', { pattern: p });
        const bodies: any[] = [];
        W.fetch = makeReplayFetch([
            ...Array.from({ length: 8 }, (_, i) => ls(`l${i}`)),   // same result 8 times
            ls('x8'), search('s9', 'a'), search('s10', 'b'),        // refused, then paused 2 steps
            ls('x11'), search('s12', 'c'), search('s13', 'd'),
            ls('x14'),                                              // 3rd refusal: used to stop the turn
            { content: 'Done.\nCOMPLETED' },
        ], { onRequest: b => bodies.push(b) });
        const out = await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        expect(String(results().find((t: any) => t.name === 'list_files' && t.result?.error)?.result?.error)).toMatch(/paused for the next 2 steps/);
        expect(toolNames(bodies[9])).not.toContain('list_files');
        expect(toolNames(bodies[10])).not.toContain('list_files');
        expect(String(out)).toContain('Done.');
        expect(bodies.length).toBe(16);
    });

    // v0.61 sympy-15875: a 2-step pause ended just as the model re-asked, 33 pauses over 99 steps.
    it('each further pause of read_file is longer: 2 steps, then 4, then the rest of the turn', async () => {
        const bodies: any[] = [];
        const q = (id: string, p: string) => call(id, 'search_workspace', { pattern: p });
        W.fetch = makeReplayFetch([
            read('r0', 1, 100),
            read('r1', 10, 20), read('r2', 11, 21), read('r3', 12, 22), read('r4', 13, 23),
            read('r5', 14, 24), read('r6', 15, 25), read('r7', 16, 26),        // pause 1 (2 steps)
            q('a8', 'a'), q('a9', 'b'),
            read('r10', 17, 27), read('r11', 18, 28), read('r12', 19, 29),     // pause 2 (4 steps)
            q('b13', 'c'), q('b14', 'd'), q('b15', 'e'), q('b16', 'f'),
            read('r17', 20, 30), read('r18', 21, 31), read('r19', 22, 32),     // pause 3 (rest of turn)
            q('c20', 'g'), q('c21', 'h'), q('c22', 'i'), q('c23', 'j'),
            { content: 'Done.\nCOMPLETED' },
        ], { onRequest: b => bodies.push(b) });
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        const note = (start: number) => String(results().find((t: any) => t.args?.start_line === start)?.result?.note);
        expect(note(16)).toMatch(/read_file is paused for the next 2 steps/);
        expect(note(19)).toMatch(/read_file is paused for the next 4 steps/);
        expect(note(22)).toMatch(/read_file is paused for the rest of this turn/);
        expect(toolNames(bodies[10])).toContain('read_file');          // first pause over
        expect(toolNames(bodies[13])).not.toContain('read_file');      // second pause: 4 steps
        expect(toolNames(bodies[16])).not.toContain('read_file');
        expect(toolNames(bodies[17])).toContain('read_file');          // second pause over
        for (let i = 20; i < 24; i++) expect(toolNames(bodies[i])).not.toContain('read_file');   // third: never back
    });

    it('a refused read is free only early in the budget and before the tool is paused for good', async () => {
        const { readRefusalIsFree, pauseSteps } = await import('../llm-loops.ts');
        expect(readRefusalIsFree(10, 100, [1])).toBe(true);
        expect(readRefusalIsFree(59, 100, [2])).toBe(true);
        expect(readRefusalIsFree(60, 100, [0])).toBe(false);     // past 60% of the budget: counts
        expect(readRefusalIsFree(10, 100, [3])).toBe(false);     // already out for the rest of the turn
        expect([0, 1, 2, 3].map(pauseSteps)).toEqual([2, 4, Infinity, Infinity]);
    });
});
