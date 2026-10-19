// tui-checkpoint.ts — workspace snapshots for the TUI's /rewind.
//
// The WebUI's checkpoints live in IndexedDB and the page; the TUI had none, so /rewind called a browser function with no checkpoint
// and did nothing (TUI report case 022). Here a checkpoint is a copy of the workspace's files in a temporary folder, taken before a message
// is sent. Restoring puts the files back exactly: changed files get their old content, files the turn created are removed, files it
// deleted come back. Limits keep it cheap and honest: a workspace that is too big, or a file that is too large, is not snapshotted, and
// /rewind then says what it could not restore instead of claiming a full restore.
import { mkdirSync, readdirSync, lstatSync, copyFileSync, rmSync, readFileSync, existsSync, rmdirSync, chmodSync, statSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';

export const MAX_FILES = 2000;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
// Folders never copied or touched: version control, dependencies, caches and build output.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', '.mypy_cache', '.pytest_cache', 'dist', 'build', '.next', 'target']);

export interface Snapshot {
    id: string;
    dir: string;               // where the copies are
    files: string[];           // relative paths copied
    /** Files left out: larger than MAX_FILE_BYTES. They are neither restored nor removed. */
    skippedLarge: string[];
    /** True when the workspace had more files or bytes than the limits allow: the snapshot is not usable. */
    tooBig: boolean;
}

function* walk(root: string, rel = ''): Generator<{ rel: string; size: number }> {
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        const r = rel ? join(rel, e.name) : e.name;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(root, r); continue; }
        if (!e.isFile()) continue;
        let size = 0;
        try { size = lstatSync(join(root, r)).size; } catch { continue; }
        yield { rel: r, size };
    }
}

export function takeSnapshot(root: string, store: string, id: string): Snapshot {
    const dir = join(store, id);
    const snap: Snapshot = { id, dir, files: [], skippedLarge: [], tooBig: false };
    let total = 0;
    for (const f of walk(root)) {
        if (f.size > MAX_FILE_BYTES) { snap.skippedLarge.push(f.rel); continue; }
        total += f.size;
        if (snap.files.length + 1 > MAX_FILES || total > MAX_TOTAL_BYTES) { snap.tooBig = true; break; }
        try {
            const to = join(dir, f.rel);
            mkdirSync(dirname(to), { recursive: true });
            copyFileSync(join(root, f.rel), to);
            snap.files.push(f.rel);
        } catch { snap.tooBig = true; break; }   // a file that cannot be copied makes the snapshot incomplete
    }
    if (snap.tooBig) { try { rmSync(dir, { recursive: true, force: true }); } catch {} snap.files = []; }
    return snap;
}

export interface RestoreResult { restored: string[]; removed: string[]; skippedLarge: string[] }

/** Put the workspace back as it was when `snap` was taken. Throws if the snapshot is not usable. */
export function restoreSnapshot(root: string, snap: Snapshot): RestoreResult {
    if (snap.tooBig) throw new Error('the workspace was too large to snapshot, so its files cannot be restored');
    if (!existsSync(snap.dir) && snap.files.length) throw new Error('the snapshot is gone');
    const had = new Set(snap.files);
    const result: RestoreResult = { restored: [], removed: [], skippedLarge: snap.skippedLarge };
    // Files created since: remove (never the large ones the snapshot skipped, which may be untouched).
    const large = new Set(snap.skippedLarge);
    for (const f of [...walk(root)]) {
        if (had.has(f.rel) || large.has(f.rel)) continue;
        if (f.size > MAX_FILE_BYTES) continue;
        try { rmSync(join(root, f.rel)); result.removed.push(f.rel); } catch {}
        // Remove the folders that became empty.
        let d = dirname(join(root, f.rel));
        while (d !== root && d.startsWith(root + sep)) { try { rmdirSync(d); } catch { break; } d = dirname(d); }
    }
    for (const rel of snap.files) {
        const from = join(snap.dir, rel), to = join(root, rel);
        let same = false;
        try {
            const a = statSync(from), b = statSync(to);
            same = a.size === b.size && readFileSync(from).equals(readFileSync(to));
        } catch {}
        if (same) continue;
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
        result.restored.push(rel);
    }
    return result;
}

export function dropSnapshot(snap: Snapshot): void { try { rmSync(snap.dir, { recursive: true, force: true }); } catch {} }
