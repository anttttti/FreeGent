// Chat logs 401e1d79, b969d7cc, 306f35dd (v0.96.53-55): a model whose tool calls kept arriving with empty arguments ({}) was
// refused for the missing argument 40+ times in one run and never left. After a few such steps in a row the loop benches it
// and the turn goes on with the next model in the list.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeReplayFetch, FAKE_EP } from './replay-harness.ts';
import { NULL_RENDER_ADAPTER } from '../render-adapter.ts';
import { KEYS } from '../storage-keys.ts';
import { pushHistory } from './history-helpers.ts';

const W = window as any;
beforeAll(async () => { await import('../llm-loops.ts'); await import('../step-validator.ts'); });
beforeEach(() => {
    localStorage.clear();
    W.mainAgentRole = null;
    W.clearAllCooldowns?.();
    // Custom entries, so the test does not depend on what the built-in catalog lists.
    localStorage.setItem(KEYS.CUSTOM_MODELS, JSON.stringify([FAKE_EP.model, 'other-model'].map(model => ({ provider: 'openrouter', model, url: FAKE_EP.url }))));
    localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify([`openrouter|${FAKE_EP.model}`, 'openrouter|other-model']));
    localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
    W._sessionToolFilter = new Set(['read_file']);
});

const emptyRead = (i: number) => ({ tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });

describe('tool calls with empty arguments', () => {
    it('a model that keeps sending them is benched and the turn moves to the next model', async () => {
        const s = W.createSession({ workflowMode: true });
        pushHistory(s, { role: 'user', content: 'read the readme' });
        const models: string[] = [];
        W.fetch = makeReplayFetch([emptyRead(1), emptyRead(2), emptyRead(3), emptyRead(4), { content: 'done\nCOMPLETED' }],
            { onRequest: (b: any) => models.push(b.model) });
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER, { session: s });
        expect(models.slice(0, 4)).toEqual(Array(4).fill(FAKE_EP.model));
        expect(models[4]).toBe('other-model');
    });

    it('a call with arguments in between resets the count', async () => {
        const s = W.createSession({ workflowMode: true });
        pushHistory(s, { role: 'user', content: 'read the readme' });
        const models: string[] = [];
        const okRead = { tool_calls: [{ id: 'ok', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] };
        W.fetch = makeReplayFetch([emptyRead(1), emptyRead(2), emptyRead(3), okRead, emptyRead(5), { content: 'done\nCOMPLETED' }],
            { onRequest: (b: any) => models.push(b.model) });
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER, { session: s });
        expect(models.slice(0, 6).every(m => m === FAKE_EP.model)).toBe(true);
    });
});
