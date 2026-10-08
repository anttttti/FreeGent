// history-helpers.ts — test helpers for an AgentSession's history, which lives in its event log.
import { registry } from '../session-registry.ts';
import { seedSessionFromHistory } from '../chat-history.ts';

/** Add a message to the session's history (creating its event log on first use). */
export function pushHistory(s: any, ...msgs: any[]): void {
    if (!s._session) s._session = registry.create({ chatId: 't' });
    seedSessionFromHistory(s._session, msgs);
}

/** The session's history as the model sees it. */
export function historyOf(s: any): any[] {
    return s._session?.deriveMessages() ?? [];
}
