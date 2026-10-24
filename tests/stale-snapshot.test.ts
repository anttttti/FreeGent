// A chat's message snapshot that no store could take must not be replaced, at the next open, by an older copy: the last turn would be missing from the view
// although the history holds it ("its answer disappears", user report 2026-10-25; IndexedDB internal errors were seen in the uploaded error batches).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { makeReplayFetch } from './replay-harness.ts';
import '../chat-attachments.ts';
import * as postTurn from '../post-turn.ts';
import { KEYS, chatKey } from '../storage-keys.ts';
import { setChatHistory } from '../chat-history.ts';

const W: any = window;
beforeAll(async () => {
    W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    await import('../settings-ui.ts'); await import('../llm-loops.ts'); await import('../agent-core.ts');
    await import('../convo-log.ts'); await import('../chat-state.ts'); await import('../step-validator.ts');
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
    W.activateTab = () => {}; W.addVoiceButtons = () => {}; W.generateAndShowSuggestion = () => {};
    W.mainAgentRole = null;
    localStorage.setItem(KEYS.UTILITY_MODEL, 'none');
    localStorage.setItem(KEYS.CHAT_LIST, JSON.stringify([]));
    W.setActiveChatId(null); setChatHistory([]); W.createNewChat();
});
afterEach(() => { vi.restoreAllMocks(); W.setSessionStore?.(null); });
const settle = async () => { for (let i = 0; i < 100 && W.aiBusy(); i++) await new Promise(r => setTimeout(r, 20)); await new Promise(r => setTimeout(r, 40)); };

describe('message snapshot nobody could store', () => {
    it('is marked, and the chat then opens rebuilt from its history, last answer included', async () => {
        W.fetch = makeReplayFetch([{ content: 'the answer of the turn\nCOMPLETED' }]);
        localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify(['openrouter|nvidia/nemotron-3-ultra-550b-a55b:free']));
        localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
        W._sessionToolFilter = new Set(['list_files']);
        (document.getElementById('agent-input') as any).innerText = 'question one';
        await W.agentSend(); await settle();
        const a = W.activeChatId;
        // The view has grown past what localStorage keeps (1 MB) and the IndexedDB write fails (jsdom has none): there is no current copy anywhere.
        document.getElementById('agent-messages')!.insertAdjacentHTML('beforeend', '<div class="agent-msg-model">' + 'x'.repeat(1_100_000) + '</div>');
        W.saveHistory();
        await new Promise(r => setTimeout(r, 80));
        expect(localStorage.getItem(chatKey.msgs(a))).toBe('<!--fg-stale-snapshot-->');
        W.createNewChat();
        await W.switchToChat(a);
        const shown = document.getElementById('agent-messages')!.textContent!;
        expect(shown).toContain('Reconstructed from saved context');
        expect(shown).toContain('the answer of the turn');
    });
});
