// tui-input-history.ts — ↑/↓ in the composer go back through the messages of the open chat, as a shell's history does.
//
// What is in the list: the chat's own user messages (so a resumed chat has its past) and what was submitted since, slash commands
// included. Oldest first; the position shown is n/total, the newest being total/total. Browsing starts with ↑ (the text being
// typed is kept as the draft), ↓ past the newest gives the draft back, and editing a recalled message ends the browsing.
import { stripInjected } from './history-util.js';
import { isGoalPrompt } from './goal.js';

export interface Browse { index: number; draft: string }

// Messages the harness itself puts in a chat's history with the role "user": nudges, text-mode tool results, the compaction summary and its
// notes, the task pin, and the turns the /goal loop sends. No one typed them, so ↑/↓ must not offer them.
const SYNTHETIC_PREFIXES = ['<nudge>', '<tool_response>', '[SYSTEM', '[Files read before compaction', 'No results from "ls"', '~~~guidance'];
const TASK_PIN = '[TASK — do not lose track of this]\n';   // llm-shared.ts: the first message, re-stated after a compaction (it IS the user's)

/** The text of a typed user message, or null when the message is one the harness wrote. */
export function typedText(m: any): string | null {
    if (m?.role !== 'user') return null;
    const raw = typeof m.content === 'string' ? m.content
        : Array.isArray(m.content) ? m.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n') : '';
    let text = String(stripInjected(raw) ?? raw).trim();
    if (text.startsWith(TASK_PIN)) text = text.slice(TASK_PIN.length).trim();
    if (!text || SYNTHETIC_PREFIXES.some(p => text.startsWith(p)) || isGoalPrompt(text)) return null;
    return text;
}

/** The user's own messages in a chat history, oldest first, without consecutive repeats. */
export function userMessages(history: readonly any[] | null | undefined): string[] {
    const out: string[] = [];
    for (const m of history ?? []) {
        const text = typedText(m);
        if (text !== null && out[out.length - 1] !== text) out.push(text);
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
