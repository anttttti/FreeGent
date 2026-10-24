// chat-lease.ts — FreeGent: one tab at a time runs a turn in a given chat.
//
// Two browser tabs can have the same chat open. A turn in each used to write the whole chat history when it ended, so the
// tab that finished last replaced the other's messages (the tool effects of both turns stayed in the workspace, the
// history of one was gone). A turn now holds a lease on its chat: a record in localStorage naming the tab, refreshed
// while the turn runs. Another tab that wants to start a turn there is told to wait. A tab that dies mid-turn stops
// refreshing, and its lease runs out.
//
// The key is not under fg_chat_ on purpose: those keys belong to a project and are exported with it.

const KEY = (chatId: string) => `fg_lease_${chatId}`;
export const LEASE_TTL_MS = 20_000;
const BEAT_MS = 5_000;

// This page load's identity, kept apart from every other tab.
const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const held = new Map<string, ReturnType<typeof setInterval>>();
// What this tab holds, and the token of that acquisition. The record names the token, so a heartbeat can tell whether the record is still ITS lease: it used to
// rewrite the record unconditionally, and a tab that had been frozen past the lease time (background, sleep) took the lease back from the tab that had legitimately
// acquired it, and the two kept overwriting each other's record (opencode §7).
const tokens = new Map<string, string>();
const lost = new Set<string>();

function read(chatId: string): { tab: string; token?: string; at: number } | null {
    try { return JSON.parse(localStorage.getItem(KEY(chatId)) || 'null'); } catch { return null; }
}
function stamp(chatId: string): void {
    try { localStorage.setItem(KEY(chatId), JSON.stringify({ tab: TAB_ID, token: tokens.get(chatId), at: Date.now() })); } catch { /* full or blocked: no lease, no protection */ }
}
/** Does the record still name this acquisition? */
function ours(chatId: string): boolean { const cur = read(chatId); return !!cur && cur.tab === TAB_ID && cur.token === tokens.get(chatId); }

function beat(chatId: string): void {
    const cur = read(chatId);
    // Someone else's fresh lease: ours is gone. Say so once; do not write over it.
    if (cur && !(cur.tab === TAB_ID && cur.token === tokens.get(chatId)) && Date.now() - cur.at < LEASE_TTL_MS) {
        if (!lost.has(chatId)) {
            lost.add(chatId);
            try { console.warn(`[lease] the lease on chat ${chatId} was taken by another tab while this one was not running; this tab's turn may not be saved`); } catch {}
            try { window.dispatchEvent(new CustomEvent('fg-lease-lost', { detail: { chatId } })); } catch {}
        }
        return;
    }
    stamp(chatId);
}

/** False once another tab took over a lease this tab held (the turn here is no longer protected). */
export function chatLeaseHeld(chatId: string | null): boolean { return !chatId || !lost.has(chatId); }

/** True when another tab is running a turn in this chat (its lease is fresh). */
export function chatBusyInAnotherTab(chatId: string | null, now = Date.now()): boolean {
    if (!chatId) return false;
    const cur = read(chatId);
    return !!cur && cur.tab !== TAB_ID && now - cur.at < LEASE_TTL_MS;
}

/** Take the lease for a turn about to start. False when another tab holds it; nothing is changed then. */
export function acquireChatLease(chatId: string | null): boolean {
    if (!chatId) return true;
    if (chatBusyInAnotherTab(chatId)) return false;
    if (!held.has(chatId)) tokens.set(chatId, `${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`);
    lost.delete(chatId);
    stamp(chatId);
    // Two tabs that read "free" in the same instant both write; the read-back tells the one whose write did not stand.
    if (!ours(chatId) && read(chatId) && read(chatId)!.tab !== TAB_ID && Date.now() - read(chatId)!.at < LEASE_TTL_MS) { if (!held.has(chatId)) tokens.delete(chatId); return false; }
    if (!held.has(chatId)) held.set(chatId, setInterval(() => beat(chatId), BEAT_MS));
    return true;
}

// A lease left behind by a page that no longer exists (a reload, a crash, a tab the browser discarded: pagehide does not always run) used to keep the
// chat locked for the rest of its 20 seconds: "This chat is running a turn in another browser tab" with no other tab open. Every page answers a ping for
// the chats it really holds; a record nobody answers for is stale and is taken over at once. Only where BroadcastChannel exists; elsewhere the TTL stays the rule.
const CHANNEL = 'fg-chat-lease';
export const LEASE_PING_WAIT_MS = 250;
let channel: BroadcastChannel | null = null;
function bus(): BroadcastChannel | null {
    if (channel) return channel;
    try {
        if (typeof BroadcastChannel === 'undefined') return null;
        channel = new BroadcastChannel(CHANNEL);
        channel.onmessage = (ev: MessageEvent) => {
            const m = ev.data;
            // Answer only for a lease this page holds, and only to a ping that names the page it is addressed to.
            if (m?.type === 'ping' && m.chatId && held.has(m.chatId) && ours(m.chatId)) channel!.postMessage({ type: 'pong', chatId: m.chatId, nonce: m.nonce });
        };
    } catch { channel = null; }
    return channel;
}
bus();   // listen from page load: a page that holds a lease must be able to answer from its first turn on

/**
 * The lease on this chat is held by another tab's record: is that tab still there? Asks over BroadcastChannel and waits `LEASE_PING_WAIT_MS`.
 * Resolves true when a holder answered (or when the question cannot be asked: assume it is there), false when nobody did; in that case the
 * stale record has been removed and `acquireChatLease` will succeed.
 */
export async function chatLeaseHolderAlive(chatId: string | null): Promise<boolean> {
    if (!chatId || !chatBusyInAnotherTab(chatId)) return false;
    const ch = bus();
    if (!ch) return true;
    const nonce = `${TAB_ID}:${Math.random().toString(36).slice(2)}`;
    const answered = await new Promise<boolean>(resolve => {
        const probe = new BroadcastChannel(CHANNEL);   // a channel does not receive its own messages: ask on one, listen on another
        const done = (v: boolean) => { clearTimeout(timer); try { probe.close(); } catch {} resolve(v); };
        probe.onmessage = (ev: MessageEvent) => { if (ev.data?.type === 'pong' && ev.data.chatId === chatId && ev.data.nonce === nonce) done(true); };
        const timer = setTimeout(() => done(false), LEASE_PING_WAIT_MS);
        try { probe.postMessage({ type: 'ping', chatId, nonce }); } catch { done(true); }
    });
    if (answered) return true;
    // Nobody holds it: remove the record, unless it was refreshed or replaced while we waited.
    const cur = read(chatId);
    if (cur && cur.tab !== TAB_ID && Date.now() - cur.at >= 0) { try { localStorage.removeItem(KEY(chatId)); } catch {} }
    return false;
}

/** Give the lease back when the turn is over (also fine to call without holding it). */
export function releaseChatLease(chatId: string | null): void {
    if (!chatId) return;
    const t = held.get(chatId);
    if (t) { clearInterval(t); held.delete(chatId); }
    // Only a record that is still ours is removed: another tab's lease is not ours to delete.
    if (ours(chatId)) { try { localStorage.removeItem(KEY(chatId)); } catch {} }
    tokens.delete(chatId); lost.delete(chatId);
}

if (typeof window !== 'undefined') {
    // A closing tab hands its leases back at once instead of leaving them to run out.
    window.addEventListener('pagehide', () => { for (const id of [...held.keys()]) releaseChatLease(id); });
    Object.assign(window, { acquireChatLease, releaseChatLease, chatBusyInAnotherTab, chatLeaseHeld, chatLeaseHolderAlive });
}
