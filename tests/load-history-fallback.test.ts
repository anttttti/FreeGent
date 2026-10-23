// opencode §18: a session-store read that rejects falls back to the localStorage cache instead of loading nothing.
import { describe, it, expect, beforeAll, vi } from 'vitest';
const W: any = window;
beforeAll(async () => {
    W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    await import('../settings-ui.ts');
    await import('../agent-core.ts');
    await import('../chat-state.ts');
});
describe('loadChatHistory', () => {
    it('uses the cache when the session store read throws', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        localStorage.setItem('fg_chat_Z_oh', JSON.stringify([{ role: 'user', content: 'CACHED-HISTORY' }]));
        W.activeChatId = 'Z';
        W.sessionLoadHistory = async () => { throw new Error('simulated store read failure'); };
        W.setChatHistory([]);
        const ok = await W.loadChatHistory('Z');
        delete W.sessionLoadHistory;
        expect(ok).toBe(true);
        expect(JSON.stringify(W.getChatHistory())).toContain('CACHED-HISTORY');
    });
});
