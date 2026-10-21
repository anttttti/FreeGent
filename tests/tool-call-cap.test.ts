// codex report 8, cases 419-421: the twenty-call cap must leave the history paired (every tool call has a result).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeReplayFetch, FAKE_EP } from './replay-harness.ts';
import { NULL_RENDER_ADAPTER } from '../render-adapter.ts';
import { KEYS } from '../storage-keys.ts';
import { pushHistory, historyOf } from './history-helpers.ts';

const W = window as any;
beforeAll(async () => { await import('../llm-loops.ts'); await import('../step-validator.ts'); });
beforeEach(() => {
    localStorage.clear();
    W.mainAgentRole = null;
    localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify(['openrouter|qwen/qwen3-30b-a3b']));
    localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
    W._sessionToolFilter = new Set(['list_files']);
});

describe('tool-call cap', () => {
    it('only the executed calls stay in the assistant message, so the next request is paired', async () => {
        const s = W.createSession({ workflowMode: true });
        pushHistory(s, { role: 'user', content: 'list files 21 times' });
        const calls = Array.from({ length: 21 }, (_, i) => ({ id: `c${i + 1}`, type: 'function', function: { name: 'list_files', arguments: '{}' } }));
        const bodies: any[] = [];
        W.fetch = makeReplayFetch([{ tool_calls: calls }, { content: 'done\nCOMPLETED' }], { onRequest: (b: any) => bodies.push(b) });
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER, { session: s });
        expect(bodies.length).toBeGreaterThanOrEqual(2);
        const msgs: any[] = bodies[1].messages;
        const issued = msgs.filter(m => m.role === 'assistant').flatMap(m => (m.tool_calls ?? []).map((t: any) => t.id));
        const answered = msgs.filter(m => m.role === 'tool').map(m => m.tool_call_id);
        expect(issued).toHaveLength(20);
        expect(new Set(issued)).toEqual(new Set(answered));
        expect(issued).not.toContain('c21');
        void historyOf;
    });
});
