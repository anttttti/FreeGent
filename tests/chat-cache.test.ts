// chat-state.ts keeps localStorage copies (_oh history, _msgs HTML) only for the most recent
// chats; the rest load from the session store (IndexedDB). See _pruneChatCaches.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';

beforeAll(async () => { await import('../chat-state.ts'); });

afterEach(() => {
    window.setSessionStore(null);
    localStorage.clear();
    window.activeChatId = null;
    window.openaiHistory = [];
});

function seedChats(n: number) {
    const list = Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: `Chat ${i}`, createdAt: i, lastAt: i }));
    localStorage.setItem('fg_chat_list', JSON.stringify(list));
    for (const c of list) {
        localStorage.setItem(`fg_chat_${c.id}_oh`, JSON.stringify([{ role: 'user', content: `hello from ${c.id}` }]));
        localStorage.setItem(`fg_chat_${c.id}_msgs`, '<div>x</div>');
    }
}

describe('saveHistory — localStorage chat cache', () => {
    it('keeps the active chat and the two most recent others, drops the rest', () => {
        seedChats(6);                      // c5 is most recent
        window.activeChatId = 'c0';        // oldest chat is the active one
        window.openaiHistory = [{ role: 'user', content: 'hi' }];
        window.saveHistory();
        const cached = [0, 1, 2, 3, 4, 5].filter(i => localStorage.getItem(`fg_chat_c${i}_oh`) !== null);
        expect(cached).toEqual([0, 4, 5]);
        expect(localStorage.getItem('fg_chat_c3_msgs')).toBeNull();
    });

    it('evictOldChatCaches also drops old per-chat logs, oldest chat first', () => {
        seedChats(3);
        localStorage.setItem('fg_chat_c0_log', '[1]');
        localStorage.setItem('fg_chat_c0_raw', '[1]');
        window.activeChatId = 'c2';
        let calls = 0;
        expect(window.evictOldChatCaches(() => ++calls === 1)).toBe(true);
        expect(localStorage.getItem('fg_chat_c0_log')).toBeNull();
        expect(localStorage.getItem('fg_chat_c0_raw')).toBeNull();
        expect(localStorage.getItem('fg_chat_c1_oh')).not.toBeNull();  // stopped after the first
    });
});

describe('searchMessages', () => {
    it('finds chats that are only in the session store', async () => {
        localStorage.setItem('fg_chat_list', JSON.stringify([{ id: 'old', name: 'Old', createdAt: 1, lastAt: 1 }]));
        window.setSessionStore({ loadHistory: async (id: string) => id === 'old' ? [{ role: 'user', content: 'needle here' }] : null } as any);
        const hits = await window.searchMessages('needle');
        expect(hits.map((h: any) => h.chatId)).toEqual(['old']);
    });
});
