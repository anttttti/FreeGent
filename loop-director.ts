// loop-director.ts — Director multi-turn loop (§3 of agentharness_migration.md).
//
// Extracted from headless-runner.ts so external loop code owns the continuation
// policy and the harness only executes single turns.
//
// The loop calls `runOneTurn` (typically runAgentTurn) repeatedly until the agent
// declares COMPLETED, is BLOCKED, is stopped externally, a turn errors, or it hits the
// max-continuation cap. Only 'running' continues: after 'error' the turn's prompt has been
// rolled back, so a continuation would run without the task.

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
    /**
     * Closing turns allowed after a step-limit stop, once the run has changed files. Other forced
     * stops (repeated calls, failure streak) always end the run. Default 0. Counts toward
     * maxContinuations.
     */
    stepLimitContinuations?: number;
    /** Prompt for a closing turn after a step-limit stop; receives the turn's step budget. */
    stepLimitPrompt?: string | ((steps: number | undefined) => string);
    /**
     * Step budget of a closing turn. Unset = the normal per-turn budget. v0.58 gave closing turns
     * the full 100 steps: 35 SWE runs, 2,064 steps, 53.8M prompt tokens, and 10 of them ran to the
     * limit again. Runs that only had to check their fix finished in 5–16 steps.
     */
    closingSteps?: number;
    /** Tools a closing turn may not use (run_workers: a closing turn should not delegate new work). */
    closingExcludeTools?: string[];
}

// A forced stop ends a turn as BLOCKED. Until v0.57 the stop text often failed the BLOCKED check,
// so every forced stop, a repeat or failure-streak stop included, was followed by up to 4 blind
// 100-step turns. 2 of the 12 SWE runs that continued were resolved in a continuation, both after
// a step-limit stop in a run that had already edited files (Lite xarray-4094, Verified
// requests-1142): that case gets one explicit closing turn.
const _STEP_LIMIT_RE = /step budget exhausted|maximum step limit reached|role step cap/;
export const STEP_LIMIT_PROMPT = (steps?: number): string =>
    `You reached the step limit for this turn. Your file changes so far are kept. Use this closing turn${steps ? ` (${steps} steps)` : ''} to finish: check that your fix is applied (e.g. git diff), run the most relevant test once if you can, correct only what that shows, then end with COMPLETED. Do not start new exploration.`;

export type RunOneTurn = (
    prompt: string,
    session: AgentSession,
    opts?: { forceToolCall?: boolean; placeholder?: any; maxSteps?: number; excludeTools?: string[] },
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
        stepLimitContinuations = 0,
        stepLimitPrompt = STEP_LIMIT_PROMPT,
        closingSteps,
        closingExcludeTools,
    } = opts;
    const _closingPrompt = typeof stepLimitPrompt === 'function' ? stepLimitPrompt(closingSteps) : stepLimitPrompt;

    // First turn
    let result = await runOneTurn(task, session,
        forceFirstToolCall ? { forceToolCall: true } : undefined);
    onTurn?.(0, result);

    // Continuation turns
    let n = 0, closing = 0;
    let edited = !!result.stop?.edited;
    const _closingTurn = (r: TurnResult) => r.finishSignal === 'blocked' && edited
        && _STEP_LIMIT_RE.test(r.stop?.reason ?? '') && closing < stepLimitContinuations;
    while (
        (result.finishSignal === 'running' || _closingTurn(result)) &&
        !session.softStopPending &&
        n < maxContinuations
    ) {
        const isClosing = result.finishSignal !== 'running';
        if (isClosing) closing++;
        result = isClosing
            ? await runOneTurn(_closingPrompt, session, { forceToolCall: true,
                ...(closingSteps ? { maxSteps: closingSteps } : {}),
                ...(closingExcludeTools?.length ? { excludeTools: closingExcludeTools } : {}) })
            : await runOneTurn(continuationPrompt, session, { forceToolCall: true });
        edited ||= !!result.stop?.edited;
        n++;
        onTurn?.(n, result);
    }

    // If the loop exhausted maxContinuations without a terminal signal, synthesise
    // a blocked result so callers never see finishSignal='running' after the loop exits.
    if (result.finishSignal === 'running' && !session.softStopPending) {
        result = { ...result, finishSignal: 'blocked',
            text: result.text + '\n\nBLOCKED: reached max continuations without completing the task.' };
    }

    return result;
}
