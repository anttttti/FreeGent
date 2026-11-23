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

/** Whether the code names this workspace file: by its path, or by its file name (4+ characters). */
export function namesFile(code: string, name: string): boolean {
    const base = name.slice(name.lastIndexOf('/') + 1);
    return code.includes(name) || (base.length >= 4 && code.includes(base));
}

/** Why a run's deletion was refused: the file was left out of the run's copy, so the run did not see it and cannot have meant to delete it. */
export function omittedFileDeleteMessage(path: string): string {
    return `${path}: not deleted. The file was left out of the run's copy of the project, so the run did not see it. Delete it with delete_file if it should go.`;
}

/** Why a run's write was refused: the file it targets was left out of the run's copy of the workspace (over the file limit, or past the copy's total limit),
 *  so the run could not have seen its content and writing it would replace the original with whatever the run made. */
export function omittedFileWriteMessage(path: string): string {
    return `${path}: not written. The existing file was left out of the run's copy of the project (over the size limit for a file, or past the limit for the whole copy), so the run did not see it, and writing it would have replaced its content. Change it with append_file or replace_in_file, or write the new output to a different file.`;
}

/** Characters of workspace files (stored size: base64 for binary) one JavaScript run gets a copy of. Every run was sent every file: a 690-file, about 70 MB
 *  project took the tab down on the second run on an iPad (Safari 12, 1 GB; five tab crashes in the 2026-11-22 chat log review, each the second run or later). */
export const EXEC_COPY_MAX_CHARS = 24_000_000;

/** The bytes a stored workspace record stands for: UTF-8 for text, decoded for base64 (padding is not data). Counted, not decoded: the strings can be 10M characters. */
export function byteSize(content: string, base64: boolean): number {
    if (base64) { const n = content.length; return Math.max(0, Math.floor(n * 3 / 4) - (content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0)); }
    let b = 0;
    for (let i = 0; i < content.length; i++) {
        const c = content.charCodeAt(i);
        if (c < 0x80) b += 1; else if (c < 0x800) b += 2;
        else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < content.length && (content.charCodeAt(i + 1) & 0xFC00) === 0xDC00) { b += 4; i++; }
        else b += 3;
    }
    return b;
}

/** Which workspace records a run gets: files named in its code first (by path or by file name), then the rest smallest first, while the copy stays within `maxTotal`;
 *  a file over `maxFile` never (those are also in `large`: naming them does not help; the Local Folder's unreadable files are too). Everything else is `omitted` with its size, for the run to list and to refuse to read with a message. A workspace within the limit is sent whole. */
export function planWorkspaceCopy<T extends { name?: string; content?: unknown; encoding?: string | null }>(recs: Iterable<T | null | undefined>, code: string, maxFile: number, maxTotal = EXEC_COPY_MAX_CHARS): { send: T[]; omitted: Map<string, number>; large: Set<string> } {
    const omitted = new Map<string, number>(), large = new Set<string>(), cand: { r: T; len: number; named: boolean; sure: boolean }[] = [];
    const sizeOf = (r: T, len: number) => byteSize(r.content as string, r.encoding === 'base64');
    for (const r of recs) {
        if (!r?.name || typeof r.content !== 'string') continue;
        const len = r.content.length;
        if (len > maxFile) { omitted.set(r.name, sizeOf(r, len)); large.add(r.name); continue; }
        const base = r.name.slice(r.name.lastIndexOf('/') + 1);
        cand.push({ r, len, named: namesFile(code, r.name), sure: code.includes(r.name) });
    }
    // A file named by its path is always sent. One named only by its file name is too, unless several files share that name: then the name does not say which is meant,
    // and sending them all past the budget (one path in the code pulled five 8 MB files of one name) would defeat it; they come first, within the budget (explorations W002).
    const nameOf = (r: T) => r.name!.slice(r.name!.lastIndexOf('/') + 1);
    const sameName = new Map<string, number>();
    for (const c of cand) sameName.set(nameOf(c.r), (sameName.get(nameOf(c.r)) ?? 0) + 1);
    for (const c of cand) if (c.named && !c.sure && (sameName.get(nameOf(c.r)) ?? 0) === 1) c.sure = true;   // a name that is the file's alone says which file is meant
    cand.sort((a, b) => a.named === b.named ? a.len - b.len : a.named ? -1 : 1);
    const send: T[] = [];
    let used = 0;
    for (const c of cand) {
        if (c.sure || used + c.len <= maxTotal) { send.push(c.r); used += c.len; }
        else omitted.set(c.r.name!, sizeOf(c.r, c.len));
    }
    return { send, omitted, large };
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
// The larger of the stored value and this tab's own count: a bump whose write failed (storage full) still counts here, so a Clear is not undone for this tab's late
// writes by the stored value standing still (explorations N010). Another tab sees only what was stored.
const _epochNow = (): number => {
    let stored = 0;
    try { stored = Number(localStorage.getItem(WORKSPACE_EPOCH_KEY)) || 0; } catch {}
    return Math.max(stored, _localEpoch);
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
    // A listing that fails says nothing about what changed meanwhile: not knowing is not "unchanged", and a writeback that proceeds would replace or delete newer files (E023).
    try { now = snapshotWorkspace((await list()) || []); } catch { return () => true; }
    return (path: string) => !omitted.has(path) && (snap.has(path) !== now.has(path) || (snap.has(path) && snap.get(path) !== now.get(path)));
}

/** The attached Local Folder's live files, for a run's input and its stale-write baseline (codex R438 to R440). The listing marks them `isLocal` with a
 *  `local/` name. A text file within `maxChars` goes into the run (`put`) and into `snap`, so the guard knows what the run saw; it replaces an imported
 *  snapshot record of the same name, including that record's "too large" mark. A file the run cannot see (too large, or not text) is `omitted`, so the
 *  run may not replace it. `skip` leaves out folders such as logs to keep a start fast. */
export async function addLiveFolderInput(o: {
    list: () => Promise<any[] | null | undefined>; read: (name: string) => Promise<unknown>; maxChars: number;
    put: (name: string, content: string) => void; snap: Map<string, string>; omitted: Set<string>; skip?: RegExp;
    /** Receives the size of each file left out, for the run to list it with. */
    sizes?: Map<string, number>;
    /** The characters of the run's copy still free after the workspace's records: a folder file past it is left out unless the code names it (commit review of 3376cb1, Codex). */
    budget?: { chars: number; named?: (name: string) => boolean };
}): Promise<void> {
    for (const f of (await o.list()) || []) {
        if (!f?.isLocal || !f.name || o.skip?.test(f.name)) continue;
        let c: unknown;
        try { c = await o.read(f.name); } catch { o.omitted.add(f.name); o.sizes?.set(f.name, Number(f.size) || 0); continue; }   // a file that cannot be read is one the run did not see: it may not replace it (Y020)
        const fits = !o.budget || o.budget.named?.(f.name) || (typeof c === 'string' && c.length <= o.budget.chars);
        if (typeof c === 'string' && c.length <= o.maxChars && fits) { o.put(f.name, c); if (o.budget) o.budget.chars -= c.length; o.snap.set(f.name, wsRecordKey({ content: c })); o.omitted.delete(f.name); }
        else { o.omitted.add(f.name); o.sizes?.set(f.name, Number(f.size) || 0); }
    }
}
/** A listing for `staleGuard` that also holds the current content of the `local/` files the run changed: the guard compares the baseline with this. */
export function withLiveFiles(list: () => Promise<any[] | null | undefined>, read: (name: string) => Promise<unknown>, changed: Iterable<string>): () => Promise<any[]> {
    const names = [...changed].filter(n => n.startsWith('local/'));
    return async () => {
        const recs = [...((await list()) || [])];
        for (const name of names) {
            try { const c = await read(name); if (typeof c === 'string') { const i = recs.findIndex(r => r?.name === name); if (i >= 0) recs.splice(i, 1); recs.push({ name, content: c }); } }
            catch (e: any) { if (!/not found/i.test(String(e?.message ?? ''))) throw e; }   // absent is a fact (a file the run created); an unreadable one is unknown, and the guard then treats everything as changed (Y020)
        }
        return recs;
    };
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
