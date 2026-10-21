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

    it('has a visible entry point for message search (hermes F9)', () => {
        let opened = 0; W.openMsgSearch = () => { opened++; };
        W.renderChatsDropdown();
        const btn = [...document.querySelectorAll('#chats-dropdown .chats-toolbar button')].find(b => /Messages/.test(b.textContent || '')) as HTMLElement;
        expect(btn).toBeTruthy();
        btn.click();
        expect(opened).toBe(1);
        delete W.openMsgSearch;
    });

    it('refreshes the list when another tab changes fg_chat_list (hermes F7)', async () => {
        W.renderChatsDropdown();
        const names = () => [...document.querySelectorAll('#chats-dropdown .chat-list-name')].map(n => n.textContent);
        expect(names()).toContain('First chat');
        localStorage.setItem('fg_chat_list', JSON.stringify([
            { id: 'a', name: 'Renamed in tab 2', createdAt: 1, lastAt: 2 },
            { id: 'b', name: 'Second chat', createdAt: 3, lastAt: 4 },
        ]));
        window.dispatchEvent(new StorageEvent('storage', { key: 'fg_chat_list', storageArea: localStorage }));
        await new Promise(r => setTimeout(r, 250));
        expect(names()).toContain('Renamed in tab 2');
    });

    it('a redraw from another tab keeps the filter being typed and its focus (codex 327)', async () => {
        W.renderChatsDropdown();
        const input = () => document.getElementById('chat-search-input') as HTMLInputElement;
        input().focus(); input().value = 'Second'; input().oninput!(new Event('input'));
        const visible = () => [...document.querySelectorAll('#chats-dropdown .chat-list-item')].filter(e => (e as HTMLElement).style.display !== 'none').length;
        expect(visible()).toBe(1);
        localStorage.setItem('fg_chat_list', JSON.stringify([
            { id: 'a', name: 'Renamed in tab 2', createdAt: 1, lastAt: 2 },
            { id: 'b', name: 'Second chat', createdAt: 3, lastAt: 4 },
        ]));
        window.dispatchEvent(new StorageEvent('storage', { key: 'fg_chat_list', storageArea: localStorage }));
        await new Promise(r => setTimeout(r, 250));
        expect(input().value).toBe('Second');
        expect(visible()).toBe(1);
        expect(document.activeElement).toBe(input());
    });
});
