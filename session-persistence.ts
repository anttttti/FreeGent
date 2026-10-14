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

// Bounds on what the event log keeps on disk. The in-memory session keeps every event whole; the
// file is an audit log, so a field is cut at maxFieldChars (the event carries `truncated: true`),
// a session file stops growing at maxFileBytes, and old files are pruned at startup.
export interface PersistenceLimits {
    maxFieldChars: number;   // longest string kept in one event field
    maxFileBytes:  number;   // size at which a session file stops taking events
}
function _envInt(name: string, dflt: number): number {
    const n = Number((globalThis as any).process?.env?.[name]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}
export function defaultPersistenceLimits(): PersistenceLimits {
    return {
        maxFieldChars: _envInt('FG_EVENT_LOG_MAX_FIELD_CHARS', 65_536),
        maxFileBytes:  _envInt('FG_EVENT_LOG_MAX_FILE_BYTES', 20 * 1024 * 1024),
    };
}

/** Copy of `value` with every string longer than `max` cut; sets `hit.cut` when anything was. */
function _clipStrings(value: any, max: number, hit: { cut: boolean }): any {
    if (typeof value === 'string') {
        if (value.length <= max) return value;
        hit.cut = true;
        return value.slice(0, max) + `…[${value.length - max} more chars not logged]`;
    }
    if (Array.isArray(value)) return value.map(v => _clipStrings(v, max, hit));
    if (value && typeof value === 'object') {
        const out: any = {};
        for (const k of Object.keys(value)) out[k] = _clipStrings(value[k], max, hit);
        return out;
    }
    return value;
}

export class SessionPersistence {
    private pending  = new Map<string, SessionEvent[]>();
    private timer:   ReturnType<typeof setTimeout> | null = null;
    private active:  Promise<void> | undefined;
    // Explicit fields — avoid TS parameter properties which are unsupported by
    // Node --experimental-strip-types (required for headless/benchmark runs).
    private readonly dir:        string;
    private readonly maxDelayMs: number;
    private readonly limits:     PersistenceLimits;
    // Bytes in each session file (read once, then counted) and the sessions that hit the cap.
    private sizes  = new Map<string, number>();
    private capped = new Set<string>();

    constructor(dir: string, maxDelayMs = 200, limits?: Partial<PersistenceLimits>) {
        this.dir        = dir;
        this.maxDelayMs = maxDelayMs;
        this.limits     = { ...defaultPersistenceLimits(), ...limits };
    }

    /**
     * Delete session files older than maxAgeDays, then the oldest ones until the directory is at
     * most maxTotalBytes. Returns the number removed. Never throws: pruning is housekeeping.
     */
    static async prune(dir: string, opts: { maxAgeDays?: number; maxTotalBytes?: number } = {}): Promise<number> {
        const maxAgeMs  = (opts.maxAgeDays ?? _envInt('FG_EVENT_LOG_MAX_AGE_DAYS', 30)) * 86_400_000;
        const maxTotal  = opts.maxTotalBytes ?? _envInt('FG_EVENT_LOG_MAX_TOTAL_BYTES', 500 * 1024 * 1024);
        let removed = 0;
        try {
            // @ts-ignore — node:protocol imports; no @types/node in browser tsconfig (resolved at runtime)
            const { readdir, stat, unlink } = await import('node:fs/promises') as any;
            // @ts-ignore
            const { join } = await import('node:path') as any;
            const files: { path: string; size: number; mtime: number }[] = [];
            for (const name of await readdir(dir)) {
                if (!name.endsWith('.jsonl')) continue;
                try { const st = await stat(join(dir, name)); if (st.isFile()) files.push({ path: join(dir, name), size: st.size, mtime: st.mtimeMs }); } catch {}
            }
            files.sort((a, b) => a.mtime - b.mtime);                 // oldest first
            let total = files.reduce((n, f) => n + f.size, 0);
            const now = Date.now();
            for (const f of files) {
                if (now - f.mtime <= maxAgeMs && total <= maxTotal) break;
                try { await unlink(f.path); total -= f.size; removed++; } catch {}
            }
        } catch { /* no directory yet, or no filesystem */ }
        return removed;
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

    private _serialize(e: SessionEvent): string {
        const hit = { cut: false };
        const data = _clipStrings((e as any).data, this.limits.maxFieldChars, hit);
        return JSON.stringify(hit.cut ? { ...e, data, truncated: true } : e);
    }

    private async _drain(): Promise<void> {
        if (this.active) { await this.active.catch(() => {}); return; }
        // Take the batch before any async work; events enqueued meanwhile go to the next drain.
        const batch = new Map(this.pending);
        this.pending.clear();

        this.active = (async () => {
            const todo = [...batch];
            try {
                // @ts-ignore — node:protocol imports; no @types/node in browser tsconfig (resolved at runtime)
                const { appendFile, mkdir, stat } = await import('node:fs/promises') as any;
                // @ts-ignore
                const { join }              = await import('node:path') as any;
                await mkdir(this.dir, { recursive: true });
                while (todo.length) {
                    const [id, events] = todo[0];
                    if (events.length) {
                        const path  = join(this.dir, `${id}.jsonl`);
                        if (!this.capped.has(id)) {
                            let size = this.sizes.get(id);
                            if (size === undefined) {
                                try { size = (await stat(path)).size; } catch { size = 0; }
                            }
                            const body  = events.map(e => this._serialize(e)).join('\n') + '\n';
                            const lines = (this.dirty.has(id) ? '\n' : '') + body;
                            const bytes = (globalThis as any).Buffer ? (globalThis as any).Buffer.byteLength(lines) : lines.length;
                            if (size! + bytes > this.limits.maxFileBytes) {
                                this.capped.add(id);
                                console.warn(`[session-persistence] ${id}: event log reached ${this.limits.maxFileBytes} bytes; later events are not written`);
                            } else {
                                this.dirty.add(id);          // until the append is known to have completed
                                await appendFile(path, lines, 'utf8');
                                this.dirty.delete(id);
                                this.sizes.set(id, size! + bytes);
                            }
                        }
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
