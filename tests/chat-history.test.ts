// chat-history.test.ts — the chat's history is a Session event log (task 071): there is no
// mutable message array. Covers the module's API, the persisted-array round trip (saved chats and
// exported files stay plain message arrays), rewind/retry/rollback, and the fn-tag request
// projection, end to end through runTurn.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeReplayFetch, FAKE_EP } from './replay-harness.ts';
import { NULL_RENDER_ADAPTER } from '../render-adapter.ts';
import { KEYS, chatKey } from '../storage-keys.ts';
import {
    getChatHistory, setChatHistory, appendChatMessage, chatSession, chatHistoryLength,
    clearChatHistory, dropTrailingUserMessage,
} from '../chat-history.ts';
import { fnTagMessages } from '../payload-builder.ts';
import { defaultSession } from '../state.ts';

const W = window as any;

beforeAll(async () => {
    await import('../llm-loops.ts');
    await import('../chat-state.ts');
    await import('../render-adapter.ts');
    await import('../step-validator.ts');
});

beforeEach(() => {
    localStorage.clear();
    clearChatHistory();
    W.mainAgentRole = null;
    localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify(['openrouter|qwen/qwen3-30b-a3b']));
    localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
    W._sessionToolFilter = new Set(['list_files', 'web_search', 'execute_code']);
});

const toolTurn = (id: string, name = 'list_files', out = '{"files":["a.txt"]}') => [
    { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: '{"path":"/"}' } }] },
    { role: 'tool', tool_call_id: id, name, content: out },
];

describe('chat history as a Session', () => {
    it('round-trips a message array: tool calls, tool results and text keep their shape', () => {
        const msgs = [
            { role: 'user', content: 'list the files' },
            ...toolTurn('c1'),
            { role: 'assistant', content: 'There is one file.' },
        ];
        setChatHistory(msgs);
        expect(getChatHistory()).toEqual(msgs);
    });

    it('is the default session\'s event log, not a copy', () => {
        setChatHistory([{ role: 'user', content: 'hi' }]);
        expect(defaultSession._session).toBe(chatSession());
        chatSession().append('assistant/message', { turn: 0, step: 0, message: { role: 'assistant', content: 'yo' } }, { surfaceOp: 'append' } as any);
        expect(getChatHistory().map(m => m.content)).toEqual(['hi', 'yo']);
    });

    it('drops null entries and turns system-role nudges into <nudge> user turns', () => {
        setChatHistory([{ role: 'user', content: 'a' }, null, { role: 'system', content: 'be brief' }, undefined]);
        expect(getChatHistory()).toEqual([
            { role: 'user', content: 'a' },
            { role: 'user', content: '<nudge>be brief</nudge>' },
        ]);
    });

    it('appendChatMessage adds to the end, wrapping a system-role message the same way', () => {
        setChatHistory([{ role: 'user', content: 'a' }]);
        appendChatMessage({ role: 'user', content: 'b' });
        appendChatMessage({ role: 'system', content: 'n' });
        expect(getChatHistory().map(m => m.content)).toEqual(['a', 'b', '<nudge>n</nudge>']);
        expect(chatHistoryLength()).toBe(3);
    });

    it('returns a snapshot: changing the returned array changes nothing', () => {
        setChatHistory([{ role: 'user', content: 'a' }]);
        getChatHistory().push({ role: 'user', content: 'ghost' });
        expect(chatHistoryLength()).toBe(1);
    });

    it('rewind and retry are a slice of the projection', () => {
        setChatHistory([{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' }]);
        setChatHistory(getChatHistory().slice(0, 2));                       // rewind to a checkpoint
        expect(getChatHistory().map(m => m.content)).toEqual(['q1', 'a1']);
        const h = getChatHistory();
        let i = h.length - 1; while (i >= 0 && h[i].role !== 'user') i--;   // retryLastTurn's cut
        setChatHistory(h.slice(0, i + 1));
        expect(getChatHistory().map(m => m.content)).toEqual(['q1']);
    });

    it('the old Session is released when the history is replaced', () => {
        const before = chatSession();
        setChatHistory([{ role: 'user', content: 'x' }]);
        expect(chatSession()).not.toBe(before);
        expect(defaultSession._session).toBe(chatSession());
    });

    it('rolls back a failed turn\'s user message without touching earlier ones', () => {
        setChatHistory([{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }]);
        appendChatMessage({ role: 'user', content: 'q2' });
        expect(dropTrailingUserMessage()).toBe(true);
        expect(getChatHistory().map(m => m.content)).toEqual(['q1', 'a1']);
        expect(dropTrailingUserMessage()).toBe(false);                      // newest is an assistant turn
        expect(chatHistoryLength()).toBe(2);
    });

    it('a manual compaction result replaces the history', async () => {
        const { compactHistory } = await import('../llm-shared.ts');
        W.fetch = makeReplayFetch([{ content: 'GOAL: x' }]);
        setChatHistory([{ role: 'user', content: 'Fix the bug.' }, ...toolTurn('c1'), ...toolTurn('c2'), ...toolTurn('c3')]);
        setChatHistory(await compactHistory(NULL_RENDER_ADAPTER, FAKE_EP));
        const h = getChatHistory();
        expect(h[0].content).toContain('Fix the bug.');                     // the pinned task
        expect(h[1].content).toMatch(/^\[SYSTEM: The conversation history above has been compacted/);
        expect(h[1].content).toContain('GOAL: x');
    });
});

describe('persisted format', () => {
    it('saveHistory writes the plain message array and loadChatHistory restores the same history', async () => {
        W.activeChatId = 'chat_persist';
        const msgs = [{ role: 'user', content: 'list' }, ...toolTurn('c1'), { role: 'assistant', content: 'done' }];
        setChatHistory(msgs);
        W.saveHistory();
        const stored = JSON.parse(localStorage.getItem(chatKey.oh(W.activeChatId))!);
        expect(stored).toEqual(msgs);                                       // a plain array, as before the Session
        clearChatHistory();
        expect(chatHistoryLength()).toBe(0);
        expect(await W.loadChatHistory(W.activeChatId)).toBe(true);
        expect(getChatHistory()).toEqual(msgs);
    });

    it('an array saved by an older version (system-role nudge, string tool content) loads', async () => {
        W.activeChatId = 'chat_legacy';
        const legacy = [
            { role: 'user', content: 'q' },
            { role: 'system', content: 'be brief' },
            { role: 'assistant', content: 'a' },
        ];
        localStorage.setItem(chatKey.oh(W.activeChatId), JSON.stringify(legacy));
        expect(await W.loadChatHistory(W.activeChatId)).toBe(true);
        expect(getChatHistory().map(m => m.content)).toEqual(['q', '<nudge>be brief</nudge>', 'a']);
    });
});

describe('fn-tag projection', () => {
    it('shows a model no tool_calls and no tool role: results of a step are one user message', () => {
        const native = [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: null, tool_calls: [
                { id: 'a', type: 'function', function: { name: 'list_files', arguments: '{}' } },
                { id: 'b', type: 'function', function: { name: 'web_search', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'a', name: 'list_files', content: '{"x":1}' },
            { role: 'tool', tool_call_id: 'b', name: 'web_search', content: '[EXIT CODE 1]\n{"y":2}' },
            { role: 'assistant', content: 'ok', tool_calls: [{ id: 'c', type: 'function', function: { name: 'list_files', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'c', name: 'list_files', content: '{}' },
        ];
        const out = fnTagMessages(native);
        expect(out.some(m => m.role === 'tool' || m.tool_calls)).toBe(false);
        expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
        expect(out[2].content).toBe(
            '<tool_response>\n<tool_name>list_files</tool_name>\n<result>\n{"x":1}\n</result>\n</tool_response>\n\n' +
            '<tool_response>\n<tool_name>web_search</tool_name>\n<result>\n[EXIT CODE 1]\n{"y":2}\n</result>\n</tool_response>');
        expect(out[3]).toEqual({ role: 'assistant', content: 'ok' });
    });

    it('leaves a history without tool messages as it is', () => {
        const h = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
        expect(fnTagMessages(h)).toEqual(h);
    });

    it('a fn-tag model\'s next request carries the text-tag shape while the chat keeps the native one', async () => {
        localStorage.setItem(KEYS.TOOL_FORMATS_LEARNED, JSON.stringify({ 'openrouter/test-model': { fmt: 'fn-tag', at: Date.now() } }));
        setChatHistory([{ role: 'user', content: 'Do the task.' }]);
        const requests: any[] = [];
        W.fetch = makeReplayFetch([
            { content: '<function=list_files>{"path":"/"}</function>' },     // a text call (a native one would re-classify the model)
            { content: 'All done.\nCOMPLETED' },
        ], { onRequest: b => requests.push(b) });
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);

        expect(requests).toHaveLength(2);
        const second = requests[1].messages.filter((m: any) => m.role !== 'system' || typeof m.content !== 'string' || !m.content.startsWith('You are'));
        expect(second.some((m: any) => m.role === 'tool' || m.tool_calls)).toBe(false);
        const results = second.filter((m: any) => m.role === 'user' && String(m.content).startsWith('<tool_response>'));
        expect(results).toHaveLength(1);
        expect(results[0].content).toContain('<tool_name>list_files</tool_name>');

        const h = getChatHistory();                                         // the stored shape is native
        expect(h.find(m => m.role === 'tool')?.name).toBe('list_files');
        expect(h.find(m => m.role === 'assistant' && m.tool_calls?.length)).toBeDefined();
    });
});
