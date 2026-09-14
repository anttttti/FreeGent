// loop-director.ts — Director multi-turn loop (§3 of agentharness_migration.md).
//
// Extracted from headless-runner.ts so external loop code owns the continuation
// policy and the harness only executes single turns.
//
// The loop calls `runOneTurn` (typically runAgentTurn) repeatedly until the agent
// declares COMPLETED, is BLOCKED, is stopped externally, or hits the max-continuation cap.

import type { AgentSession } from './state.js';
import type { TurnResult } from './types.js';

export interface DirectorOpts {
    /** Max additional turns after the first. Default 4 (matches legacy headless-runner behaviour). */
    maxContinuations?: number;
    /** Prompt injected for each continuation turn. */
    continuationPrompt?: string;
    /** Called after each turn completes — useful for progress logging. */
    onTurn?: (turnIndex: number, result: TurnResult) => void;
    /** If true, force a tool call on the very first turn (prevents step-0 text exits). */
    forceFirstToolCall?: boolean;
}

export type RunOneTurn = (
    prompt: string,
    session: AgentSession,
    opts?: { forceToolCall?: boolean; placeholder?: any },
) => Promise<TurnResult>;

/**
 * Run the director multi-turn loop.
 *
 * @param runOneTurn  Function that executes one agent turn (e.g. a bound runAgentTurn).
 * @param session     The AgentSession for this task run.
 * @param task        The initial task prompt.
 * @param opts        Loop configuration.
 * @returns           The TurnResult from the last turn that ran.
 */
export async function directorLoop(
    runOneTurn: RunOneTurn,
    session: AgentSession,
    task: string,
    opts: DirectorOpts = {},
): Promise<TurnResult> {
    const {
        maxContinuations  = 4,
        continuationPrompt = 'The task is not yet complete. Take the single most useful next step now.',
        onTurn,
        forceFirstToolCall = false,
    } = opts;

    // First turn
    let result = await runOneTurn(task, session,
        forceFirstToolCall ? { forceToolCall: true } : undefined);
    onTurn?.(0, result);

    // Continuation turns
    let n = 0;
    while (
        result.finishSignal === 'running' &&
        !session.softStopPending &&
        n < maxContinuations
    ) {
        result = await runOneTurn(continuationPrompt, session, { forceToolCall: true });
        n++;
        onTurn?.(n, result);
    }

    return result;
}
