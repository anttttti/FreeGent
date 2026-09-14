// session-registry.ts — FreeGent: process-level session registry.
//
// Manages the mapping from session ID to live Session instance.
// Wires write-behind persistence to each session's onAppend hook.
//
// Usage:
//   import { registry } from './session-registry.ts';
//
//   // Headless startup (once):
//   import { initPersistence } from './session-registry.ts';
//   initPersistence(path.join(logDir, 'events'));
//
//   // Create / activate sessions:
//   const s = registry.create({ chatId });
//   registry.setActive(s);
//
//   // Worker sessions:
//   const ws = registry.create({ chatId, id: `worker-${workerId}` });
//   _agentSession._session = ws;
//
//   // Before exit:
//   await registry.flush();
//

import { Session } from './session.js';
import type { SessionEvent } from './session-event.js';
import { SessionPersistence } from './session-persistence.js';

// ── ID generation ──────────────────────────────────────────────────────────────
let _nextId = 0;
function _newId(): string { return `fg-${Date.now()}-${++_nextId}`; }

// ── Registry ──────────────────────────────────────────────────────────────────

export class SessionRegistry {
    private _sessions    = new Map<string, Session>();
    private _active:     Session | null = null;
    private _persistence: SessionPersistence | null = null;

    // ── Persistence ───────────────────────────────────────────────────────────

    /** Configure write-behind persistence. Call once at headless startup. */
    setPersistence(p: SessionPersistence): void {
        this._persistence = p;
    }

    // ── Session lifecycle ─────────────────────────────────────────────────────

    /**
     * Create a new session and register it.
     * If persistence is configured, wires onAppend immediately.
     * If seed events are provided (for resume / fork), they are replayed first;
     * then the write-behind hook is installed and all seed events are re-enqueued.
     */
    create(opts: {
        id?:    string;
        chatId: string;
        seed?:  readonly SessionEvent[];
    }): Session {
        const id = opts.id ?? _newId();
        const s  = new Session({ id, chatId: opts.chatId, seed: opts.seed });

        if (this._persistence) {
            const p = this._persistence;
            // Wire the hook first so future appends are captured automatically.
            s.onAppend = (ev) => p.enqueue(id, ev);
            // Re-enqueue all events already in the log (seed + end-seed marker).
            // The persistence backend uses appendFile, so duplicates would corrupt
            // on-disk state — only do this for fresh sessions with seed, not for
            // sessions loaded via resume() where the file already has the events.
            if (opts.seed?.length) {
                for (const ev of s.events) p.enqueue(id, ev);
            }
        }

        this._sessions.set(id, s);
        return s;
    }

    /** Set the currently-active session (the main agent's session for this run). */
    setActive(s: Session): void { this._active = s; }

    /** Get the currently-active session. Null in the browser when no run is live. */
    active(): Session | null { return this._active; }

    /** Look up a session by ID. */
    get(id: string): Session | undefined { return this._sessions.get(id); }

    /**
     * Remove a session from the registry.
     * Call after a worker session completes so the Map doesn't grow unboundedly.
     * Does not affect the on-disk JSONL file.
     */
    remove(id: string): void { this._sessions.delete(id); }

    // ── Fork / resume ─────────────────────────────────────────────────────────

    /**
     * Fork an existing session at a turn boundary.
     * Returns a newly registered Session whose firstLiveSeq starts after boundary.
     */
    fork(source: Session, boundary?: number): Session {
        const forked = source.fork(_newId(), boundary);
        this._sessions.set(forked.id, forked);
        if (this._persistence) {
            const p = this._persistence;
            forked.onAppend = (ev) => p.enqueue(forked.id, ev);
        }
        return forked;
    }

    /**
     * Resume a previously-persisted session.
     * Requires persistence to be configured. The on-disk events are loaded as seed,
     * but the file is NOT re-written (onAppend will append new events only).
     */
    async resume(sessionId: string): Promise<Session> {
        if (!this._persistence)
            throw new Error('SessionRegistry.resume: no persistence configured');
        const seed   = await this._persistence.load(sessionId);
        const chatId = (seed.find(e => e.type === 'turn/start') as any)?.data?.chatId ?? sessionId;
        // Create without re-enqueuing seed (file already has them).
        const s = new Session({ id: sessionId, chatId, seed });
        const p = this._persistence;
        s.onAppend = (ev) => p.enqueue(sessionId, ev);
        this._sessions.set(sessionId, s);
        return s;
    }

    // ── Durability ────────────────────────────────────────────────────────────

    /** Flush all pending write-behind events to disk. Call before process exit. */
    flush(): Promise<void> {
        return this._persistence?.flush() ?? Promise.resolve();
    }
}

// ── Process-level singleton ───────────────────────────────────────────────────

/**
 * Single shared registry instance. Import and use directly:
 *   import { registry } from './session-registry.ts';
 *
 * In the browser: no persistence; sessions accumulate in memory (useful for
 * debugging and future replay UI).
 * In headless (Node.js) benchmarks: call initPersistence() at startup.
 */
export const registry = new SessionRegistry();

/**
 * Configure the global registry with write-behind JSONL persistence.
 * Call once at headless startup before creating any sessions.
 *
 * @param dir        Directory where per-session JSONL files are written.
 *                   Created automatically if it doesn't exist.
 * @param maxDelayMs Maximum batching delay in ms (default 200).
 */
export function initPersistence(dir: string, maxDelayMs?: number): SessionPersistence {
    const p = new SessionPersistence(dir, maxDelayMs);
    registry.setPersistence(p);
    return p;
}
