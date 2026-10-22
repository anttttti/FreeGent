// tui-input-history.ts — ↑/↓ in the composer go back through the messages of the open chat, as a shell's history does.
//
// What is in the list: the chat's own user messages (so a resumed chat has its past) and what was submitted since, slash commands
// included. Oldest first; the position shown is n/total, the newest being total/total. Browsing starts with ↑ (the text being
// typed is kept as the draft), ↓ past the newest gives the draft back, and editing a recalled message ends the browsing.
import { stripInjected } from './history-util.js';

export interface Browse { index: number; draft: string }

/** The user's messages in a chat history, oldest first, without the text the harness injected and without consecutive repeats. */
export function userMessages(history: readonly any[] | null | undefined): string[] {
    const out: string[] = [];
    for (const m of history ?? []) {
        if (m?.role !== 'user') continue;
        const raw = typeof m.content === 'string' ? m.content
            : Array.isArray(m.content) ? m.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n') : '';
        const text = String(stripInjected(raw) ?? raw).trim();
        if (!text || text.startsWith('<nudge>')) continue;
        if (out[out.length - 1] !== text) out.push(text);
    }
    return out;
}

/** Adds a submitted line to a chat's list, unless it repeats the last one. */
export function record(list: string[], text: string): void {
    const t = text.trim();
    if (t && list[list.length - 1] !== t) list.push(t);
}

/**
 * One ↑ ('older') or ↓ ('newer') press. Returns the new browsing state and the text for the box, or null when the key does nothing
 * (nothing to recall; ↓ while not browsing).
 */
export function step(browse: Browse | null, dir: 'older' | 'newer', entries: readonly string[], current: string): { browse: Browse | null; text: string } | null {
    if (dir === 'older') {
        if (!entries.length) return null;
        if (!browse) return { browse: { index: entries.length - 1, draft: current }, text: entries[entries.length - 1] };
        const index = Math.min(Math.max(0, browse.index), entries.length - 1);
        const next = Math.max(0, index - 1);
        return { browse: { index: next, draft: browse.draft }, text: entries[next] };
    }
    if (!browse) return null;
    if (browse.index >= entries.length - 1) return { browse: null, text: browse.draft };
    return { browse: { index: browse.index + 1, draft: browse.draft }, text: entries[browse.index + 1] };
}

/** "3/12" for the composer's header while browsing. */
export function position(browse: Browse | null, total: number): string {
    return browse ? `${Math.min(browse.index, total - 1) + 1}/${total}` : '';
}
