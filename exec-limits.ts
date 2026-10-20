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

/** A workspace record as one comparable string (text and base64 content never compare equal). */
export function wsRecordKey(rec: { content: string; encoding?: string | null }): string {
    return (rec.encoding === 'base64' ? 'B:' : 'T:') + rec.content;
}
export function snapshotWorkspace(recs: Iterable<{ name?: string; content?: unknown; encoding?: string | null } | null | undefined>): Map<string, string> {
    const snap = new Map<string, string>();
    for (const r of recs) if (r?.name && typeof r.content === 'string') snap.set(r.name, wsRecordKey(r as any));
    return snap;
}
/** For a run's returned writes and deletions: reports whether a file changed in the workspace after `snap` was taken. A run works on
 *  the snapshot it was given, so applying its result over a file the user saved (or another tool wrote) meanwhile would replace the
 *  newer revision with output derived from the old one. Files left out of the run (`omitted`) are not judged here. */
export async function staleGuard(snap: Map<string, string>, omitted: Set<string>, list: () => Promise<any[] | null | undefined>): Promise<(path: string) => boolean> {
    let now: Map<string, string>;
    try { now = snapshotWorkspace((await list()) || []); } catch { return () => false; }
    return (path: string) => !omitted.has(path) && (snap.has(path) !== now.has(path) || (snap.has(path) && snap.get(path) !== now.get(path)));
}
