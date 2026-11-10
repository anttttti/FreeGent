// types.ts — shared public types for the FreeGent harness adapter interface.
// Types of the Director loop (loop-director.ts)

/** Signal returned by runAgentTurn() / generate() describing why the turn ended. */
export type FinishSignal =
    | 'complete'  // agent declared COMPLETED
    | 'blocked'   // agent declared BLOCKED
    | 'running'   // turn ended at step cap or soft limit — caller may continue
    | 'stopped'   // user / abort signal stopped the turn mid-flight
    | 'error';    // the turn threw; its prompt was rolled back — callers must not continue it

/** Structured result returned by runAgentTurn() (§4) and generate() (§6). */
export type TurnResult = {
    text:         string;
    finishSignal: FinishSignal;
    /** The loop's forced-stop reason for this turn (null when it ended normally), and whether the turn changed files. */
    stop?:        { reason: string | null; edited: boolean };
};
