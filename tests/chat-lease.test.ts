import { acquireChatLease, releaseChatLease, chatBusyInAnotherTab, LEASE_TTL_MS } from '../chat-lease.js';

beforeEach(() => localStorage.clear());

describe('chat lease (codex campaign 5, R5-01)', () => {
    it('a tab takes the lease of a free chat and gives it back', () => {
        expect(acquireChatLease('c1')).toBe(true);
        expect(localStorage.getItem('fg_lease_c1')).toBeTruthy();
        releaseChatLease('c1');
        expect(localStorage.getItem('fg_lease_c1')).toBeNull();
    });
    it('is not taken while another tab holds a fresh lease, and is taken once that one has run out', () => {
        localStorage.setItem('fg_lease_c1', JSON.stringify({ tab: 'other-tab', at: Date.now() }));
        expect(chatBusyInAnotherTab('c1')).toBe(true);
        expect(acquireChatLease('c1')).toBe(false);
        expect(JSON.parse(localStorage.getItem('fg_lease_c1')!).tab).toBe('other-tab');   // untouched
        localStorage.setItem('fg_lease_c1', JSON.stringify({ tab: 'other-tab', at: Date.now() - LEASE_TTL_MS - 1 }));
        expect(chatBusyInAnotherTab('c1')).toBe(false);
        expect(acquireChatLease('c1')).toBe(true);
        releaseChatLease('c1');
    });
    it('another chat is unaffected, and a tab does not block itself', () => {
        localStorage.setItem('fg_lease_c1', JSON.stringify({ tab: 'other-tab', at: Date.now() }));
        expect(acquireChatLease('c2')).toBe(true);
        expect(acquireChatLease('c2')).toBe(true);   // again, from the same tab
        releaseChatLease('c2');
    });
    it('releasing never removes another tab\'s lease', () => {
        localStorage.setItem('fg_lease_c1', JSON.stringify({ tab: 'other-tab', at: Date.now() }));
        releaseChatLease('c1');
        expect(localStorage.getItem('fg_lease_c1')).toBeTruthy();
    });
    it('the lease key is outside the project-scoped chat keys', () => {
        expect('fg_lease_c1'.startsWith('fg_chat_')).toBe(false);
    });
});
