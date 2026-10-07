// Browser Session bridge (browser-session.ts, task 071): the same scripted turn run on the legacy
// array path and on a bridged Session must leave the same openaiHistory. This is the
// projection-equivalence gate for moving the browser onto the event log.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { makeReplayFetch, FAKE_EP } from './replay-harness.ts';
import { NULL_RENDER_ADAPTER } from '../render-adapter.ts';
import { KEYS } from '../storage-keys.ts';
import { openBrowserSession, seedSessionFromHistory, canUseSession } from '../browser-session.ts';
import { registry } from '../session-registry.ts';
import { Session } from '../session.ts';
import { setOpenaiHistory } from '../state.ts';
import * as state from '../state.ts';

const W = window as any;

beforeAll(async () => {
    await import('../llm-loops.ts');
    await import('../chat-state.ts');
    await import('../step-validator.ts');
});

afterEach(() => { W.workflowMode = false; });

beforeEach(() => {
    localStorage.clear();
    W.fetch?.mockReset?.();
    W.mainAgentRole = null;
    localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify(['openrouter|qwen/qwen3-30b-a3b']));
    localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
    registry.setActive(null);
});

const history = () => state.openaiHistory;

describe('seeding and mirroring', () => {
    it('normalises the array to the projection: nudges become <nudge> user turns, empty assistants drop', () => {
        setOpenaiHistory([
            { role: 'user', content: 'task' },
            { role: 'assistant', content: null },
            { role: 'system', content: 'be careful' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'list_files', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'a', name: 'list_files', content: '{"files":[]}' },
        ]);
        const b = openBrowserSession('c1');
        expect(history().map((m: any) => m.role)).toEqual(['user', 'user', 'assistant', 'tool']);
        expect(history()[1].content).toBe('<nudge>be careful</nudge>');
        expect(history()).toEqual(b.session.deriveMessages());
        b.close();
    });

    it('mirrors appends and replaces into the same array, keeping it mutable', () => {
        const arr: any[] = [{ role: 'user', content: 'task' }];
        setOpenaiHistory(arr);
        const b = openBrowserSession('c2');
        const s = b.session;
        s.append('assistant/message', { turn: 0, step: 0, message: { role: 'assistant', content: 'hi' } }, { surfaceOp: 'append' } as any);
        expect(history().map((m: any) => m.content)).toEqual(['task', 'hi']);
        expect(history()).toBe(arr);                               // same array object
        const lastSeq = s.surface[s.surface.length - 1];
        s.append('user/message', { role: 'user', content: null } as any, { surfaceOp: { op: 'replace', start: lastSeq, end: lastSeq } } as any);
        expect(history().map((m: any) => m.content)).toEqual(['task']);   // tombstone rebuilt in place
        expect(history()).toBe(arr);
        (history()[0] as any).content = 'edited';                  // frozen log objects must not leak into the array
        expect(s.deriveMessages()[0].content).toBe('task');
        b.close();
    });

    it('close() detaches, restores the previous active session, and does not undo later pops', () => {
        const prev = new Session({ id: 'prev', chatId: 'x' });
        registry.setActive(prev);
        setOpenaiHistory([{ role: 'user', content: 'task' }]);
        const b = openBrowserSession('c3');
        expect(registry.active()).toBe(b.session);
        b.close();
        expect(registry.active()).toBe(prev);
        history().pop();                                           // the error path in agent-core
        b.session.append('user/message', { role: 'user', content: 'late' }, { surfaceOp: 'append' } as any);
        expect(history()).toEqual([]);
    });

    it('replays a legacy array through a Session and derives the same messages', () => {
        const legacy = [
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b', tool_calls: [{ id: 't', type: 'function', function: { name: 'x', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 't', name: 'x', content: 'r' },
            { role: 'assistant', content: 'done' },
        ];
        const s = new Session({ id: 'seed', chatId: 'c' });
        seedSessionFromHistory(s, legacy);
        expect(s.deriveMessages()).toEqual(legacy);
    });

    it('keeps fn-tag models on the legacy path', () => {
        expect(canUseSession('fn-tag')).toBe(false);
        expect(canUseSession('openai')).toBe(true);
    });
});

let lastEvents: string[] = [];
async function runScripted(useSession: boolean): Promise<any[]> {
    localStorage.clear();
    localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify(['openrouter|qwen/qwen3-30b-a3b']));
    localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
    W.newChat?.();
    setOpenaiHistory([{ role: 'user', content: 'Do the task.' }]);
    W._sessionToolFilter = new Set(['list_files', 'web_search', 'execute_code']);
    W.fetch = makeReplayFetch([
        { content: 'Looking.', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'list_files', arguments: '{"path":"/"}' } }] },
        { content: 'The answer is 42.\n\nCOMPLETED' },
    ]);
    const b = useSession ? openBrowserSession('equiv') : null;
    try { await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER); } finally { b?.close(); }
    lastEvents = b ? b.session.events.map(e => e.type) : [];
    return JSON.parse(JSON.stringify(history()));
}

describe('equivalence: legacy path vs bridged Session', () => {
    it('a tool-call turn leaves the same openaiHistory', async () => {
        const legacy = await runScripted(false);
        const bridged = await runScripted(true);
        // The loop really took the Session path: the event log, not _s.history, recorded the turn.
        expect(lastEvents).toEqual(expect.arrayContaining(['assistant/message', 'tool/result']));
        const shape = (h: any[]) => h.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 40) : m.content,
            calls: m.tool_calls?.map((t: any) => t.function.name), id: m.tool_call_id }));
        expect(legacy.length).toBeGreaterThan(2);
        expect(shape(bridged)).toEqual(shape(legacy));
    });
});

describe('runAgentTurn (the interactive TUI entry point) uses a Session by default', () => {
    async function turn(flag: string | null) {
        localStorage.clear();
        localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify(['openrouter|qwen/qwen3-30b-a3b']));
        localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
        if (flag !== null) localStorage.setItem('fg_session_history', flag);
        await import('../agent-core.ts');
        W.addVoiceButtons ??= () => {};   // UI hook reached by setInputState; not loaded in this test env
        W.clearImageAttachments ??= () => {};
        W.workflowMode = true;            // NULL render adapter, as the TUI's placeholder factory does
        W.newChat?.();
        setOpenaiHistory([]);
        W._sessionToolFilter = new Set(['list_files', 'web_search', 'execute_code']);
        W.fetch = makeReplayFetch([
            { content: 'Looking.', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'list_files', arguments: '{"path":"/"}' } }] },
            { content: 'The answer is 42.\n\nCOMPLETED' },
        ]);
        const sessions: any[] = [];
        const real = registry.setActive.bind(registry);
        registry.setActive = (s: any) => { if (s) sessions.push(s); real(s); };
        try { await W.runAgentTurn('Do the task.', null); } finally { registry.setActive = real; }
        return { hist: JSON.parse(JSON.stringify(history())), sessions, active: registry.active() };
    }
    it('runs on a Session, mirrors into the history array, and detaches afterwards', async () => {
        const r = await turn(null);   // default: on
        expect(r.sessions).toHaveLength(1);
        expect(r.sessions[0].events.some((e: any) => e.type === 'tool/result')).toBe(true);
        expect(r.active).toBeNull();
        expect(r.hist.map((m: any) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    });
    it('the setting turns it off and gives the same history on the legacy path', async () => {
        const on = await turn(null);
        const off = await turn('false');
        expect(off.sessions).toHaveLength(0);
        expect(off.hist.map((m: any) => m.role)).toEqual(on.hist.map((m: any) => m.role));
    });
});
