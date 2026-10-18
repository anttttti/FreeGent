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

function read(chatId: string): { tab: string; at: number } | null {
    try { return JSON.parse(localStorage.getItem(KEY(chatId)) || 'null'); } catch { return null; }
}
function stamp(chatId: string): void {
    try { localStorage.setItem(KEY(chatId), JSON.stringify({ tab: TAB_ID, at: Date.now() })); } catch { /* full or blocked: no lease, no protection */ }
}

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
    stamp(chatId);
    if (!held.has(chatId)) held.set(chatId, setInterval(() => stamp(chatId), BEAT_MS));
    return true;
}

/** Give the lease back when the turn is over (also fine to call without holding it). */
export function releaseChatLease(chatId: string | null): void {
    if (!chatId) return;
    const t = held.get(chatId);
    if (t) { clearInterval(t); held.delete(chatId); }
    const cur = read(chatId);
    if (cur?.tab === TAB_ID) { try { localStorage.removeItem(KEY(chatId)); } catch {} }
}

if (typeof window !== 'undefined') {
    // A closing tab hands its leases back at once instead of leaving them to run out.
    window.addEventListener('pagehide', () => { for (const id of [...held.keys()]) releaseChatLease(id); });
    Object.assign(window, { acquireChatLease, releaseChatLease, chatBusyInAnotherTab });
}
