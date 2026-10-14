// A worker whose model answers HTTP 401 (bad key) fails the same way on every attempt: the outer
// retry loop used to skip only the backoff and still start the next attempt (v0.70 code review R13),
// spending MAX_RETRIES+1 full worker runs on a failure that cannot change.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { KEYS } from '../storage-keys.ts';

const W = window as any;
beforeAll(async () => { await import('../llm-loops.ts'); await import('../workers.ts'); });
beforeEach(() => {
    localStorage.clear();
    W.mainAgentRole = null;
    localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify(['openrouter|test-model']));
    localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
});

describe('worker permanent errors', () => {
    it('are attempted once, not once per retry', async () => {
        const fetchMock = vi.fn(async () => new Response('{"error":{"message":"invalid key"}}', { status: 401, headers: { 'content-type': 'application/json' } }));
        W.fetch = fetchMock; (globalThis as any).fetch = fetchMock;
        const agents = [{ id: 'w1', role: 'researcher', task: 'Look something up.' }];
        const out = await W.executeWorkers({ agents }).catch((e: any) => ({ threw: String(e?.message ?? e) }));
        expect(JSON.stringify(out)).toMatch(/401|invalid key|failed|error/i);
        expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);   // one attempt (plus at most one provider-side fallback)
    });
});
