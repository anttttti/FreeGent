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
}

export async function takeSnapshot(root: string, store: string, id: string): Promise<Snapshot> {
    const dir = join(store, id);
    const snap: Snapshot = { id, dir, files: [], skippedLarge: [], tooBig: false };
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
}

/** Put the workspace back as it was when `snap` was taken. Throws if the snapshot is not usable. */
export async function restoreSnapshot(root: string, snap: Snapshot): Promise<RestoreResult> {
    if (snap.tooBig) throw new Error('the workspace was too large to snapshot, so its files cannot be restored');
    if (!await stat(snap.dir).then(() => true, () => false) && snap.files.length) throw new Error('the snapshot is gone');
    const had = new Set(snap.files);
    const result: RestoreResult = { restored: [], removed: [], skippedLarge: snap.skippedLarge };
    // Files created since: remove (never the large ones the snapshot skipped, which may be untouched).
    const large = new Set(snap.skippedLarge);
    const now = await listFiles(root, { maxEntries: RESTORE_LIST_LIMIT, deadlineMs: 15_000, skipDirs: SKIP_DIRS });
    if (!now.complete) result.createdNotRemoved = true;
    else for (const rel of now.files) {
        if (had.has(rel) || large.has(rel)) continue;
        try { const st = await lstat(join(root, rel)); if (!st.isFile() || st.size > MAX_FILE_BYTES) continue; } catch { continue; }
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
