// chat-history.ts — FreeGent: the active chat's model-facing history, held as a Session event log.
//
// There is no mutable message array any more. The chat's history is the surface of one Session
// (session.ts); the loop appends events to it and every reader gets a projection of it:
//
//   getChatHistory()  — the OAI-format message list (a fresh array of frozen messages);
//   setChatHistory()  — replace the whole history (switch chat, load, import, rewind, retry,
//                       manual compaction): a new Session is seeded from the given messages;
//   appendChatMessage — add one user/nudge message.
//
// The persisted and exported format is still the plain message array (what getChatHistory returns
// and setChatHistory accepts), so saved chats and exported files load unchanged.
import { Session, eventMessage } from './session.js';
import { registry } from './session-registry.js';
import { activeChatId } from './state.js';

const clone = <T,>(m: T): T => JSON.parse(JSON.stringify(m));

/**
 * Replay a message array into a Session. System-role entries (injected nudges) become user turns
 * wrapped in <nudge>, as the loop and callOAI already map them; entries a Session cannot hold
 * (null, unknown roles) are skipped. Tool results keep their call id.
 */
export function seedSessionFromHistory(sess: Session, history: readonly any[]): void {
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

let _chat: Session | null = null;

function _open(chatId: string, history: readonly any[]): Session {
    const sess = registry.create({ chatId });
    seedSessionFromHistory(sess, history);
    return sess;
}

/** The active chat's Session. Created empty on first use. */
export function chatSession(): Session {
    if (!_chat) {
        _chat = _open(activeChatId ?? 'anon', []);
        registry.setActive(_chat);
    }
    return _chat;
}

/** The chat's messages in OAI format. A fresh array each call; mutating it changes nothing. */
export function getChatHistory(): any[] {
    return _chat ? _chat.deriveMessages() : [];
}

/** Number of messages in the chat's history. */
export function chatHistoryLength(): number {
    return getChatHistory().length;
}

/** Replace the chat's history with `messages` (a new Session, so the old log is dropped). */
export function setChatHistory(messages: readonly any[] | null | undefined): void {
    const old = _chat;
    const wasActive = !!old && registry.active() === old;
    _chat = _open(activeChatId ?? old?.chatId ?? 'anon', Array.isArray(messages) ? messages : []);
    if (old) { try { registry.remove(old.id); } catch {} }
    if (wasActive || !old) registry.setActive(_chat);
}

/** Forget the chat's history. */
export function clearChatHistory(): void { setChatHistory([]); }

/** Append one message (user, or a system-role nudge that becomes a <nudge> user turn) to the chat. */
export function appendChatMessage(m: { role: string; content: any; [k: string]: any }): void {
    const sess = chatSession();
    if (m.role === 'system') {
        sess.append('user/message', { role: 'user', content: `<nudge>${m.content ?? ''}</nudge>` }, { surfaceOp: 'append' } as any);
    } else {
        sess.append('user/message', clone(m) as any, { surfaceOp: 'append' } as any);
    }
}

/**
 * Roll back a failed turn: if the newest surface event of `sess` is a user message, tombstone it
 * (an empty replacement the projection skips) so a retry does not see two user turns in a row.
 */
export function dropTrailingUserMessage(sess: Session = chatSession()): boolean {
    const seq = sess.surface[sess.surface.length - 1];
    if (seq === undefined || sess.events[seq]?.type !== 'user/message' || eventMessage(sess.events[seq]) == null) return false;
    sess.append('user/message', { role: 'user', content: null } as any,
        { surfaceOp: { op: 'replace', start: seq, end: seq } } as any);
    return true;
}
