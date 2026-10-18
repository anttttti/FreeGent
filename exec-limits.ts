// exec-limits.ts — the execute_code time limits, in a module with no Node imports so that tools.ts
// (which also runs in the browser) and native-exec.ts share one definition.
export const EXEC_TIMEOUT_MS = 120_000;
// Ceiling for a per-call `timeout_s`: a legitimately long step (model training, a build) gets longer than
// the default, but never unbounded: the task's own wall-clock limit still applies.
export const EXEC_TIMEOUT_MAX_MS = 900_000;
/** The limit for one call: the default, or `seconds` clamped to 1 s .. EXEC_TIMEOUT_MAX_MS. */
export function execTimeoutMs(seconds: unknown): number {
    const n = Number(seconds);
    return Number.isFinite(n) && n > 0 ? Math.min(EXEC_TIMEOUT_MAX_MS, Math.max(1_000, Math.round(n * 1000))) : EXEC_TIMEOUT_MS;
}

/** Why a run's write was refused: the file it targets was left out of the run's copy of the workspace (too large),
 *  so the run could not have seen its content and writing it would replace the original with whatever the run made. */
export function omittedFileWriteMessage(path: string): string {
    return `${path}: not written. The existing file is too large to be copied into the run, so the run did not see it, and writing it would have replaced its content. Change it with append_file or replace_in_file, or write the new output to a different file.`;
}
