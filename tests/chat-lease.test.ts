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

describe('opencode §7: a resumed tab does not take back a lease another tab acquired', () => {
    it('the heartbeat leaves a fresh lease of another tab alone, says the lease was lost once, and release does not delete it', async () => {
        vi.useFakeTimers();
        try {
            const { chatLeaseHeld } = await import('../chat-lease.js');
            const events: string[] = [];
            window.addEventListener('fg-lease-lost', (e: any) => events.push(e.detail.chatId));
            expect(acquireChatLease('c9')).toBe(true);
            // this tab is frozen; its lease runs out and another tab takes the chat
            vi.setSystemTime(Date.now() + LEASE_TTL_MS + 1000);
            localStorage.setItem('fg_lease_c9', JSON.stringify({ tab: 'other-tab', token: 'theirs', at: Date.now() }));
            vi.advanceTimersByTime(12_000);                                         // this tab's heartbeats resume
            const rec = JSON.parse(localStorage.getItem('fg_lease_c9')!);
            expect(rec.tab).toBe('other-tab');                                      // not overwritten
            expect(chatLeaseHeld('c9')).toBe(false);
            expect(events).toEqual(['c9']);                                         // announced once, not at every beat
            releaseChatLease('c9');
            expect(JSON.parse(localStorage.getItem('fg_lease_c9')!).tab).toBe('other-tab');   // still theirs
        } finally { vi.useRealTimers(); }
    });
    it('a lease nobody took over keeps being refreshed', () => {
        vi.useFakeTimers();
        try {
            expect(acquireChatLease('c8')).toBe(true);
            const first = JSON.parse(localStorage.getItem('fg_lease_c8')!).at;
            vi.advanceTimersByTime(6000);
            expect(JSON.parse(localStorage.getItem('fg_lease_c8')!).at).toBeGreaterThan(first);
            releaseChatLease('c8');
        } finally { vi.useRealTimers(); }
    });
});
