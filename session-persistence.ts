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
            this.timer = setTimeout(() => { this.timer = null; void this._drain(); }, this.maxDelayMs);
    }

    /**
     * Durability barrier — resolves only after all pending events are flushed to disk.
     * Call before process exit or before reading persisted state.
     * Concurrent callers share the same in-flight drain.
     */
    async flush(): Promise<void> {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (this.active) await this.active;
        // Loop in case enqueue() was called while the drain was running.
        while (this.pending.size > 0) await this._drain();
    }

    /**
     * Load stored events for a session (resume or fork).
     * Returns [] if no file exists or if running in the browser.
     */
    async load(sessionId: string): Promise<SessionEvent[]> {
        try {
            // @ts-ignore — node:protocol imports; no @types/node in browser tsconfig (resolved at runtime)
            const { readFile } = await import('node:fs/promises') as any;
            // @ts-ignore
            const { join }     = await import('node:path') as any;
            const path = join(this.dir, `${sessionId}.jsonl`);
            const text = await readFile(path, 'utf8');
            return text
                .trim()
                .split('\n')
                .filter(Boolean)
                .map(l => JSON.parse(l) as SessionEvent);
        } catch {
            return [];
        }
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private async _drain(): Promise<void> {
        if (this.active) { await this.active; return; }
        // Snapshot and clear the pending map atomically before any async work.
        const batch = new Map(this.pending);
        this.pending.clear();

        this.active = (async () => {
            // @ts-ignore — node:protocol imports; no @types/node in browser tsconfig (resolved at runtime)
            const { appendFile, mkdir } = await import('node:fs/promises') as any;
            // @ts-ignore
            const { join }              = await import('node:path') as any;
            await mkdir(this.dir, { recursive: true });
            for (const [id, events] of batch) {
                if (!events.length) continue;
                const path  = join(this.dir, `${id}.jsonl`);
                const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
                await appendFile(path, lines, 'utf8');
            }
        })().finally(() => { this.active = undefined; });

        await this.active;
    }
}
