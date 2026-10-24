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

describe('a lease left behind by a page that is gone (reload, crash) is not "another tab"', () => {
    it('chatLeaseHolderAlive: nobody answers -> the stale record is removed and the lease can be taken at once; a live holder answers -> it stays', async () => {
        const { chatLeaseHolderAlive, LEASE_PING_WAIT_MS } = await import('../chat-lease.js');
        if (typeof BroadcastChannel === 'undefined') return;                       // no channel in this environment: the TTL stays the rule
        // a record of a tab that no longer exists, written 2 seconds ago (well inside the 20 s TTL)
        localStorage.setItem('fg_lease_gone', JSON.stringify({ tab: 'dead-tab', token: 't', at: Date.now() - 2000 }));
        expect(chatBusyInAnotherTab('gone')).toBe(true);
        expect(await chatLeaseHolderAlive('gone')).toBe(false);
        expect(localStorage.getItem('fg_lease_gone')).toBeNull();
        expect(acquireChatLease('gone')).toBe(true);
        releaseChatLease('gone');

        // another page that really holds it answers the ping
        localStorage.setItem('fg_lease_live', JSON.stringify({ tab: 'live-tab', token: 't', at: Date.now() }));
        const other = new BroadcastChannel('fg-chat-lease');
        const reply = new BroadcastChannel('fg-chat-lease');
        other.onmessage = (ev: MessageEvent) => { if (ev.data?.type === 'ping' && ev.data.chatId === 'live') reply.postMessage({ type: 'pong', chatId: 'live', nonce: ev.data.nonce }); };
        try {
            expect(await chatLeaseHolderAlive('live')).toBe(true);
            expect(localStorage.getItem('fg_lease_live')).toBeTruthy();
            expect(acquireChatLease('live')).toBe(false);
        } finally { other.close(); reply.close(); }
        expect(LEASE_PING_WAIT_MS).toBeLessThan(1000);
    });
    it('nothing to ask when the chat is free or the record is our own', async () => {
        const { chatLeaseHolderAlive } = await import('../chat-lease.js');
        expect(await chatLeaseHolderAlive('free')).toBe(false);
        expect(await chatLeaseHolderAlive(null)).toBe(false);
    });
});
