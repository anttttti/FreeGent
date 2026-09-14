// session-event.ts — FreeGent: append-only session event log type definitions.
//
// Architecture mirrors dsh (deepseek-harness) packages/core/session/src/types.ts,
// adapted to FreeGent's event vocabulary and OAI-format history.
//
// Key invariants:
//   - SessionEvent.seq === log.length at append time (contiguous from 0)
//   - Only SurfaceEventType events produce LLM messages; all three must carry surfaceOp
//   - Surface replace ops preserve original events in the log; only the surface view changes
//   - Every event's data is JSON-serializable before it enters the log
//

// ── Payload types ──────────────────────────────────────────────────────────────

export type TurnEndReason =
    | { kind: 'completed' }
    | { kind: 'aborted' }
    | { kind: 'error'; message: string }
    | { kind: 'max-turns' }
    | { kind: 'soft-stop' };

export interface TokenUsage {
    prompt_tokens: number;
    completion_tokens: number;
}

// ── Event map ─────────────────────────────────────────────────────────────────
// Merge-extensible: adding a new event type is additive — no enum to update,
// no union that requires exhaustive handling. Mirror dsh's SessionEventMap exactly.

export interface SessionEventMap {
    // ── Structural / turn lifecycle ──────────────────────────────────────────
    // Open a turn before any user input is committed to history.
    'turn/start':        { turn: number; chatId: string };
    // Close a turn; carries reason and wall-clock duration.
    'turn/end':          { turn: number; reason: TurnEndReason; durationMs?: number };
    // Open one model call + tool-execution cycle within a turn.
    'step/start':        { turn: number; step: number; model: string; provider: string };
    // Close a step.
    'step/end':          { turn: number; step: number };

    // ── Surface events (produce LLM messages) ────────────────────────────────
    // User prompt or injected content (nudges, skills, context injections).
    // Role-injected fn-tag tool-result bundles also arrive as 'user/message'.
    'user/message':      { role: 'user'; content: string | unknown[] };
    // Assembled assistant response with optional usage accounting.
    'assistant/message': {
        turn: number; step: number;
        message: { role: 'assistant'; content: string | null; tool_calls?: unknown[] };
        usage?: TokenUsage;
    };
    // Executed tool result. replace surfaceOp = non-destructive pruned stub;
    // the original remains in the log.
    'tool/result':       {
        turn: number; step: number;
        callId: string; name: string;
        content: string;
        isError?: boolean;
    };

    // ── Log-only events (not surfaced to model) ──────────────────────────────
    // Streaming delta token — log-only, for replay fidelity.
    'assistant/chunk':   { turn: number; step: number; delta: string };
    // Model-issued tool invocation before execution.
    'tool/call':         { turn: number; step: number; callId: string; name: string; arguments: string };
    // System prompt + tool schema snapshot before each LLM request.
    // Stores lengths rather than full text to keep events lean.
    'request/header':    {
        turn: number; step: number;
        model: string; provider: string;
        systemPromptLen: number; toolCount: number;
    };

    // ── Fork / resume boundary ────────────────────────────────────────────────
    // Marks the seed/live boundary after fork() or resume(). Appended automatically
    // by the Session constructor when a seed is provided.
    'session/end-seed':  Record<string, never>;
    // Records that a surface compaction replaced a range with a summary.
    // Appended alongside the compactSurface() user/message event.
    'session/compacted': { fromSeq: number; toSeq: number; summaryLen: number };
}

export type SessionEventType = keyof SessionEventMap;

// ── Surface types ─────────────────────────────────────────────────────────────
// The three event types that produce LLM messages and participate in the surface.
// Only these three may carry surfaceOp / sourceEventSeqs.

export type SurfaceEventType = 'user/message' | 'assistant/message' | 'tool/result';

export const SURFACE_TYPES: ReadonlySet<string> =
    new Set<string>(['user/message', 'assistant/message', 'tool/result']);

// ── Surface operations ────────────────────────────────────────────────────────
// 'append'  — add this event to the surface tail (normal case).
// 'replace' — shadow an existing range; start and end are surface seq numbers.
//             The shadowed events stay in the log; only the surface view changes.

export type SurfaceOp =
    | 'append'
    | { op: 'replace'; start: number; end: number };

// Convenience type for the optional surfaceIntent parameter on Session.append().
export interface SurfaceIntent {
    surfaceOp: SurfaceOp;
    /** All surface seqs shadowed by this replacement. Required for replace ops. */
    sourceEventSeqs?: number[];
}

// ── Wire type ─────────────────────────────────────────────────────────────────
// The on-disk / in-memory representation of every event in the log.
// Surface events additionally carry optional surfaceOp / sourceEventSeqs.

export type SessionEvent<T extends SessionEventType = SessionEventType> = {
    [K in SessionEventType]: {
        readonly type: K;
        readonly seq:  number;   // = log.length at append time; contiguous from 0
        readonly time: number;   // Date.now()
        readonly data: SessionEventMap[K];
    } & (K extends SurfaceEventType ? {
        readonly surfaceOp?:         SurfaceOp;
        readonly sourceEventSeqs?:   readonly number[];
    } : object);
}[T];
