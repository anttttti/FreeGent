// types.ts — shared public types for the FreeGent harness adapter interface.
// §4 of agentharness_migration.md

/** Signal returned by runAgentTurn() / generate() describing why the turn ended. */
export type FinishSignal =
    | 'complete'  // agent declared COMPLETED
    | 'blocked'   // agent declared BLOCKED
    | 'running'   // turn ended at step cap or soft limit — caller may continue
    | 'stopped'   // user / abort signal stopped the turn mid-flight
    | 'error';    // the turn threw; its prompt was rolled back — callers must not continue it

export type StepRecord = {
    type: 'tool-call';
    toolName: string;
    args: unknown;
    result: unknown;
} | {
    type: 'text';
    text: string;
};

export type TurnUsage = {
    inputTokens:  number;
    outputTokens: number;
    totalTokens:  number;
};

/** Structured result returned by runAgentTurn() (§4) and generate() (§6). */
export type TurnResult = {
    text:         string;
    finishSignal: FinishSignal;
    usage:        TurnUsage;
    steps:        StepRecord[];
};
