// read-guard-compaction.test.ts — compaction resets the overlapping-read ledger. The ledger is
// keyed by the per-turn repeat-cache Map, and compaction only clear()ed that Map, so after a
// compaction the guard kept refusing lines whose only copy had been summarised away (v0.56: 19
// refusals in 6 SWE tasks).
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

const read = (id: string, s: number, e: number, usage?: any) => ({
    tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'f.py', start_line: s, end_line: e }) } }],
    ...(usage ? { usage } : {}),
});

describe('overlapping-read guard across compaction', () => {
    beforeEach(async () => {
        localStorage.clear();
        W.mainAgentRole = null;
        localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify([`${FAKE_EP.provider}|${FAKE_EP.model}`]));
        localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
        W._sessionToolFilter = new Set(['read_file']);
        W.setChatHistory([{ role: 'user', content: 'Fix the bug in f.py.' }]);
        await W.agentWriteFile('f.py', Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n'));
    });

    it('serves a range again after compaction instead of refusing it', async () => {
        W.fetch = makeReplayFetch([
            read('r0', 1, 100),
            read('r1', 10, 20),
            read('r2', 11, 21),
            read('r3', 12, 22),                                              // 3rd redundant: refused
            read('r4', 50, 150, { prompt_tokens: 5_000_000, completion_tokens: 10 }),  // forces compaction
            { content: 'Summary: read f.py lines 1–150 looking for the bug.' },        // compaction reply
            read('r5', 13, 23),                                              // after compaction
            { content: 'Done.\nCOMPLETED' },
        ]);
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        const rows = (W.conversationLog ?? []).filter((r: any) => Array.isArray(r.toolCalls));
        const byId = (s: number) => rows.flatMap((r: any) => r.toolCalls).filter((t: any) => t.args?.start_line === s);
        expect(String(byId(12)[0]?.result?.error ?? '')).toMatch(/read_file refused/);
        expect(W.conversationLog.some((r: any) => r.type === 'history_snapshot')).toBe(true);   // compaction ran
        const after = byId(13)[0]?.result;
        expect(after?.error).toBeUndefined();
        expect(String(after?.content ?? '')).toContain('line 13');
    });
});
