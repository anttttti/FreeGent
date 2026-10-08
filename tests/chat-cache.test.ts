// chat-state.ts keeps localStorage copies (_oh history, _msgs HTML) only for the most recent
// chats; the rest load from the session store (IndexedDB). See _pruneChatCaches.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';

beforeAll(async () => { await import('../chat-state.ts'); });

afterEach(() => {
    window.setSessionStore(null);
    localStorage.clear();
    window.activeChatId = null;
    window.setChatHistory([]);
});

function seedChats(n: number, p = 'c') {
    const list = Array.from({ length: n }, (_, i) => ({ id: `${p}${i}`, name: `Chat ${i}`, createdAt: i, lastAt: i }));
    localStorage.setItem('fg_chat_list', JSON.stringify(list));
    for (const c of list) {
        localStorage.setItem(`fg_chat_${c.id}_oh`, JSON.stringify([{ role: 'user', content: `hello from ${c.id}` }]));
        localStorage.setItem(`fg_chat_${c.id}_msgs`, '<div>x</div>');
    }
}

// A store that holds every seeded chat's history (what the browser's IndexedDB adapter would).
function storeWith(ids: string[]) {
    const held = new Map(ids.map(id => [id, [{ role: 'user', content: `hello from ${id}` }]]));
    window.setSessionStore({
        loadHistory: async (id: string) => held.get(id) ?? null,
        replaceMessages: async (id: string, h: any[]) => { held.set(id, h); },
    } as any);
    return held;
}
const settle = () => new Promise(r => setTimeout(r, 20));

describe('saveHistory — localStorage chat cache', () => {
    it('keeps the active chat and the two most recent others, drops the rest once they are in the store', async () => {
        seedChats(6);                      // c5 is most recent
        storeWith(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
        window.activeChatId = 'c0';        // oldest chat is the active one
        window.setChatHistory([{ role: 'user', content: 'hi' }]);
        window.saveHistory();
        await settle();
        const cached = [0, 1, 2, 3, 4, 5].filter(i => localStorage.getItem(`fg_chat_c${i}_oh`) !== null);
        expect(cached).toEqual([0, 4, 5]);
        expect(localStorage.getItem('fg_chat_c3_msgs')).toBeNull();
    });

    it('never drops the only copy of a chat (R04): no store, or a store without the chat', async () => {
        seedChats(5, 'n');
        window.setSessionStore(null);
        window.activeChatId = 'n4';
        window.setChatHistory([{ role: 'user', content: 'hi' }]);
        window.saveHistory();
        await settle();
        expect([0, 1, 2, 3].every(i => localStorage.getItem(`fg_chat_n${i}_oh`) !== null)).toBe(true);
        expect(window.evictOldChatCaches(() => false)).toBe(false);
        expect(localStorage.getItem('fg_chat_n0_oh')).not.toBeNull();
        // A store that lacks (or fails to hold) the chats keeps them too.
        window.setSessionStore({ loadHistory: async () => null, replaceMessages: async () => { throw new Error('quota'); } } as any);
        window.saveHistory();
        await settle();
        expect([0, 1, 2, 3].every(i => localStorage.getItem(`fg_chat_n${i}_oh`) !== null)).toBe(true);
    });

    it('evictOldChatCaches also drops old per-chat logs, oldest chat first', async () => {
        seedChats(3);
        storeWith(['c0', 'c1', 'c2']);
        localStorage.setItem('fg_chat_c0_log', '[1]');
        localStorage.setItem('fg_chat_c0_raw', '[1]');
        window.activeChatId = 'c2';
        window.setChatHistory([{ role: 'user', content: 'hi' }]);
        window.saveHistory();              // verifies the stored copies
        await settle();
        localStorage.setItem('fg_chat_c0_oh', JSON.stringify([{ role: 'user', content: 'hello from c0' }]));
        let calls = 0;
        expect(window.evictOldChatCaches(() => ++calls === 1)).toBe(true);
        expect(localStorage.getItem('fg_chat_c0_log')).toBeNull();
        expect(localStorage.getItem('fg_chat_c0_raw')).toBeNull();
        expect(localStorage.getItem('fg_chat_c1_oh')).not.toBeNull();  // stopped after the first
    });
});

describe('history export prefers the complete copy (R03)', () => {
    it('fullerHistory picks the longer of cache and store', async () => {
        const { fullerHistory } = await import('../convo-log.ts');
        const m = (n: number) => Array.from({ length: n }, (_, i) => ({ role: 'user', content: String(i) }));
        expect(fullerHistory(m(2), m(3))).toHaveLength(3);   // trimmed cache, full store
        expect(fullerHistory(m(4), m(3))).toHaveLength(4);   // store not caught up yet
        expect(fullerHistory(null, m(3))).toHaveLength(3);
        expect(fullerHistory(m(2), null)).toHaveLength(2);
        expect(fullerHistory(null, null)).toBeNull();
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
