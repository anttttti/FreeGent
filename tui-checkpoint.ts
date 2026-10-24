// tui-checkpoint.ts — workspace snapshots for the TUI's /rewind.
//
// The WebUI's checkpoints live in IndexedDB and the page; the TUI had none, so /rewind called a browser function with no checkpoint
// and did nothing (TUI report case 022). Here a checkpoint is a copy of the workspace's files in a temporary folder, taken before a message
// is sent. Restoring puts the files back exactly: changed files get their old content, files the turn created are removed, files it
// deleted come back. Limits keep it cheap and honest: a workspace that is too big, or a file that is too large, is not snapshotted, and
// /rewind then says what it could not restore instead of claiming a full restore.
//
// Asynchronous and bounded by workspace-scan.ts (git's file list in a repository, a budgeted walk elsewhere): a checkpoint is taken
// before every message, and the old synchronous walk held the screen for as long as the tree was big.
import { mkdir, lstat, copyFile, rm, readFile, rmdir, stat } from 'node:fs/promises';
import { join, dirname, sep } from 'node:path';
import { listFiles } from './workspace-scan.js';

export const MAX_FILES = 2000;
const BORN_AFTER_MARGIN_MS = 10;   // file times come from a coarse kernel clock (about 4 ms steps)
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
// Folders never copied or touched: version control, dependencies, caches and build output.
const SKIP_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', '.mypy_cache', '.pytest_cache', 'dist', 'build', '.next', 'target']);
// The list may hold some files that are not copied (symlinks, files over the size limit); past this it is not a workspace to snapshot.
const LIST_LIMIT = MAX_FILES * 2;
// Finding the files a turn created needs the whole list, not a snapshot's worth: a generous bound, still a bound.
const RESTORE_LIST_LIMIT = 200_000;

export interface Snapshot {
    id: string;
    dir: string;               // where the copies are
    files: string[];           // relative paths copied
    /** Files left out: larger than MAX_FILE_BYTES. They are neither restored nor removed. */
    skippedLarge: string[];
    /** True when the workspace had more files or bytes than the limits allow: the snapshot is not usable. */
    tooBig: boolean;
    /** When the copy was started (ms): a file can only have been created by the turn if it was born after this. */
    takenAt: number;
    /** The text of the ignore files then in force. If it differs at restore time, the set of files a listing shows has changed. */
    ignoreRules: string;
}

// The rules that decide which files a listing shows: what a restore must be able to say changed.
async function ignoreRulesOf(root: string): Promise<string> {
    const read = (p: string) => readFile(join(root, p), 'utf8').catch(() => '');
    return `${await read('.gitignore')}\n--\n${await read('.git/info/exclude')}`;
}

export async function takeSnapshot(root: string, store: string, id: string): Promise<Snapshot> {
    const dir = join(store, id);
    const snap: Snapshot = { id, dir, files: [], skippedLarge: [], tooBig: false, takenAt: Date.now(), ignoreRules: await ignoreRulesOf(root) };
    const listing = await listFiles(root, { maxEntries: LIST_LIMIT, skipDirs: SKIP_DIRS });
    if (!listing.complete) snap.tooBig = true;
    let total = 0;
    if (!snap.tooBig) for (const rel of listing.files) {
        let size = 0;
        try { const st = await lstat(join(root, rel)); if (!st.isFile()) continue; size = st.size; } catch { continue; }   // symlinks, files deleted since git listed them
        if (size > MAX_FILE_BYTES) { snap.skippedLarge.push(rel); continue; }
        total += size;
        if (snap.files.length + 1 > MAX_FILES || total > MAX_TOTAL_BYTES) { snap.tooBig = true; break; }
        try {
            const to = join(dir, rel);
            await mkdir(dirname(to), { recursive: true });
            await copyFile(join(root, rel), to);
            snap.files.push(rel);
        } catch { snap.tooBig = true; break; }   // a file that cannot be copied makes the snapshot incomplete
    }
    if (snap.tooBig) { await rm(dir, { recursive: true, force: true }).catch(() => {}); snap.files = []; }
    return snap;
}

export interface RestoreResult {
    restored: string[]; removed: string[]; skippedLarge: string[];
    /** The workspace had too many files to list: files the turn created were left in place. */
    createdNotRemoved?: boolean;
    /** Files that are not in the copy and are not provably newer than it (born before it was taken): they pre-existed, hidden by the ignore rules
     *  of the time, and are left alone. */
    kept?: number;
    /** The ignore files changed since the copy: a file the turn created and the new rules hide could not be found. */
    ignoreRulesChanged?: boolean;
}

/** Put the workspace back as it was when `snap` was taken. Throws if the snapshot is not usable. */
export async function restoreSnapshot(root: string, snap: Snapshot): Promise<RestoreResult> {
    if (snap.tooBig) throw new Error('the workspace was too large to snapshot, so its files cannot be restored');
    if (!await stat(snap.dir).then(() => true, () => false) && snap.files.length) throw new Error('the snapshot is gone');
    // Every saved copy must be there before anything is removed or overwritten: failing on the last one, after the files made since had been deleted and the first
    // ones restored, left the workspace half way between the two states (codex R115).
    const missing: string[] = [];
    await Promise.all(snap.files.map(async rel => { if (!await stat(join(snap.dir, rel)).then(st => st.isFile(), () => false)) missing.push(rel); }));
    if (missing.length) throw new Error(`the snapshot is incomplete (${missing.length} saved file${missing.length === 1 ? '' : 's'} missing, e.g. ${missing.slice(0, 3).join(', ')}); nothing was restored`);
    const had = new Set(snap.files);
    const result: RestoreResult = { restored: [], removed: [], skippedLarge: snap.skippedLarge };
    // Files created since: remove (never the large ones the snapshot skipped, which may be untouched).
    const large = new Set(snap.skippedLarge);
    // If the ignore rules changed, a file the turn made may be hidden by the new rules: list the hidden ones too. What each file is (made by the turn or
    // already there) is decided by when it was born, not by which list it is on.
    const rulesChanged = snap.ignoreRules !== undefined && await ignoreRulesOf(root) !== snap.ignoreRules;
    const now = await listFiles(root, { maxEntries: RESTORE_LIST_LIMIT, deadlineMs: 15_000, skipDirs: SKIP_DIRS, includeIgnored: rulesChanged });
    if (rulesChanged) result.ignoreRulesChanged = true;
    if (!now.complete) result.createdNotRemoved = true;
    else for (const rel of now.files) {
        if (had.has(rel) || large.has(rel)) continue;
        try {
            const st = await lstat(join(root, rel));
            if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
            // Only a file born after the copy was made is one the turn created. One that is simply not in the copy can have existed all along under
            // ignore rules that have since changed (rewind deleted such a file: codex R13-001); with no usable birth time, it is left too.
            // (A small margin: a file made in the same instant as the copy is not claimed as the turn's. Keeping a file is the safe mistake.)
            if (!(st.birthtimeMs > snap.takenAt + BORN_AFTER_MARGIN_MS)) { result.kept = (result.kept ?? 0) + 1; continue; }
        } catch { continue; }
        try { await rm(join(root, rel)); result.removed.push(rel); } catch { continue; }
        // Remove the folders that became empty.
        let d = dirname(join(root, rel));
        while (d !== root && d.startsWith(root + sep)) { try { await rmdir(d); } catch { break; } d = dirname(d); }
    }
    for (const rel of snap.files) {
        const from = join(snap.dir, rel), to = join(root, rel);
        let same = false;
        try {
            const [a, b] = await Promise.all([stat(from), stat(to)]);
            same = a.size === b.size && (await readFile(from)).equals(await readFile(to));
        } catch {}
        if (same) continue;
        await mkdir(dirname(to), { recursive: true });
        await copyFile(from, to);
        result.restored.push(rel);
    }
    return result;
}

export async function dropSnapshot(snap: Snapshot): Promise<void> { await rm(snap.dir, { recursive: true, force: true }).catch(() => {}); }
