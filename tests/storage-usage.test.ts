// localStorage usage accounting (storage-usage.ts) and per-chat cleanup of drafts and checkpoints.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { computeStorageUsage, projectUsage, fmtStorageSize } from '../storage-usage.ts';

beforeAll(async () => {
    await import('../chat-state.ts');
    await import('../agent-core.ts');
});

afterEach(() => localStorage.clear());

const size = (k: string) => k.length + (localStorage.getItem(k) || '').length;

function seedCheckpoint(id: string, chatId: string | null) {
    localStorage.setItem(`fg_ckpt_${id}`, JSON.stringify(chatId ? { chatId, userText: 'x' } : { userText: 'x' }));
    const list = JSON.parse(localStorage.getItem('fg_ckpt_list') || '[]');
    localStorage.setItem('fg_ckpt_list', JSON.stringify([...list, id]));
}

describe('computeStorageUsage', () => {
    it('attributes cache, drafts and checkpoints to their chat, the rest to settings or project', () => {
        localStorage.setItem('fg_chat_list', '[{"id":"a"},{"id":"b"}]');
        localStorage.setItem('fg_chat_a_oh', '[1,2,3]');
        localStorage.setItem('fg_chat_a_run_ckpt', '1');
        localStorage.setItem('fg_draft_a', 'unsent');
        localStorage.setItem('fg_chat_b_msgs', '<div>b</div>');
        localStorage.setItem('fg_gemini_key', 'secret');
        seedCheckpoint('1', 'a');
        seedCheckpoint('2', null);           // legacy, no chatId

        const u = computeStorageUsage();
        expect(u.chats.get('a')).toBe(size('fg_chat_a_oh') + size('fg_chat_a_run_ckpt') + size('fg_draft_a') + size('fg_ckpt_1'));
        expect(u.chats.get('b')).toBe(size('fg_chat_b_msgs'));
        expect(u.settings).toBe(size('fg_gemini_key'));
        expect(u.checkpoints).toBe(size('fg_ckpt_1') + size('fg_ckpt_2') + size('fg_ckpt_list'));
        expect(u.project).toBe(size('fg_chat_list') + size('fg_ckpt_list') + size('fg_ckpt_2'));
        expect(projectUsage(u) + u.settings).toBe(u.total);
    });

    it('formats sizes', () => {
        expect(fmtStorageSize(512)).toBe('512 B');
        expect(fmtStorageSize(2_500)).toBe('2.5 KB');
        expect(fmtStorageSize(1_234_567)).toBe('1.23 MB');
    });
});

describe('deleting a chat', () => {
    it('removes its draft and its checkpoints, keeping other chats\' and legacy ones', () => {
        localStorage.setItem('fg_draft_a', 'unsent');
        localStorage.setItem('fg_chat_a_oh', '[]');
        seedCheckpoint('1', 'a');
        seedCheckpoint('2', 'b');
        seedCheckpoint('3', null);
        window.clearChatStorage('a');
        expect(localStorage.getItem('fg_draft_a')).toBeNull();
        expect(localStorage.getItem('fg_chat_a_oh')).toBeNull();
        expect(localStorage.getItem('fg_ckpt_1')).toBeNull();
        expect(localStorage.getItem('fg_ckpt_2')).not.toBeNull();
        expect(localStorage.getItem('fg_ckpt_3')).not.toBeNull();
        expect(JSON.parse(localStorage.getItem('fg_ckpt_list')!)).toEqual(['2', '3']);
    });
});
