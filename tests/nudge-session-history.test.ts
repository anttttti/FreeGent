// nudge-session-history.test.ts — regression guard for audit §4.5.
//
// emitNudge() resolves its target as `opts?.history ?? openaiHistory`. runTurn takes an
// AgentSession whose .history is that same array ONLY for defaultSession (browser path,
// where it is a getter proxying the module-level openaiHistory). Every headless entry
// point — headless-runner, fg-run, the TUI, and the benchmark harness — calls
// createSession(), which allocates a FRESH array. From 8028033 (2026-07-13, AgentSession)
// until this fix, all 19 emitNudge call sites in runTurn used the default, so every nudge
// was computed, logged, and pushed into an array the run never read. Measured across the
// v0.26 suite: 14,210 messages in logged session histories, 0 containing <nudge>, against
// 573 logged nudge events.
//
// The whole nudge layer was therefore inert in benchmarks: step-validation fail actions,
// reactive skill guidance, the completion gate, tool_repeat, empty_code, stuck/stall.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeReplayFetch, FAKE_EP } from './replay-harness.ts';
import { NULL_RENDER_ADAPTER } from '../render-adapter.ts';
import { KEYS } from '../storage-keys.ts';

const W = window as any;

beforeAll(async () => {
    await import('../llm-loops.ts');
    await import('../chat-state.ts');
});

beforeEach(() => {
    localStorage.clear();
    W.fetch?.mockReset?.();
    localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify(['openrouter|qwen/qwen3-30b-a3b']));
    localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
    // Skip the tool classifier: it calls callLLMComplete which would consume a scripted
    // replay step. A non-null _sessionToolFilter makes runTurn skip classification.
    W._sessionToolFilter = new Set(['list_files', 'execute_code']);
});

// An execute_code call with no `code` argument is the most deterministic nudge trigger in
// the loop: tool-call-repair reports emptyCode and the post-results block emits `empty_code`
// unconditionally — no validator bands, no LLM judge, no step-count preconditions.
const EMPTY_CODE_THEN_DONE = () => ([
    { content: 'Running it.', tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'execute_code', arguments: '{}' } },
    ] },
    { content: 'Done.\nCOMPLETED' },
]);

const nudges = (h: any[]) =>
    h.filter(m => typeof m?.content === 'string' && m.content.includes('<nudge>'));

describe('nudges are delivered to the running turn history (audit §4.5)', () => {
    it('lands in a non-default session history, not the module-level openaiHistory', async () => {
        W.fetch = makeReplayFetch(EMPTY_CODE_THEN_DONE());

        // The exact shape headless uses: a session that is NOT defaultSession.
        const session = W.createSession
            ? W.createSession()
            : { history: [], abortController: null, role: null };
        session.history.push({ role: 'user', content: 'Do the task.' });
        // Skip the tool classifier: it would consume a scripted replay step via callLLMComplete.
        (session as any)._toolFilter = new Set(['list_files', 'execute_code']);

        // Sentinel: the module-level array must stay untouched by this turn.
        W.setOpenaiHistory([]);

        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER, { session });

        // The assertion that fails on the pre-fix code:
        expect(nudges(session.history).length).toBeGreaterThan(0);
        // ...and the nudge must NOT have leaked into the global array instead.
        expect(nudges(W.openaiHistory).length).toBe(0);
    });

    it('still works on the browser path, where session.history proxies openaiHistory', async () => {
        W.fetch = makeReplayFetch(EMPTY_CODE_THEN_DONE());
        W.setOpenaiHistory([{ role: 'user', content: 'Do the task.' }]);

        // No session argument → runTurn falls back to defaultSession.
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER, {});

        expect(nudges(W.openaiHistory).length).toBeGreaterThan(0);
    });

    it('two concurrent sessions do not receive each other\'s nudges', async () => {
        // Benchmarks run several tasks per process (configs use concurrency 3–8), which is
        // why AgentSession exists at all. A shared nudge target would cross-contaminate.
        W.fetch = makeReplayFetch([...EMPTY_CODE_THEN_DONE(), ...EMPTY_CODE_THEN_DONE()]);
        const mk = () => {
            const s: any = W.createSession ? W.createSession() : { history: [], abortController: null, role: null };
            s.history.push({ role: 'user', content: 'Do the task.' });
            // Skip the tool classifier so it doesn't consume scripted replay steps.
            s._toolFilter = new Set(['list_files', 'execute_code']);
            return s;
        };
        const a = mk(), b = mk();
        W.setOpenaiHistory([]);

        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER, { session: a });
        const aAfter = nudges(a.history).length;
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER, { session: b });

        expect(aAfter).toBeGreaterThan(0);
        expect(nudges(b.history).length).toBeGreaterThan(0);
        // a must not have grown while b ran.
        expect(nudges(a.history).length).toBe(aAfter);
        expect(nudges(W.openaiHistory).length).toBe(0);
    });
});
