// session-persistence.ts — FreeGent: write-behind JSONL for session events.
//
// Architecture mirrors dsh (deepseek-harness):
//   packages/session/session-persistence/src/write-behind.ts — batching + deadline timer
//   packages/session/session-persistence-jsonl/src/index.ts  — JSONL append + load
//
// Simplified for FreeGent's single-machine Node.js headless context:
//   - No zstd compression (overkill at this scale; events are already small JSON lines)
//   - Simple appendFile (atomic link() not needed for single-writer, single-reader)
//   - Dynamic import of fs/path so this file can be bundled for the browser without error
//     (browser sessions live only in memory; initPersistence() is never called there)
//

import type { SessionEvent } from './session-event.js';

export class SessionPersistence {
    private pending  = new Map<string, SessionEvent[]>();
    private timer:   ReturnType<typeof setTimeout> | null = null;
    private active:  Promise<void> | undefined;
    // Explicit fields — avoid TS parameter properties which are unsupported by
    // Node --experimental-strip-types (required for headless/benchmark runs).
    private readonly dir:        string;
    private readonly maxDelayMs: number;

    constructor(dir: string, maxDelayMs = 200) {
        this.dir        = dir;
        this.maxDelayMs = maxDelayMs;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Enqueue one event for write-behind. Called from Session.onAppend — synchronous,
     * never awaited by the hot path. The event is structuredClone'd immediately so
     * the frozen event object is decoupled from the persistence buffer.
     */
    enqueue(sessionId: string, event: SessionEvent): void {
        const q = this.pending.get(sessionId) ?? [];
        try {
            q.push(structuredClone(event));
        } catch {
            // structuredClone not available in all envs (e.g. older Node); fall back to JSON clone.
            q.push(JSON.parse(JSON.stringify(event)) as SessionEvent);
        }
        this.pending.set(sessionId, q);
        if (!this.timer)
            this.timer = setTimeout(() => {
                this.timer = null;
                // A failed background write keeps its events queued; the next enqueue or flush retries.
                this._drain().catch(e => console.warn('[session-persistence] write failed, events kept for retry:', e?.message ?? e));
            }, this.maxDelayMs);
    }

    /**
     * Durability barrier — resolves only after all pending events are written, rejects if a write
     * fails. "Written" means accepted by the filesystem (appendFile resolved); there is no fsync,
     * so a power loss can still drop the last events. Call before process exit or before reading
     * persisted state. Concurrent callers share the same in-flight drain.
     *
     * After a failed write the events stay queued (see _drain), so a later flush() retries them.
     */
    async flush(): Promise<void> {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (this.active) await this.active.catch(() => {});
        // Loop in case enqueue() was called while the drain was running. A failing drain throws
        // out of the loop: the events are still pending, and looping on a full disk would never end.
        while (this.pending.size > 0) await this._drain();
    }

    /** Events queued and not yet written (after a failed write: what a retry will write). */
    pendingCount(): number {
        let n = 0;
        for (const q of this.pending.values()) n += q.length;
        return n;
    }

    /**
     * Load stored events for a session (resume or fork).
     * Returns [] if no file exists or if running in the browser; throws on any other read error
     * (an unreadable file must not look like an empty session that is then appended to).
     *
     * The file is read line by line and the result is the run of events whose seq counts up from
     * 0, which is what Session requires of a seed. Lines that do not fit are skipped and reported:
     *   - a torn line (the process died mid-write, or a failed append left a fragment);
     *   - an event already seen (a batch written again after a failed append);
     *   - an event past a gap (events lost before it).
     */
    async load(sessionId: string): Promise<SessionEvent[]> {
        let text: string;
        try {
            // @ts-ignore — node:protocol imports; no @types/node in browser tsconfig (resolved at runtime)
            const { readFile } = await import('node:fs/promises') as any;
            // @ts-ignore
            const { join }     = await import('node:path') as any;
            text = await readFile(join(this.dir, `${sessionId}.jsonl`), 'utf8');
        } catch (e: any) {
            // No file, or no filesystem at all (browser bundle): an empty session.
            if (e?.code === 'ENOENT' || typeof e?.code !== 'string') return [];
            throw e;
        }
        const events: SessionEvent[] = [];
        let torn = 0, outOfOrder = 0;
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            let ev: any;
            try { ev = JSON.parse(line); } catch { torn++; continue; }
            if (!ev || typeof ev !== 'object' || ev.seq !== events.length) { outOfOrder++; continue; }
            events.push(ev as SessionEvent);
        }
        if (torn || outOfOrder)
            console.warn(`[session-persistence] ${sessionId}: loaded ${events.length} events; skipped ${torn} unreadable line(s) and ${outOfOrder} repeated or out-of-sequence event(s)`);
        return events;
    }

    // ── Private ───────────────────────────────────────────────────────────────

    // Sessions whose last append failed: the file may end in a fragment without a newline, so the
    // next write starts on a fresh line. load() skips the fragment.
    private dirty = new Set<string>();

    private async _drain(): Promise<void> {
        if (this.active) { await this.active.catch(() => {}); return; }
        // Take the batch before any async work; events enqueued meanwhile go to the next drain.
        const batch = new Map(this.pending);
        this.pending.clear();

        this.active = (async () => {
            const todo = [...batch];
            try {
                // @ts-ignore — node:protocol imports; no @types/node in browser tsconfig (resolved at runtime)
                const { appendFile, mkdir } = await import('node:fs/promises') as any;
                // @ts-ignore
                const { join }              = await import('node:path') as any;
                await mkdir(this.dir, { recursive: true });
                while (todo.length) {
                    const [id, events] = todo[0];
                    if (events.length) {
                        const path  = join(this.dir, `${id}.jsonl`);
                        const lines = (this.dirty.has(id) ? '\n' : '') + events.map(e => JSON.stringify(e)).join('\n') + '\n';
                        this.dirty.add(id);          // until the append is known to have completed
                        await appendFile(path, lines, 'utf8');
                        this.dirty.delete(id);
                    }
                    todo.shift();
                }
            } catch (e) {
                // Keep what was not written, ahead of anything enqueued since, so order holds and
                // nothing is dropped. The failed session's batch is written again in full: if part
                // of it reached the file, load() drops the repeats by seq.
                const later = new Map(this.pending);
                this.pending.clear();
                for (const [id, events] of todo) this.pending.set(id, [...events, ...(later.get(id) ?? [])]);
                for (const [id, events] of later) if (!this.pending.has(id)) this.pending.set(id, events);
                throw e;
            }
        })().finally(() => { this.active = undefined; });

        await this.active;
    }
}
