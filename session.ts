// session.ts — FreeGent: append-only session event log with surface projection.
//
// Architecture mirrors dsh (deepseek-harness):
//   packages/core/session/src/index.ts  — Session class, append(), deriveMessages()
//   packages/core/session/src/surface.ts — surface mechanics, replace ops
//
// Invariants enforced at append() time:
//   - data is JSON-serializable (snapshotJson throws if not)
//   - surface events carry surfaceOp; non-surface events may not
//   - replace-op cites valid on-surface positions
//   - committed events are deep-frozen; no caller can mutate after commit
//

import type {
    SessionEventMap, SessionEvent, SessionEventType,
    SurfaceEventType, SurfaceOp, SurfaceIntent, TurnEndReason,
} from './session-event.js';
import { SURFACE_TYPES } from './session-event.js';

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * One JSON round-trip: validates serializability and returns a detached clone.
 * Throws synchronously if the value contains a non-serializable field — the error
 * surfaces at the append() call site, never silently at flush time.
 */
function snapshotJson<T>(value: T): T {
    const str = JSON.stringify(value);
    if (str === undefined) throw new TypeError('session.append: data is not JSON-serializable');
    return JSON.parse(str) as T;
}

/**
 * Iterative deep-freeze. Uses a visited Set to handle object graphs with
 * shared references without infinite loops.
 */
function deepFreeze<T extends object>(obj: T): T {
    const seen = new Set<object>();
    const queue: object[] = [obj];
    while (queue.length) {
        const cur = queue.pop()!;
        if (seen.has(cur)) continue;
        seen.add(cur);
        Object.freeze(cur);
        for (const v of Object.values(cur))
            if (v && typeof v === 'object' && !Object.isFrozen(v)) queue.push(v);
    }
    return obj;
}

// ── Session ───────────────────────────────────────────────────────────────────

export class Session {
    private _log: SessionEvent[]   = [];
    // Ordered surface: seq numbers of model-visible events, in history order.
    private _surface: number[]     = [];

    readonly id:           string;
    readonly chatId:       string;
    readonly createdAt:    number;
    /**
     * First seq that belongs to this live session.
     * 0 for fresh sessions; > 0 after fork() or resume() — seed events live
     * at seqs [0, firstLiveSeq) and the live append window begins at firstLiveSeq.
     */
    readonly firstLiveSeq: number;

    /**
     * Called synchronously after every committed append, before returning to the caller.
     * Wire this to SessionPersistence.enqueue() for write-behind JSONL.
     * Null in browser context (no filesystem); set by SessionRegistry in headless context.
     */
    onAppend: ((event: SessionEvent) => void) | null = null;

    constructor(opts: {
        id: string;
        chatId: string;
        /** Pre-existing events to replay as seed (for fork / resume). */
        seed?: readonly SessionEvent[];
    }) {
        this.id       = opts.id;
        this.chatId   = opts.chatId;
        this.createdAt = Date.now();

        if (opts.seed?.length) {
            for (const [i, ev] of opts.seed.entries()) {
                const snap = snapshotJson(ev);
                if (snap.seq !== i)
                    throw new Error(`Session seed seq mismatch: index ${i}, got seq ${snap.seq}`);
                this._applySurface(snap);
                this._log.push(deepFreeze(snap));
            }
            // Append end-seed marker if the seed doesn't already end with one.
            if (this._log.at(-1)?.type !== 'session/end-seed')
                this._rawAppend('session/end-seed', {});
        }

        this.firstLiveSeq = this._log.length;
    }

    // ── Read access ───────────────────────────────────────────────────────────

    /** Read-only view of the full append-only log. */
    get events(): readonly SessionEvent[] {
        return this._log as readonly SessionEvent[];
    }

    /** The next seq that will be assigned on the next append. */
    get seq(): number { return this._log.length; }

    /** Read-only ordered surface (seq numbers of model-visible events). */
    get surface(): readonly number[] { return this._surface; }

    // ── Append ────────────────────────────────────────────────────────────────

    /**
     * The single entry point for all event writes.
     *
     * Steps:
     *  1. JSON-snapshot data — validates serializability, detaches from caller
     *  2. Validate surface metadata — surfaceOp required for surface events
     *  3. Validate replace-op positions against current surface
     *  4. Deep-freeze the event object
     *  5. Apply to surface (append or splice)
     *  6. Push to log
     *  7. Call onAppend() for write-behind
     */
    append<T extends SessionEventType>(
        type:           T,
        data:           SessionEventMap[T],
        surfaceIntent?: T extends SurfaceEventType ? SurfaceIntent : never,
    ): SessionEvent<T> {
        const dataSnap = snapshotJson(data);

        if (SURFACE_TYPES.has(type)) {
            if (!surfaceIntent?.surfaceOp)
                throw new Error(`session.append: surface event "${type}" requires surfaceOp`);
            this._validateSurfaceIntent(surfaceIntent);
        } else if (surfaceIntent) {
            throw new Error(`session.append: non-surface event "${type}" may not carry surfaceOp`);
        }

        const event = deepFreeze({
            type,
            seq:  this._log.length,
            time: Date.now(),
            data: dataSnap,
            ...(surfaceIntent ?? {}),
        } as unknown as SessionEvent<T>);

        this._applySurface(event as SessionEvent);
        this._log.push(event as SessionEvent);
        this.onAppend?.(event as SessionEvent);
        return event;
    }

    // ── Projection ────────────────────────────────────────────────────────────

    /**
     * Project the surface to an OAI-format message array.
     *
     * This is the single projection rule — the only function that produces LLM history.
     * Returns the canonical message sequence — the sole source of truth for native sessions; replaces openaiHistory for all reads.
     *
     * The returned array is a fresh snapshot each call. The Message objects are the
     * deep-frozen data from the log — callers cannot mutate history.
     */
    deriveMessages(): Array<{
        role: string;
        content: unknown;
        tool_call_id?: string;
        tool_calls?: unknown[];
        name?: string;
    }> {
        const out: any[] = [];
        for (const seq of this._surface) {
            const ev = this._log[seq]!;
            switch (ev.type) {
                case 'user/message': {
                    const _ud = ev.data as any;
                    // Skip tombstones: empty-content events created by spliceFromSecondLast surface
                    // replace ops (and other surgery) — they mark removed messages, not real ones.
                    if (_ud.content === '' || _ud.content === null || _ud.content === undefined) break;
                    out.push(_ud);
                    break;
                }
                case 'assistant/message': {
                    const m = (ev.data as any).message;
                    // Skip bare usage-only messages (content null, no tool_calls).
                    if (m.content !== null || m.tool_calls?.length) out.push(m);
                    break;
                }
                case 'tool/result': {
                    const d = ev.data as any;
                    out.push({ role: 'tool', tool_call_id: d.callId, name: d.name, content: d.content });
                    break;
                }
            }
        }
        return out;
    }

    // ── Fork ──────────────────────────────────────────────────────────────────

    /**
     * Create a child session by slicing the log at a turn boundary.
     * `boundary` is the seq of the last event to include in the seed;
     * defaults to the last event in the log.
     * The boundary must not fall inside an open turn (i.e., the last
     * turn/start or turn/end before boundary must be turn/end).
     */
    fork(newId: string, boundary?: number): Session {
        const b     = boundary ?? this._log.length - 1;
        const slice = this._log.slice(0, b + 1);
        const last  = [...slice].reverse().find(
            e => e.type === 'turn/start' || e.type === 'turn/end'
        );
        if (last?.type === 'turn/start')
            throw new Error(`Session.fork: boundary seq ${b} is inside an open turn`);
        return new Session({ id: newId, chatId: this.chatId, seed: slice });
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /** Internal append that bypasses the surfaceIntent validation — used for structural events. */
    private _rawAppend<T extends SessionEventType>(type: T, data: SessionEventMap[T]): void {
        const event = deepFreeze({
            type,
            seq:  this._log.length,
            time: Date.now(),
            data: snapshotJson(data),
        } as unknown as SessionEvent<T>);
        this._log.push(event as SessionEvent);
        this.onAppend?.(event as SessionEvent);
    }

    private _applySurface(event: SessionEvent): void {
        if (!SURFACE_TYPES.has(event.type)) return;
        const op = (event as any).surfaceOp as SurfaceOp | undefined;
        if (!op || op === 'append') {
            this._surface.push(event.seq);
            return;
        }
        const { start, end } = op as { op: 'replace'; start: number; end: number };
        const si = this._surface.indexOf(start);
        const ei = this._surface.indexOf(end);
        if (si === -1 || ei === -1 || si > ei)
            throw new Error(
                `Session._applySurface: invalid replace start=${start} end=${end} ` +
                `surface=[${this._surface.slice(0, 8).join(',')}${this._surface.length > 8 ? '…' : ''}]`
            );
        this._surface.splice(si, ei - si + 1, event.seq);
    }

    private _validateSurfaceIntent(intent: SurfaceIntent): void {
        if (intent.surfaceOp === 'append') return;
        const { start, end } = intent.surfaceOp as { op: 'replace'; start: number; end: number };
        const si = this._surface.indexOf(start);
        const ei = this._surface.indexOf(end);
        if (si === -1) throw new Error(`session.append: replace start seq ${start} not on surface`);
        if (ei === -1) throw new Error(`session.append: replace end seq ${end} not on surface`);
        if (si > ei)   throw new Error(`session.append: replace start ${start} after end ${end} on surface`);
        if (intent.sourceEventSeqs) {
            const shadowed = new Set(this._surface.slice(si, ei + 1));
            const cited    = new Set(intent.sourceEventSeqs);
            const missing  = [...shadowed].filter(s => !cited.has(s));
            if (missing.length)
                throw new Error(
                    `session.append: sourceEventSeqs missing shadowed seqs: ${missing.join(', ')}`
                );
        }
    }
}

// ── Surface operation helpers ─────────────────────────────────────────────────
// Non-destructive surface mutations — tombstone/replace rather than array splice.

/**
 * Non-destructive pruning.
 * Appends a replacement tool/result event that shadows the original on the surface.
 * The original event stays in the log at origSeq unchanged.
 * Call this instead of: history[idx] = { ...msg, content: '[pruned: ...]' }
 */
export function pruneSurface(
    session:       Session,
    origSeq:       number,
    callId:        string,
    name:          string,
    turn:          number,
    step:          number,
    prunedContent: string,
): SessionEvent {
    return session.append(
        'tool/result',
        { turn, step, callId, name, content: prunedContent },
        {
            surfaceOp:       { op: 'replace', start: origSeq, end: origSeq },
            sourceEventSeqs: [origSeq],
        } as any,
    );
}

/**
 * Non-destructive compaction.
 * Appends a user/message summary event that shadows a range on the surface.
 * All events in [firstHiddenSeq, lastHiddenSeq] stay in the log.
 * Call this instead of: the destructive sessionCompactHistory + SQL generation scheme.
 */
export function compactSurface(
    session:        Session,
    summaryContent: string,
    firstHiddenSeq: number,
    lastHiddenSeq:  number,
): SessionEvent {
    const si      = session.surface.indexOf(firstHiddenSeq);
    const ei      = session.surface.indexOf(lastHiddenSeq);
    const shadowed = [...session.surface.slice(si, ei + 1)];
    const event   = session.append(
        'user/message',
        { role: 'user', content: summaryContent },
        {
            surfaceOp:       { op: 'replace', start: firstHiddenSeq, end: lastHiddenSeq },
            sourceEventSeqs: shadowed,
        } as any,
    );
    // Emit a companion log-only event recording the compaction metadata.
    try {
        session.append('session/compacted', {
            fromSeq:    firstHiddenSeq,
            toSeq:      lastHiddenSeq,
            summaryLen: summaryContent.length,
        });
    } catch {}
    return event;
}
