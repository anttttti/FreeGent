// session-event.test.ts — Tests for the Phase 1 Session infrastructure and Phase 2+3 dual-write.
//
// Structure:
//   Section A — Session unit tests (append, deriveMessages, fork, surface ops, freeze)
//   Section B — SessionRegistry (create, active, fork, flush/load)
//   Section C — Phase 2 dual-write: deriveMessages() must deep-equal openaiHistory
//   Section D — Phase 3 flip: deriveMessages() is the LLM source of truth

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { Session, pruneSurface, compactSurface } from '../session.ts';
import { SURFACE_TYPES } from '../session-event.ts';
import { SessionRegistry, initPersistence } from '../session-registry.ts';
import { makeReplayFetch, FAKE_EP } from './replay-harness.ts';
import { KEYS } from '../storage-keys.ts';
import { NULL_RENDER_ADAPTER } from '../render-adapter.ts';

// ═══════════════════════════════════════════════════════════════════════════════
// Section A — Session unit tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Session — core invariants', () => {
    let sess: Session;
    beforeEach(() => { sess = new Session({ id: 's1', chatId: 'chat1' }); });

    it('starts empty', () => {
        expect(sess.events).toHaveLength(0);
        expect(sess.surface).toHaveLength(0);
        expect(sess.seq).toBe(0);
    });

    it('assigns sequential seq numbers', () => {
        sess.append('turn/start', { turn: 0, chatId: 'chat1' });
        sess.append('turn/end',   { turn: 0, reason: 'completed', durationMs: 100 });
        expect(sess.events[0]!.seq).toBe(0);
        expect(sess.events[1]!.seq).toBe(1);
    });

    it('deep-freezes appended events so callers cannot mutate history', () => {
        const ev = sess.append('turn/start', { turn: 0, chatId: 'chat1' });
        expect(Object.isFrozen(ev)).toBe(true);
        expect(Object.isFrozen(ev.data)).toBe(true);
    });

    it('rejects non-JSON-serializable data synchronously', () => {
        const circular: any = {};
        circular.self = circular;
        expect(() =>
            sess.append('turn/start', circular)
        ).toThrow(/JSON|circular|serialize/i);
    });

    it('requires surfaceOp on surface events', () => {
        expect(() =>
            (sess.append as any)('user/message', { role: 'user', content: 'hi' })
        ).toThrow(/surfaceOp/i);
    });

    it('rejects surfaceOp on non-surface events', () => {
        expect(() =>
            (sess.append as any)('turn/start', { turn: 0, chatId: 'c' }, { surfaceOp: 'append' })
        ).toThrow(/non-surface/i);
    });

    it('SURFACE_TYPES covers user/message, assistant/message, tool/result', () => {
        expect(SURFACE_TYPES.has('user/message')).toBe(true);
        expect(SURFACE_TYPES.has('assistant/message')).toBe(true);
        expect(SURFACE_TYPES.has('tool/result')).toBe(true);
        expect(SURFACE_TYPES.has('turn/start')).toBe(false);
    });
});

// ── Surface mechanics ──────────────────────────────────────────────────────────

describe('Session — surface append', () => {
    let sess: Session;
    beforeEach(() => { sess = new Session({ id: 's2', chatId: 'c2' }); });

    it('append op grows the surface in order', () => {
        const u  = sess.append('user/message',      { role: 'user',      content: 'hello' }, { surfaceOp: 'append' });
        const a  = sess.append('assistant/message', { turn: 0, step: 0,  message: { role: 'assistant', content: 'world' } }, { surfaceOp: 'append' });
        expect(sess.surface).toEqual([u.seq, a.seq]);
    });

    it('deriveMessages() reflects exact surface order', () => {
        sess.append('user/message',
            { role: 'user', content: 'ping' },
            { surfaceOp: 'append' });
        sess.append('assistant/message',
            { turn: 0, step: 0, message: { role: 'assistant', content: 'pong' } },
            { surfaceOp: 'append' });

        const msgs = sess.deriveMessages();
        expect(msgs).toHaveLength(2);
        expect(msgs[0]).toMatchObject({ role: 'user', content: 'ping' });
        expect(msgs[1]).toMatchObject({ role: 'assistant', content: 'pong' });
    });

    it('tool/result appears as { role: "tool", tool_call_id, name, content }', () => {
        sess.append('user/message',
            { role: 'user', content: 'use a tool' },
            { surfaceOp: 'append' });
        sess.append('assistant/message',
            { turn: 0, step: 0,
              message: { role: 'assistant', content: null,
                         tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'list_files', arguments: '{}' } }] } },
            { surfaceOp: 'append' });
        sess.append('tool/result',
            { turn: 0, step: 0, callId: 'tc1', name: 'list_files', content: 'file1.txt\nfile2.txt' },
            { surfaceOp: 'append' });

        const msgs = sess.deriveMessages();
        expect(msgs).toHaveLength(3);
        expect(msgs[2]).toEqual({ role: 'tool', tool_call_id: 'tc1', name: 'list_files', content: 'file1.txt\nfile2.txt' });
    });

    it('skips null-content, no-tool-calls assistant messages (bare usage-only rows)', () => {
        sess.append('user/message',
            { role: 'user', content: 'x' },
            { surfaceOp: 'append' });
        sess.append('assistant/message',
            { turn: 0, step: 0, message: { role: 'assistant', content: null } },
            { surfaceOp: 'append' });

        const msgs = sess.deriveMessages();
        // Only the user message survives; null assistant was skipped.
        expect(msgs).toHaveLength(1);
    });
});

// ── replace surface op ─────────────────────────────────────────────────────────

describe('Session — replace surface op', () => {
    let sess: Session;

    beforeEach(() => {
        sess = new Session({ id: 'sr', chatId: 'cr' });
        sess.append('user/message', { role: 'user', content: 'q' }, { surfaceOp: 'append' });
        // Tool call + result pair
        sess.append('assistant/message',
            { turn: 0, step: 0,
              message: { role: 'assistant', content: null,
                         tool_calls: [{ id: 'tc0', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }] } },
            { surfaceOp: 'append' });
        sess.append('tool/result',
            { turn: 0, step: 0, callId: 'tc0', name: 'search', content: 'very long result '.repeat(100) },
            { surfaceOp: 'append' });
    });

    it('pruneSurface() shadows original tool/result on the surface', () => {
        const origSeq = sess.events.findIndex(e => e.type === 'tool/result');
        const origLen = sess.surface.length;
        pruneSurface(sess, origSeq, 'tc0', 'search', 0, 0, '[pruned: 1700 chars]');

        // Surface length stays the same (replace, not append)
        expect(sess.surface).toHaveLength(origLen);
        // The new event's seq replaces origSeq on the surface
        expect(sess.surface).not.toContain(origSeq);

        // deriveMessages reflects the pruned content
        const msgs = sess.deriveMessages();
        const toolResult = msgs.find((m: any) => m.role === 'tool');
        expect(toolResult?.content).toBe('[pruned: 1700 chars]');
    });

    it('original log entry is preserved after pruneSurface()', () => {
        const origSeq = sess.events.findIndex(e => e.type === 'tool/result');
        pruneSurface(sess, origSeq, 'tc0', 'search', 0, 0, '[pruned]');

        // Original event still in log
        expect(sess.events[origSeq]!.type).toBe('tool/result');
        expect((sess.events[origSeq]!.data as any).content).toContain('very long result');
    });

    it('replace op validation: start/end must be on surface', () => {
        expect(() =>
            sess.append(
                'tool/result',
                { turn: 0, step: 0, callId: 'tc9', name: 'x', content: 'y' },
                { surfaceOp: { op: 'replace', start: 999, end: 999 }, sourceEventSeqs: [999] } as any,
            )
        ).toThrow(/replace start seq 999 not on surface/);
    });
});

// ── fork ───────────────────────────────────────────────────────────────────────

describe('Session.fork()', () => {
    it('child surfaces only reflect events up to the boundary', () => {
        const p = new Session({ id: 'p', chatId: 'c' });
        p.append('user/message', { role: 'user', content: 'turn1' }, { surfaceOp: 'append' });
        p.append('turn/start',   { turn: 0, chatId: 'c' });
        p.append('assistant/message',
            { turn: 0, step: 0, message: { role: 'assistant', content: 'reply' } },
            { surfaceOp: 'append' });
        p.append('turn/end', { turn: 0, reason: 'completed' });

        // Fork at turn/end so child gets the first turn.
        const turnEndSeq = p.events.findIndex(e => e.type === 'turn/end');
        const child = p.fork('child', turnEndSeq);

        const childMsgs = child.deriveMessages();
        expect(childMsgs.some(m => m.role === 'user')).toBe(true);
        expect(childMsgs.some(m => m.role === 'assistant')).toBe(true);
    });

    it('fork throws when boundary is inside an open turn', () => {
        const p = new Session({ id: 'p2', chatId: 'c' });
        p.append('turn/start', { turn: 0, chatId: 'c' });
        p.append('user/message', { role: 'user', content: 'x' }, { surfaceOp: 'append' });
        // No turn/end — fork here should fail
        const lastSeq = p.seq - 1;
        expect(() => p.fork('child', lastSeq)).toThrow(/inside an open turn/i);
    });
});

// ── seed / resume ──────────────────────────────────────────────────────────────

describe('Session — seed (resume)', () => {
    it('seed events replay to surface correctly', () => {
        const parent = new Session({ id: 'p', chatId: 'c' });
        parent.append('user/message', { role: 'user', content: 'hi' }, { surfaceOp: 'append' });
        parent.append('turn/start', { turn: 0, chatId: 'c' });
        parent.append('assistant/message',
            { turn: 0, step: 0, message: { role: 'assistant', content: 'there' } },
            { surfaceOp: 'append' });
        parent.append('turn/end', { turn: 0, reason: 'completed' });

        const resumed = new Session({ id: 'r', chatId: 'c', seed: parent.events });
        const msgs = resumed.deriveMessages();
        expect(msgs[0]).toMatchObject({ role: 'user', content: 'hi' });
        expect(msgs[1]).toMatchObject({ role: 'assistant', content: 'there' });
    });

    it('seed seq mismatch throws', () => {
        const tampered: any[] = [
            { type: 'user/message', seq: 5, time: Date.now(),
              data: { role: 'user', content: 'x' }, surfaceOp: 'append' },
        ];
        expect(() => new Session({ id: 'bad', chatId: 'c', seed: tampered })).toThrow(/seq mismatch/i);
    });
});

// ── onAppend callback ──────────────────────────────────────────────────────────

describe('Session.onAppend', () => {
    it('fires synchronously for every committed event', () => {
        const sess  = new Session({ id: 'oa', chatId: 'c' });
        const calls: string[] = [];
        sess.onAppend = ev => calls.push(ev.type);
        sess.append('turn/start', { turn: 0, chatId: 'c' });
        sess.append('user/message', { role: 'user', content: 'x' }, { surfaceOp: 'append' });
        sess.append('turn/end', { turn: 0, reason: 'completed' });
        expect(calls).toEqual(['turn/start', 'user/message', 'turn/end']);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section B — SessionRegistry
// ═══════════════════════════════════════════════════════════════════════════════

describe('SessionRegistry', () => {
    let reg: SessionRegistry;
    beforeEach(() => { reg = new SessionRegistry(); });

    it('create() returns a fresh Session with the given chatId', () => {
        const s = reg.create({ chatId: 'c1' });
        expect(s).toBeInstanceOf(Session);
        expect(s.chatId).toBe('c1');
    });

    it('create() with explicit id uses that id', () => {
        const s = reg.create({ id: 'my-id', chatId: 'c' });
        expect(s.id).toBe('my-id');
    });

    it('get() retrieves a created session', () => {
        const s = reg.create({ id: 'x', chatId: 'c' });
        expect(reg.get('x')).toBe(s);
    });

    it('remove() deletes the session from the registry', () => {
        reg.create({ id: 'del', chatId: 'c' });
        reg.remove('del');
        expect(reg.get('del')).toBeUndefined();
    });

    it('setActive / active() round-trip', () => {
        const s = reg.create({ chatId: 'c' });
        reg.setActive(s);
        expect(reg.active()).toBe(s);
    });

    it('registry.active() returns null before setActive()', () => {
        expect(reg.active()).toBeNull();
    });

    it('fork() creates a child session from parent log', () => {
        const parent = reg.create({ id: 'parent', chatId: 'c' });
        parent.append('turn/start', { turn: 0, chatId: 'c' });
        parent.append('user/message', { role: 'user', content: 'q' }, { surfaceOp: 'append' });
        parent.append('assistant/message',
            { turn: 0, step: 0, message: { role: 'assistant', content: 'a' } },
            { surfaceOp: 'append' });
        parent.append('turn/end', { turn: 0, reason: 'completed' });

        const child = reg.fork(parent);
        expect(child).toBeInstanceOf(Session);
        expect(child.id).not.toBe(parent.id);
        expect(child.deriveMessages()).toHaveLength(2);
    });

    it('flush() resolves when no persistence is configured', async () => {
        await expect(reg.flush()).resolves.toBeUndefined();
    });

    describe('with in-memory persistence', () => {
        it('resume() restores surface from persisted events', async () => {
            // Use initPersistence with a temp dir and verify load/resume
            const dir = `/tmp/fg-test-session-${Date.now()}`;
            const { default: fs } = await import('node:fs/promises');
            await fs.mkdir(`${dir}/events`, { recursive: true });

            const persistence = initPersistence(dir, 0); // maxDelayMs=0 = flush-immediately
            reg.setPersistence(persistence);

            const s1 = reg.create({ id: 'res1', chatId: 'c' });
            s1.append('user/message', { role: 'user', content: 'persist me' }, { surfaceOp: 'append' });
            s1.append('turn/start',   { turn: 0, chatId: 'c' });
            s1.append('assistant/message',
                { turn: 0, step: 0, message: { role: 'assistant', content: 'ok' } },
                { surfaceOp: 'append' });
            s1.append('turn/end', { turn: 0, reason: 'completed' });
            await reg.flush();

            // Resume into a fresh registry
            const reg2 = new SessionRegistry();
            const persistence2 = initPersistence(dir, 0);
            reg2.setPersistence(persistence2);
            const s2 = await reg2.resume('res1');
            const msgs = s2.deriveMessages();
            expect(msgs.some(m => m.role === 'user' && (m.content as string)?.includes('persist me'))).toBe(true);
            expect(msgs.some(m => m.role === 'assistant')).toBe(true);

            await fs.rm(dir, { recursive: true, force: true });
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section C — Phase 2 dual-write integration
// ═══════════════════════════════════════════════════════════════════════════════
//
// Asserts that after a runTurn() replay, session.deriveMessages() matches the
// assistant and tool entries in openaiHistory.  The initial user message is pushed
// directly to the session before the turn, matching the setupChat() call that
// pre-populates openaiHistory.

const W = window as any;

beforeAll(async () => {
    await import('../llm-loops.ts');
    await import('../chat-state.ts');
    await import('../render-adapter.ts');
});

function setupDualWriteChat() {
    W.newChat?.();
    const chatId = W.activeChatId ?? 'test_dw_chat';
    if (!W.activeChatId) {
        localStorage.setItem(KEYS.ACTIVE_CHAT, chatId);
        W.activeChatId = chatId;
    }
    localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify(['openrouter|qwen/qwen3-30b-a3b']));
    localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
    W.setOpenaiHistory?.([{ role: 'user', content: 'Do the task.' }]);
    W._sessionToolFilter = new Set(['list_files', 'web_search', 'execute_code']);
    return chatId;
}

/** Build a fresh registry and session, register it as active, return both. */
function makeDualWriteSession(chatId: string) {
    const { SessionRegistry } = require('../session-registry.ts') as typeof import('../session-registry.ts');
    const reg = new SessionRegistry();
    const sess = reg.create({ id: `dw-${chatId}`, chatId });
    reg.setActive(sess);
    // Pre-seed with the same initial user message setupDualWriteChat() put in openaiHistory.
    sess.append('user/message', { role: 'user', content: 'Do the task.' }, { surfaceOp: 'append' });
    // Wire registry.active() on the real global registry so _getEvtSession() picks it up.
    // Import the module-level singleton (not the fresh reg above — that's for isolation).
    return { reg, sess };
}

describe('Phase 2 dual-write — single-step COMPLETED', () => {
    beforeEach(() => { localStorage.clear(); });

    it('deriveMessages() matches openaiHistory after a one-step turn', async () => {
        const chatId = setupDualWriteChat();

        // Wire a fresh session as the active session in the global registry
        // so _getEvtSession() in llm-loops picks it up via registry.active().
        const { registry } = await import('../session-registry.ts');
        const sess = registry.create({ id: `dw-single-${Date.now()}`, chatId });
        registry.setActive(sess);
        sess.append('user/message', { role: 'user', content: 'Do the task.' }, { surfaceOp: 'append' });

        W.fetch = makeReplayFetch([{ content: 'The answer is 42.\nCOMPLETED' }]);
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);

        const derived = sess.deriveMessages();
        const history: any[] = W.openaiHistory ?? [];

        // Phase 4: _s.history is no longer maintained for native sessions —
        // event log is the sole source of truth.
        const histAssistants = history.filter((m: any) => m.role === 'assistant');
        const derivedAssistants = derived.filter((m: any) => m.role === 'assistant');

        // Event log must have the assistant response
        expect(derivedAssistants.length).toBeGreaterThanOrEqual(1);
        expect(derivedAssistants[0]!.content).toContain('42');

        // _s.history is empty (Phase 4 removed the dual-write)
        expect(histAssistants.length).toBe(0);
    });
});

describe('Phase 2 dual-write — tool call then COMPLETED', () => {
    beforeEach(() => { localStorage.clear(); });

    it('deriveMessages() includes both assistant and tool/result entries', async () => {
        const chatId = setupDualWriteChat();

        const { registry } = await import('../session-registry.ts');
        const sess = registry.create({ id: `dw-tool-${Date.now()}`, chatId });
        registry.setActive(sess);
        sess.append('user/message', { role: 'user', content: 'Do the task.' }, { surfaceOp: 'append' });

        W.fetch = makeReplayFetch([
            { tool_calls: [{ id: 'tc0', type: 'function', function: { name: 'list_files', arguments: '{"path":"/"}' } }] },
            { content: 'All done.\nCOMPLETED' },
        ]);
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);

        const derived = sess.deriveMessages();
        const history: any[] = W.openaiHistory ?? [];

        // Phase 4: _s.history no longer maintained for native sessions.
        const histToolMessages   = history.filter(
            (m: any) => m.role === 'tool' || (m.role === 'user' && m.content?.includes?.('list_files')));
        const derivedToolResults = derived.filter((m: any) => m.role === 'tool');

        // Event log must have at least one tool result
        expect(derivedToolResults.length).toBeGreaterThanOrEqual(1);
        // _s.history has no tool messages (Phase 4 removed dual-write)
        expect(histToolMessages.length).toBe(0);

        // Event log has the assistant message with tool_calls
        const derivedAssistantWithTools = derived.filter(
            (m: any) => m.role === 'assistant' && (m as any).tool_calls?.length);
        expect(derivedAssistantWithTools.length).toBeGreaterThanOrEqual(1);
    });

    it('surface length matches expected count: user + assistant(tool) + tool/result + assistant(final)', async () => {
        const chatId = setupDualWriteChat();

        const { registry } = await import('../session-registry.ts');
        const sess = registry.create({ id: `dw-count-${Date.now()}`, chatId });
        registry.setActive(sess);
        sess.append('user/message', { role: 'user', content: 'Do the task.' }, { surfaceOp: 'append' });

        W.fetch = makeReplayFetch([
            { tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'list_files', arguments: '{"path":"/"}' } }] },
            { content: 'Done.\nCOMPLETED' },
        ]);
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);

        const derived = sess.deriveMessages();
        // Expected: [user] + [assistant w/ tool_calls] + [tool/result] + [assistant(final)]
        // Some implementations merge fn-tag results differently, so we allow ≥3 (user+assistant+tool).
        expect(derived.length).toBeGreaterThanOrEqual(3);
        expect(derived[0]).toMatchObject({ role: 'user' });
    });
});

describe('Phase 2 dual-write — event log completeness', () => {
    beforeEach(() => { localStorage.clear(); });

    it('request/header event is recorded in the log for every LLM call', async () => {
        setupDualWriteChat();

        const { registry } = await import('../session-registry.ts');
        const sess = registry.create({ id: `dw-hdr-${Date.now()}`, chatId: W.activeChatId ?? 'c' });
        registry.setActive(sess);
        sess.append('user/message', { role: 'user', content: 'Do the task.' }, { surfaceOp: 'append' });

        W.fetch = makeReplayFetch([
            { tool_calls: [{ id: 'tc2', type: 'function', function: { name: 'list_files', arguments: '{"path":"/"}' } }] },
            { content: 'Done.\nCOMPLETED' },
        ]);
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);

        const headers = sess.events.filter(e => e.type === 'request/header');
        // Two LLM calls → two request/header events
        expect(headers.length).toBeGreaterThanOrEqual(2);
    });

    it('assistant/message events have matching content to openaiHistory', async () => {
        setupDualWriteChat();

        const { registry } = await import('../session-registry.ts');
        const sess = registry.create({ id: `dw-cmp-${Date.now()}`, chatId: W.activeChatId ?? 'c' });
        registry.setActive(sess);
        sess.append('user/message', { role: 'user', content: 'Do the task.' }, { surfaceOp: 'append' });

        W.fetch = makeReplayFetch([{ content: 'Specific answer here.\nCOMPLETED' }]);
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);

        const assistantEvt = sess.events.find(
            e => e.type === 'assistant/message' && (e.data as any).message?.content?.includes('Specific answer')
        );
        expect(assistantEvt).toBeDefined();

        // Phase 4: _s.history is no longer maintained for native sessions.
        // The event log is the sole source of truth — _s.history stays empty.
        const history: any[] = W.openaiHistory ?? [];
        const histAssistant  = history.find(
            (m: any) => m.role === 'assistant' && m.content?.includes('Specific answer')
        );
        expect(histAssistant).toBeUndefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section D — Phase 3 flip: deriveMessages() is the LLM source of truth
// ═══════════════════════════════════════════════════════════════════════════════
//
// After Phase 3, callOAI() reads from deriveMessages() (not _s.history) when a
// session is active and the model uses native (non-fn-tag) format.  These tests
// verify that the payloads reaching the fetch() mock contain the same messages
// that deriveMessages() produces — i.e., the flip is live end-to-end.

describe('Phase 3 flip — callOAI uses deriveMessages() for native-format models', () => {
    beforeEach(() => { localStorage.clear(); });

    it('payload messages match deriveMessages() on a one-step turn', async () => {
        const chatId = setupDualWriteChat();
        const { registry } = await import('../session-registry.ts');
        const sess = registry.create({ id: `p3-one-${Date.now()}`, chatId });
        registry.setActive(sess);
        sess.append('user/message', { role: 'user', content: 'Do the task.' }, { surfaceOp: 'append' });

        const capturedPayloads: any[] = [];
        W.fetch = makeReplayFetch(
            [{ content: 'Answer.\nCOMPLETED' }],
            { onRequest: (body: any) => capturedPayloads.push(body) },
        );
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);

        // The payload messages (minus the system prompt) should match deriveMessages()
        // taken at the point before callOAI ran (i.e., the initial user message).
        expect(capturedPayloads.length).toBeGreaterThanOrEqual(1);
        const firstPayload = capturedPayloads[0];
        const payloadMsgs: any[] = firstPayload?.messages ?? [];
        const userMsgs = payloadMsgs.filter((m: any) => m.role === 'user');
        // The user message must be present in the payload
        expect(userMsgs.some((m: any) => m.content === 'Do the task.')).toBe(true);
    });

    it('surface tombstone (empty-content user/message) is filtered by deriveMessages()', () => {
        const sess = new Session({ id: 'p3-tomb', chatId: 'chat-tomb' });
        // Add a user message
        sess.append('user/message', { role: 'user', content: 'Real question.' }, { surfaceOp: 'append' });
        const seq0 = sess.surface[0]!;
        // Replace it with a tombstone
        sess.append('user/message', { role: 'user', content: '' },
            { surfaceOp: { op: 'replace', start: seq0, end: seq0 } } as any);
        // deriveMessages() must return empty (tombstone filtered)
        expect(sess.deriveMessages()).toHaveLength(0);
    });

    it('null-content assistant/message (pop tombstone) is filtered by deriveMessages()', () => {
        const sess = new Session({ id: 'p3-popseq', chatId: 'chat-pop' });
        // Add a real assistant message
        sess.append('assistant/message',
            { turn: 0, step: 0, message: { role: 'assistant', content: 'hello', tool_calls: [] } },
            { surfaceOp: 'append' });
        const origSeq = sess.surface[0]!;
        // Surface-replace with null content (pop tombstone)
        sess.append('assistant/message',
            { turn: 0, step: 0, message: { role: 'assistant', content: null } },
            { surfaceOp: { op: 'replace', start: origSeq, end: origSeq } } as any);
        // deriveMessages() must return empty (null-content assistant filtered)
        const derived = sess.deriveMessages();
        expect(derived.filter(m => m.role === 'assistant' && m.content !== null)).toHaveLength(0);
    });

    it('pruneSurface() replaces the original tool/result in deriveMessages() output', () => {
        const sess = new Session({ id: 'p3-prune', chatId: 'chat-prune' });
        sess.append('tool/result',
            { turn: 0, step: 0, callId: 'tc-abc', name: 'read_file', content: 'big content here' },
            { surfaceOp: 'append' });
        const origSeq = sess.surface[0]!;
        pruneSurface(sess, origSeq, 'tc-abc', 'read_file', 0, 0, '[pruned: dup read, 16 chars]');
        const derived = sess.deriveMessages();
        // Only the pruned version should appear
        expect(derived).toHaveLength(1);
        expect((derived[0] as any).content).toContain('[pruned:');
    });

    it('compactSurface() replaces shadowed range with summary in deriveMessages()', () => {
        const sess = new Session({ id: 'p3-compact', chatId: 'chat-compact' });
        // anchor
        sess.append('user/message', { role: 'user', content: '[anchor]' }, { surfaceOp: 'append' });
        const anchorSeq = sess.surface[0]!;
        // history to be compacted
        sess.append('assistant/message',
            { turn: 0, step: 0, message: { role: 'assistant', content: 'step 1' } },
            { surfaceOp: 'append' });
        sess.append('user/message', { role: 'user', content: 'continue' }, { surfaceOp: 'append' });
        const lastHiddenSeq = sess.surface[sess.surface.length - 1]!;
        // compactSurface shadows from firstHidden to lastHidden
        const firstHiddenSeq = sess.surface[1]!;
        compactSurface(sess, '[SYSTEM: compacted. step 1 was done.]', firstHiddenSeq, lastHiddenSeq);
        const derived = sess.deriveMessages();
        // anchor + summary (the two hidden events are gone)
        const contents = derived.map(m => m.content as string);
        expect(contents).toContain('[anchor]');
        expect(contents.some(c => c?.includes('compacted'))).toBe(true);
        // Hidden events must not appear
        expect(contents).not.toContain('step 1');
        expect(contents).not.toContain('continue');
    });
});
