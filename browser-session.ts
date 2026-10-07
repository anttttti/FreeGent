// browser-session.ts — FreeGent: runs a browser turn on a Session event log (task 071).
//
// The browser's history is the legacy `openaiHistory` array: it is what saveHistory persists, what
// rewind/retry/import/export and the context meter read. Headless runs use a Session instead, whose
// event log the main loop already supports (native tool format). This bridge gives a browser turn
// that Session without touching any of those readers:
//
//   open   — seed a Session from the array, make it the active one, so the loop takes its native
//            path and writes only to the event log;
//   mirror — every surface event the loop appends is copied into the live `openaiHistory` array
//            (appends one message; a replace — compaction, pruning, tombstone — rebuilds in place),
//            so the array is always current, also if the tab dies mid-turn;
//   close  — detach. The array already holds the turn; nothing is written back (the caller's error
//            path may pop the user message and must not be undone).
//
// The Session lives for one turn: between turns the array is the source of truth, as before.
// Off by default (fg_session_history); fn-tag models keep the legacy path (see canUseSession).
import { Session, eventMessage } from './session.js';
import { SURFACE_TYPES, type SessionEvent } from './session-event.js';
import { registry } from './session-registry.js';
import { openaiHistory } from './state.js';

const clone = <T,>(m: T): T => JSON.parse(JSON.stringify(m));

/**
 * Replay a legacy history array into a fresh Session. System-role entries (injected nudges) become
 * user turns wrapped in <nudge>, as the loop and callOAI already map them; entries a Session cannot
 * hold (null, unknown roles) are skipped. Tool results keep their call id.
 */
export function seedSessionFromHistory(sess: Session, history: any[]): void {
    let step = 0;
    for (const m of history) {
        if (!m || typeof m !== 'object') continue;
        if (m.role === 'user') {
            sess.append('user/message', clone(m), { surfaceOp: 'append' } as any);
        } else if (m.role === 'system') {
            sess.append('user/message', { role: 'user', content: `<nudge>${m.content ?? ''}</nudge>` }, { surfaceOp: 'append' } as any);
        } else if (m.role === 'assistant') {
            sess.append('assistant/message', { turn: 0, step: step++, message: clone(m) }, { surfaceOp: 'append' } as any);
        } else if (m.role === 'tool') {
            sess.append('tool/result', {
                turn: 0, step: Math.max(0, step - 1), callId: m.tool_call_id, name: m.name ?? '',
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
            }, { surfaceOp: 'append' } as any);
        }
    }
}

/** Copy one surface event into the live history array. */
function mirror(sess: Session, ev: SessionEvent): void {
    if (!SURFACE_TYPES.has(ev.type)) return;
    const target = openaiHistory;                      // live binding: callers may replace the array
    const op = (ev as any).surfaceOp;
    if (!op || op === 'append') {
        const m = eventMessage(ev);
        if (m) target.push(clone(m));
        return;
    }
    target.splice(0, target.length, ...sess.deriveMessages().map(clone));   // replace: rebuild in place
}

export interface BrowserSession { session: Session; close(): void }

/** Open a Session for this turn, seeded from the current array. Call after the user message is in it. */
export function openBrowserSession(chatId: string): BrowserSession {
    const session = registry.create({ chatId });
    seedSessionFromHistory(session, openaiHistory);
    openaiHistory.splice(0, openaiHistory.length, ...session.deriveMessages().map(clone));   // normalise to the projection
    session.onAppend = ev => { try { mirror(session, ev); } catch (e) { console.warn('[browser-session] mirror failed:', e); } };
    const previous = registry.active();
    registry.setActive(session);
    return {
        session,
        close() {
            session.onAppend = null;
            if (registry.active() === session) registry.setActive(previous);
            try { registry.remove(session.id); } catch {}
        },
    };
}

/** fn-tag models fold tool results into user messages, which the event projection does not model. */
export function canUseSession(toolFormat: string): boolean { return toolFormat !== 'fn-tag'; }
