// The Chats tab (tabs.ts activateTab -> renderChatsDropdown). tabs.ts reads renderChatsDropdown as
// a window global; it was never exported, so opening the tab threw and left the panel empty.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

const W = window as any;

beforeAll(async () => {
    await import('../chat-state.ts');
    await import('../convo-log.ts');
    await import('../workspace.ts');
    await import('../tabs.ts');
});

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = `
        <div id="tab-content">
            <div class="tab-panel" data-panel="chat"></div>
            <div class="tab-panel" data-panel="chats"><div id="chats-dropdown" class="chats-full"></div></div>
        </div>
        <div id="rail-recent-chats"></div>`;
    localStorage.setItem('fg_chat_list', JSON.stringify([
        { id: 'a', name: 'First chat', createdAt: 1, lastAt: 2 },
        { id: 'b', name: 'Second chat', createdAt: 3, lastAt: 4 },
    ]));
});

describe('Chats tab', () => {
    it('exports renderChatsDropdown on window (tabs.ts calls it as a global)', () => {
        expect(typeof W.renderChatsDropdown).toBe('function');
    });

    it('lists every saved chat, newest first, with a toolbar', () => {
        W.renderChatsDropdown();
        const el = document.getElementById('chats-dropdown')!;
        expect(el.querySelector('.chats-toolbar-title')!.textContent).toBe('Chats (2)');
        expect([...el.querySelectorAll('.chat-list-name')].map(n => n.textContent)).toEqual(['Second chat', 'First chat']);
    });

    it('shows "No saved chats" when there are none', () => {
        localStorage.setItem('fg_chat_list', '[]');
        W.renderChatsDropdown();
        expect(document.querySelector('.chats-empty')!.textContent).toBe('No saved chats');
    });

    it('opening the tab activates the panel and renders the list', () => {
        W.activateTab('chats');
        expect(document.querySelector('[data-panel="chats"]')!.classList.contains('active')).toBe(true);
        expect(document.querySelectorAll('#chats-dropdown .chat-card')).toHaveLength(2);
    });
});
