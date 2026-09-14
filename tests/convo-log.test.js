// Tests for convo-log.ts's Rewind/Rerun log-pruning and session-restoration behaviour.
// Checkpoints must erase the superseded run's log entries (sessionLogTurns / raw captures),
// not just leave them accumulating forever alongside the replacement run.
// See session-store.test.ts for the raw-capture half.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../convo-log.ts';

const CHAT = 'chat_test_1';

beforeEach(() => {
    window.conversationLog.length = 0;
    try { sessionStorage.removeItem('fg_convo_log'); } catch {}
    localStorage.removeItem(`fg_chat_${CHAT}_log`);
});

afterEach(() => {
    localStorage.removeItem(`fg_chat_${CHAT}_log`);
    localStorage.removeItem('fg_chat_other_chat_log');
});

function push(chatId, ts) {
    window.convoLogTurn({ chatId, ts, model: 'm', response: 'r' });
}

describe('convoLogTurn — per-chat localStorage persistence', () => {
    it('writes each turn to fg_chat_<id>_log in localStorage', () => {
        push(CHAT, '2026-01-01T00:00:00.000Z');
        push(CHAT, '2026-01-01T00:00:05.000Z');
        const stored = JSON.parse(localStorage.getItem(`fg_chat_${CHAT}_log`) || '[]');
        expect(stored).toHaveLength(2);
        expect(stored[0].ts).toBe('2026-01-01T00:00:00.000Z');
    });

    it('is a no-op for localStorage when chatId is null', () => {
        window.convoLogTurn({ chatId: null, ts: '2026-01-01T00:00:00.000Z', model: 'm', response: 'r' });
        // No key should be created for null chatId
        const keys = Object.keys(localStorage).filter(k => k.endsWith('_log'));
        expect(keys.filter(k => k.includes('null'))).toHaveLength(0);
    });

    it('caps the per-chat localStorage log at 200 entries', () => {
        for (let i = 0; i < 205; i++)
            window.convoLogTurn({ chatId: CHAT, ts: new Date(i * 1000).toISOString(), model: 'm', response: `r${i}` });
        const stored = JSON.parse(localStorage.getItem(`fg_chat_${CHAT}_log`) || '[]');
        expect(stored.length).toBeLessThanOrEqual(200);
        // Most-recent entries are kept
        expect(stored[stored.length - 1].response).toBe('r204');
    });
});

describe('loadChatLog — session restoration', () => {
    it('merges persisted per-chat log into conversationLog', () => {
        push(CHAT, '2026-01-01T00:00:00.000Z');
        push(CHAT, '2026-01-01T00:00:05.000Z');
        // Simulate a page reload: clear in-memory log but leave localStorage intact
        window.conversationLog.length = 0;
        window.loadChatLog(CHAT);
        expect(window.conversationLog).toHaveLength(2);
        expect(window.conversationLog[0].ts).toBe('2026-01-01T00:00:00.000Z');
    });

    it('replaces existing in-memory entries for that chat with the localStorage copy (page-reload simulation)', () => {
        // Simulate pre-reload state: entries written to localStorage but not yet loaded back.
        // Seed localStorage directly so we control what the "pre-reload" log contained.
        localStorage.setItem(`fg_chat_${CHAT}_log`, JSON.stringify([
            { ts: '2026-01-01T00:00:00.000Z', chatId: CHAT, model: 'm', response: 'real' },
        ]));
        // Simulate post-reload: in-memory log has a different (stale sessionStorage) entry.
        window.conversationLog.length = 0;
        window.conversationLog.push({ ts: '2025-01-01T00:00:00.000Z', chatId: CHAT, model: 'stale', response: 'stale' });
        // loadChatLog should replace the stale in-memory entries with the localStorage truth.
        window.loadChatLog(CHAT);
        const entries = window.conversationLog.filter(e => e.chatId === CHAT);
        expect(entries).toHaveLength(1);
        expect(entries[0].ts).toBe('2026-01-01T00:00:00.000Z');
    });

    it('preserves entries for other chats when loading a specific chat', () => {
        push('other_chat', '2026-01-01T00:00:00.000Z');
        push(CHAT, '2026-01-01T00:00:05.000Z');
        window.conversationLog.length = 0;
        window.convoLogTurn({ chatId: 'other_chat', ts: '2026-01-01T00:00:00.000Z', model: 'm', response: 'r' });
        window.loadChatLog(CHAT);
        const others = window.conversationLog.filter(e => e.chatId === 'other_chat');
        expect(others).toHaveLength(1);
        const ours = window.conversationLog.filter(e => e.chatId === CHAT);
        expect(ours).toHaveLength(1);
    });

    it('is a no-op when chatId is falsy', () => {
        push(CHAT, '2026-01-01T00:00:00.000Z');
        window.conversationLog.length = 0;
        expect(() => window.loadChatLog(null)).not.toThrow();
        expect(window.conversationLog).toHaveLength(0);
    });

    it('is a no-op when the chat has no persisted log', () => {
        // conversationLog starts empty; no localStorage key for CHAT
        window.loadChatLog(CHAT);
        expect(window.conversationLog).toHaveLength(0);
    });
});

describe('pruneConvoLogFrom', () => {
    it('removes entries for the chat at/after the checkpoint time, keeps earlier ones', () => {
        push(CHAT, '2026-01-01T00:00:00.000Z');
        push(CHAT, '2026-01-01T00:00:05.000Z');
        push(CHAT, '2026-01-01T00:00:10.000Z');
        const sinceMs = new Date('2026-01-01T00:00:05.000Z').getTime();
        window.pruneConvoLogFrom(CHAT, sinceMs);
        expect(window.conversationLog.map(e => e.ts)).toEqual(['2026-01-01T00:00:00.000Z']);
    });
    it('leaves other chats untouched', () => {
        push(CHAT, '2026-01-01T00:00:00.000Z');
        push('other_chat', '2026-01-01T00:00:00.000Z');
        window.pruneConvoLogFrom(CHAT, new Date('2026-01-01T00:00:00.000Z').getTime());
        expect(window.conversationLog).toHaveLength(1);
        expect(window.conversationLog[0].chatId).toBe('other_chat');
    });
    it('is a no-op when nothing is at/after the checkpoint', () => {
        push(CHAT, '2026-01-01T00:00:00.000Z');
        window.pruneConvoLogFrom(CHAT, new Date('2026-01-01T00:00:05.000Z').getTime());
        expect(window.conversationLog).toHaveLength(1);
    });
    it('also prunes the per-chat localStorage so restored sessions do not replay pruned entries', () => {
        push(CHAT, '2026-01-01T00:00:00.000Z');
        push(CHAT, '2026-01-01T00:00:05.000Z');
        push(CHAT, '2026-01-01T00:00:10.000Z');
        const sinceMs = new Date('2026-01-01T00:00:05.000Z').getTime();
        window.pruneConvoLogFrom(CHAT, sinceMs);
        const stored = JSON.parse(localStorage.getItem(`fg_chat_${CHAT}_log`) || '[]');
        expect(stored.map(e => e.ts)).toEqual(['2026-01-01T00:00:00.000Z']);
    });
    it('loadChatLog after prune does not restore the pruned entries', () => {
        push(CHAT, '2026-01-01T00:00:00.000Z');
        push(CHAT, '2026-01-01T00:00:05.000Z');
        window.pruneConvoLogFrom(CHAT, new Date('2026-01-01T00:00:05.000Z').getTime());
        window.conversationLog.length = 0;
        window.loadChatLog(CHAT);
        expect(window.conversationLog.map(e => e.ts)).toEqual(['2026-01-01T00:00:00.000Z']);
    });
});
