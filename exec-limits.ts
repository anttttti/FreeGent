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
// Bumped when the project is cleared or replaced. A run that started in the earlier project holds nothing that may be applied to the
// new one: comparing file contents cannot tell (a file the run creates did not exist in either, and a file that was restored with the
// same bytes looks unchanged), so the snapshot remembers the epoch it was taken in.
// Kept in localStorage so that another tab sees it too: the project is shared between tabs, and a run in one of them can finish after
// the other replaced the project.
export const WORKSPACE_EPOCH_KEY = 'fg_project_epoch';
let _localEpoch = 0;
const _epochNow = (): number => {
    try { return Number(localStorage.getItem(WORKSPACE_EPOCH_KEY)) || 0; } catch { return _localEpoch; }
};
/** The project generation: changes when the project is cleared or replaced, in this tab or another. */
export const workspaceEpoch = (): number => _epochNow();
export const bumpWorkspaceEpoch = (): void => {
    _localEpoch = Math.max(_localEpoch, _epochNow()) + 1;
    try { localStorage.setItem(WORKSPACE_EPOCH_KEY, String(_localEpoch)); } catch {}
};
const _snapEpoch = new WeakMap<Map<string, string>, number>();
/** The project generation a snapshot was taken in (undefined for a map that did not come from snapshotWorkspace). Pass it as `{ epoch }` to agentWriteFile/agentDeleteFile when applying a run's result. */
export const snapshotEpoch = (snap: Map<string, string>): number | undefined => _snapEpoch.get(snap);
export function snapshotWorkspace(recs: Iterable<{ name?: string; content?: unknown; encoding?: string | null } | null | undefined>): Map<string, string> {
    const snap = new Map<string, string>();
    _snapEpoch.set(snap, _epochNow());
    for (const r of recs) if (r?.name && typeof r.content === 'string') snap.set(r.name, wsRecordKey(r as any));
    return snap;
}
/** For a run's returned writes and deletions: reports whether a file changed in the workspace after `snap` was taken. A run works on
 *  the snapshot it was given, so applying its result over a file the user saved (or another tool wrote) meanwhile would replace the
 *  newer revision with output derived from the old one. Files left out of the run (`omitted`) are not judged here. */
export async function staleGuard(snap: Map<string, string>, omitted: Set<string>, list: () => Promise<any[] | null | undefined>): Promise<(path: string) => boolean> {
    if (_snapEpoch.has(snap) && _snapEpoch.get(snap) !== _epochNow()) return () => true;
    let now: Map<string, string>;
    try { now = snapshotWorkspace((await list()) || []); } catch { return () => false; }
    return (path: string) => !omitted.has(path) && (snap.has(path) !== now.has(path) || (snap.has(path) && snap.get(path) !== now.get(path)));
}

/** What a run did to files it wrote that are now empty or much smaller, for the tool result; null when nothing shrank like that.
 *  Self-analysis 2026-10-29: Python's open(path, 'w') empties the file at once, a write that then failed left model-caps.ts at 0 bytes
 *  (P6), a regex rewrite cut 590 lines out of tools.ts (P2); the result said only files_written, and the agent searched the emptied file
 *  for 75 steps. `before`/`after` are sizes (bytes or characters, the same unit for both); `before` null = unknown, not judged. */
export function shrinkNote(changes: { path: string; before: number | null; after: number }[], failed: boolean): string | null {
    const fmt = (n: number) => n.toLocaleString('en-US');
    const hits = changes.filter(c => c.before != null && c.before > 0 && (c.after === 0 || (c.before - c.after >= 4000 && c.after <= c.before * 0.8)))
        .map(c => c.after === 0 ? `${c.path} is now EMPTY (it was ${fmt(c.before!)} bytes)` : `${c.path} shrank from ${fmt(c.before!)} to ${fmt(c.after)} bytes (-${Math.round((1 - c.after / c.before!) * 100)}%)`);
    if (!hits.length) return null;
    return `Check this before going on: ${hits.join('; ')}. ${failed ? 'The code failed, and ' : ''}a file opened for writing is emptied at once, so code that stops after open(path, "w") leaves it empty or cut short. If that was not meant, write the file again from the content you read earlier (or restore it from git), and check its size.`;
}
