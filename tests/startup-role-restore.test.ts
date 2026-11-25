// review of a15a727: startup seeded the Director with clearMainAgentRole(), which also erased the chat's saved role before restoreRoleForChat read it.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { setActiveChatId } from '../state.ts';

const W = window as any;
beforeAll(async () => { await import('../skills.ts'); await import('../workers.ts'); });
afterEach(() => { localStorage.clear(); setActiveChatId(null); });

describe('startup role seed', () => {
    it("seeding the Director without persisting keeps the chat's saved role for the restore", () => {
        W.rolesRegistry.set('Reviewer', { name: 'Reviewer', prompt: 'x' });
        try {
            setActiveChatId('chat-1');
            W.setMainAgentRole('Reviewer');
            const saved = [...Array(localStorage.length).keys()].map(i => localStorage.key(i)!).find(k => localStorage.getItem(k) === 'Reviewer')!;
            expect(saved).toBeTruthy();
            W.clearMainAgentRole(false);
            expect(localStorage.getItem(saved)).toBe('Reviewer');
            W.clearMainAgentRole();
            expect(localStorage.getItem(saved)).toBeNull();
        } finally { W.rolesRegistry.delete('Reviewer'); }
    });
});
