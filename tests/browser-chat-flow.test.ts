// browser-chat-flow.test.ts — task 071's "manual pass", as far as jsdom can run it: the real
// browser entry points (agentSend, retryLastTurn, rewindToCheckpoint, switchToChat, reload,
// importChat, exportChat/sendChatLog) against the chat's Session-backed history, with only the
// model endpoint scripted. What it cannot see is the rendered page; that still wants a human look.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { makeReplayFetch } from './replay-harness.ts';
import '../chat-attachments.ts';
import * as postTurn from '../post-turn.ts';
import { KEYS, chatKey } from '../storage-keys.ts';
import { getChatHistory, setChatHistory, chatSession } from '../chat-history.ts';

const W: any = window;

beforeAll(async () => {
    W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    await import('../settings-ui.ts');
    await import('../llm-loops.ts');
    await import('../agent-core.ts');
    await import('../convo-log.ts');
    await import('../chat-state.ts');
    await import('../step-validator.ts');
});

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '<div id="img-strip"></div><div id="agent-input" contenteditable></div><div id="agent-messages"></div><div id="convo-log-count"></div>';
    W.clearImageAttachments(); W.setAgentStreaming(false); W.setAiJob('');
    W._resetModelWarmup = () => {}; W.clearSuggestion = () => {};
    vi.spyOn(W, 'isTaskCompletionRequest').mockResolvedValue(false);
    vi.spyOn(W, 'collectWorkspacePaths').mockResolvedValue([]);
    vi.spyOn(W, 'buildTurnPrelude').mockResolvedValue('');
    vi.spyOn(postTurn, 'repairLedgerIfBroken').mockResolvedValue(undefined);
    vi.spyOn(postTurn, 'runPostTurnAgents').mockResolvedValue(undefined);
    W.activateTab = () => {};
    W.addVoiceButtons = () => {}; W.generateAndShowSuggestion = () => {};
    W.mainAgentRole = null;
    localStorage.setItem(KEYS.UTILITY_MODEL, 'none');   // no auto-title / suggestion calls: they would eat scripted replies
    localStorage.setItem(KEYS.CHAT_LIST, JSON.stringify([]));
    W.setActiveChatId(null);
    setChatHistory([]);
    W.createNewChat();
});
afterEach(() => { vi.restoreAllMocks(); W.setSessionStore?.(null); });

const settle = async () => { for (let i = 0; i < 100 && W.aiBusy(); i++) await new Promise(r => setTimeout(r, 20)); await new Promise(r => setTimeout(r, 20)); };
async function say(text: string) {
    // createNewChat resets the model list, so it is set on every send.
    localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify(['openrouter|nvidia/nemotron-3-ultra-550b-a55b:free']));
    localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
    W._sessionToolFilter = new Set(['list_files']);   // a non-null filter skips the tool classifier, which would eat a scripted reply
    (document.getElementById('agent-input') as any).innerText = text;   // jsdom has no innerText of its own
    await W.agentSend();
    await settle();
}
const roles = () => getChatHistory().map(m => m.role);
const texts = () => getChatHistory().map(m => typeof m.content === 'string' ? m.content : '');
const toolCall = (id: string) => ({ tool_calls: [{ id, type: 'function', function: { name: 'list_files', arguments: '{"path":"/"}' } }] });

describe('browser chat flow on the Session-backed history', () => {
    it('a sent message and the reply land in the chat history, with tool calls and results', async () => {
        W.fetch = makeReplayFetch([toolCall('t1'), { content: 'One file.\nCOMPLETED' }]);
        await say('list the files');
        expect(roles()).toEqual(['user', 'assistant', 'tool', 'assistant']);
        expect(texts()[0]).toContain('list the files');
        expect(getChatHistory()[1].tool_calls[0].id).toBe('t1');
        expect(getChatHistory()[2].tool_call_id).toBe('t1');
    });

    it('a second message continues the same Session; saving writes the plain array', async () => {
        W.fetch = makeReplayFetch([{ content: 'first\nCOMPLETED' }, { content: 'second\nCOMPLETED' }]);
        await say('one');
        const session = chatSession();
        await say('two');
        expect(chatSession()).toBe(session);                                       // not rebuilt between turns
        expect(texts().filter(t => t.includes('one') || t.includes('two') || t.includes('first') || t.includes('second')).length).toBe(4);
        const stored = JSON.parse(localStorage.getItem(chatKey.oh(W.activeChatId))!);
        expect(Array.isArray(stored)).toBe(true);
        expect(stored).toEqual(getChatHistory());
    });

    it('retry regenerates the last answer from the same user message', async () => {
        W.fetch = makeReplayFetch([{ content: 'first answer\nCOMPLETED' }]);
        await say('question');
        W.fetch = makeReplayFetch([{ content: 'second answer\nCOMPLETED' }]);
        await W.retryLastTurn();
        await settle();
        expect(roles()).toEqual(['user', 'assistant']);
        expect(texts()[1]).toContain('second answer');
        expect(texts()[1]).not.toContain('first answer');
    });

    it('rewinding to a checkpoint cuts the history back to before that message', async () => {
        W.fetch = makeReplayFetch([{ content: 'a1\nCOMPLETED' }, { content: 'a2\nCOMPLETED' }]);
        await say('q1');
        await say('q2');
        const list: string[] = JSON.parse(localStorage.getItem(KEYS.CKPT_LIST) || '[]');
        expect(list.length).toBe(2);
        expect(roles()).toEqual(['user', 'assistant', 'user', 'assistant']);
        const row = document.createElement('div');
        document.getElementById('agent-messages')!.appendChild(row);
        await W.rewindToCheckpoint(list[1], row);
        expect(roles()).toEqual(['user', 'assistant']);
        expect(texts()[0]).toContain('q1');
        const stored = JSON.parse(localStorage.getItem(chatKey.oh(W.activeChatId))!);
        expect(stored).toEqual(getChatHistory());                                  // rewind is saved
    });

    it('switching chats saves one history, shows the other, and switching back restores it', async () => {
        W.fetch = makeReplayFetch([{ content: 'answer A\nCOMPLETED' }]);
        await say('chat A question');
        const a = W.activeChatId;
        const histA = getChatHistory();
        W.createNewChat();
        const b = W.activeChatId;
        expect(b).not.toBe(a);
        expect(getChatHistory()).toEqual([]);
        W.fetch = makeReplayFetch([{ content: 'answer B\nCOMPLETED' }]);
        await say('chat B question');
        expect(texts().some(t => t.includes('chat A question'))).toBe(false);

        await W.switchToChat(a);
        expect(W.activeChatId).toBe(a);
        expect(getChatHistory()).toEqual(histA);
        await W.switchToChat(b);
        expect(texts().some(t => t.includes('answer B'))).toBe(true);
        expect(texts().some(t => t.includes('answer A'))).toBe(false);
    });

    it('a reload (history gone from memory, restored from storage) continues the conversation', async () => {
        W.fetch = makeReplayFetch([{ content: 'before reload\nCOMPLETED' }]);
        await say('hello');
        const id = W.activeChatId, saved = getChatHistory();
        setChatHistory([]);                                                         // the tab is gone
        expect(await W.loadChatHistory(id)).toBe(true);
        expect(getChatHistory()).toEqual(saved);
        const requests: any[] = [];
        W.fetch = makeReplayFetch([{ content: 'after reload\nCOMPLETED' }], { onRequest: b => requests.push(b) });
        await say('and now?');
        const sent = requests[0].messages.map((m: any) => String(m.content));
        expect(sent.some((c: string) => c.includes('before reload'))).toBe(true);   // the model sees the restored turns
        expect(roles()).toEqual(['user', 'assistant', 'user', 'assistant']);
    });

    it('exports and the log sent to the developer carry the history under the openaiHistory key', async () => {
        W.fetch = makeReplayFetch([toolCall('t9'), { content: 'done\nCOMPLETED' }]);
        await say('list');
        const sentBodies: string[] = [];
        W.fetch = vi.fn(async (_u: string, init: any) => { sentBodies.push(init.body); return { ok: true, json: async () => ({ id: 'x' }) }; });
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        await W.sendChatLog(W.activeChatId);
        const payload = JSON.parse(sentBodies[0]);
        expect(payload.openaiHistory).toEqual(getChatHistory());
        expect(payload.openaiHistory.map((m: any) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    });

    it('importing an exported file (and an old one with system-role nudges) rebuilds the history in a new chat', async () => {
        const exported = {
            name: 'Imported', openaiHistory: [
                { role: 'user', content: 'old question' },
                { role: 'system', content: 'keep it short' },
                { role: 'assistant', content: null, tool_calls: [{ id: 'o1', type: 'function', function: { name: 'list_files', arguments: '{}' } }] },
                { role: 'tool', tool_call_id: 'o1', name: 'list_files', content: '{}' },
                { role: 'assistant', content: 'old answer' },
            ],
        };
        const before = W.activeChatId;
        const input: any = { click() {}, files: [{ text: async () => JSON.stringify(exported) }] };
        vi.spyOn(document, 'createElement').mockImplementationOnce(() => input);
        await W.importChat();
        await input.onchange();
        expect(W.activeChatId).not.toBe(before);
        expect(roles()).toEqual(['user', 'user', 'assistant', 'tool', 'assistant']);
        expect(texts()[1]).toBe('<nudge>keep it short</nudge>');
        W.fetch = makeReplayFetch([{ content: 'continued\nCOMPLETED' }]);
        await say('follow-up');
        expect(roles().length).toBe(7);
    });
});
