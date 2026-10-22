// workspace-scan.ts — looking at a workspace's files without ever scaling with its size.
//
// Two jobs need to know about the files on disk: write detection after each execute_code (which files did the command touch) and the
// TUI's checkpoints (what to copy). Both used to walk the whole tree, synchronously, and a repository with 160k files in ignored
// folders froze the TUI for minutes. The rules here:
//   - asynchronous, always: the screen and the other workers keep running;
//   - in a git repository ask git, which keeps its own change cache and applies every .gitignore rule exactly. Changes are
//     `git status` (the dirty set is small however big the tree is); the file list is `git ls-files`;
//   - outside one, a walk with a budget (entries and time). A walk that runs out of budget says so (null / complete=false)
//     instead of finishing late, and the caller does without: write detection falls back to reading the command, a
//     checkpoint reports "too large";
//   - at most two scans at once, so parallel workers cost two scans, not one each.
import { spawn } from 'node:child_process';
import { readdir, lstat } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { trackOp } from './loop-watch.js';

export const SCAN_MAX_ENTRIES = 20_000;
export const SCAN_DEADLINE_MS = 400;
const GIT_STATUS_MAX_ENTRIES = 5_000;
const GIT_DEADLINE_MS = 3_000;
const MAX_CONCURRENT_SCANS = 2;

let _active = 0; const _waiting: Array<() => void> = [];
async function _scanSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (_active >= MAX_CONCURRENT_SCANS) await new Promise<void>(r => _waiting.push(r));
    _active++;
    try { return await fn(); } finally { _active--; _waiting.shift()?.(); }
}

// ── git ──────────────────────────────────────────────────────────────────────

interface GitRun { ok: boolean; out: string; truncated: boolean }
/** Runs git in `cwd`; stops it once the output holds more than `maxEntries` NUL-separated entries or `deadlineMs` has passed. */
function _git(cwd: string, args: string[], maxEntries: number, deadlineMs: number): Promise<GitRun> {
    return new Promise(resolveRun => {
        let out = '', entries = 0, truncated = false, settled = false;
        const finish = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer); resolveRun({ ok: ok && !truncated, out, truncated }); };
        let child;
        try {
            // GIT_OPTIONAL_LOCKS=0: a status must not take index.lock and make the agent's own `git add` fail.
            child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
        } catch { resolveRun({ ok: false, out: '', truncated: false }); return; }
        const stop = () => { truncated = true; try { child.kill('SIGKILL'); } catch {} };
        const timer = setTimeout(stop, deadlineMs);
        child.stdout!.setEncoding('utf8');
        child.stdout!.on('data', (d: string) => {
            out += d;
            for (let i = d.indexOf('\0'); i !== -1; i = d.indexOf('\0', i + 1)) entries++;
            if (entries > maxEntries) stop();
        });
        child.on('error', () => finish(false));
        child.on('close', code => finish(code === 0));
    });
}

// Is `root` inside a git work tree, and how do we get from it to the top ("" at the top, "../" one level down). Positive answers are
// kept; a negative one for a few seconds (a folder gets `git init` later).
const _cdupCache = new Map<string, { cdup: string | null; at: number }>();
async function _cdup(root: string): Promise<string | null> {
    const hit = _cdupCache.get(root);
    if (hit && (hit.cdup !== null || Date.now() - hit.at < 10_000)) return hit.cdup;
    const r = await _git(root, ['rev-parse', '--show-cdup'], 4, 2_000);
    const cdup = r.ok ? r.out.trim() : null;
    _cdupCache.set(root, { cdup, at: Date.now() });
    return cdup;
}

// ── the walk (outside git) ───────────────────────────────────────────────────

// Directories the project's own .gitignore names, for a folder git does not manage. Only plain directory entries are honoured
// (`/bench/`, `node_modules/`, `dist`); wildcards and `!` exceptions are not interpreted, so the walk errs on the side of seeing more.
const _IGNORE_CACHE = new Map<string, { mtime: number; matcher: (rel: string, name: string) => boolean }>();
export function ignoredDirs(root: string): (rel: string, name: string) => boolean {
    let mtime = 0, text = '';
    try { mtime = statSync(join(root, '.gitignore')).mtimeMs; } catch { return () => false; }
    const hit = _IGNORE_CACHE.get(root);
    if (hit && hit.mtime === mtime) return hit.matcher;
    try { text = readFileSync(join(root, '.gitignore'), 'utf8'); } catch { return () => false; }
    const anchored = new Set<string>(), anywhere = new Set<string>(), negated = new Set<string>();
    for (const raw of text.split(/\r?\n/)) {
        let line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('!')) { negated.add(line.slice(1).replace(/^\/|\/$/g, '')); continue; }
        if (/[*?\[\\]/.test(line)) continue;
        line = line.replace(/\/+$/, '');
        const lead = line.startsWith('/');
        line = line.replace(/^\/+/, '');
        if (!line) continue;
        if (lead || line.includes('/')) anchored.add(line);
        else anywhere.add(line);
    }
    const matcher = (rel: string, name: string) => !negated.has(name) && !negated.has(rel) && (anchored.has(rel) || anywhere.has(name));
    _IGNORE_CACHE.set(root, { mtime, matcher });
    return matcher;
}

interface WalkResult { files: Map<string, string>; complete: boolean }
/** Regular files under `root` (relative path → signature when `withStat`, else ''), within an entry and time budget. */
async function _walk(root: string, opts: { skipDirs?: ReadonlySet<string>; maxEntries: number; deadlineMs: number; withStat: boolean }): Promise<WalkResult> {
    const files = new Map<string, string>();
    const skip = ignoredDirs(root);
    const t0 = Date.now();
    let stopped = false, seen = 0;   // seen: files met, counted when found (the stats that record them come later)
    const over = () => { if (!stopped && (seen > opts.maxEntries || Date.now() - t0 > opts.deadlineMs)) stopped = true; return stopped; };
    // A few directories at a time: enough to keep the disk busy, few enough not to starve the other work or run out of file handles.
    let active = 0; const waiting: Array<() => void> = [];
    const slot = async <T>(fn: () => Promise<T>): Promise<T> => {
        while (active >= 24) await new Promise<void>(r => waiting.push(r));
        active++;
        try { return await fn(); } finally { active--; waiting.shift()?.(); }
    };
    const walk = async (d: string, rel: string, depth: number): Promise<void> => {
        if (depth > 8 || over()) return;   // depth: a guard against deeply nested repos
        let ents: import('node:fs').Dirent[];
        try { ents = await slot(() => readdir(d, { withFileTypes: true })); } catch { return; }
        const work: Promise<void>[] = [];
        for (const ent of ents) {
            if (ent.name === '.git') continue;
            const r = rel ? `${rel}/${ent.name}` : ent.name;
            if (ent.isFile()) {
                seen++;
                if (opts.withStat) work.push(slot(async () => { if (over()) return; try { const s = await lstat(join(d, ent.name)); files.set(r, `${s.mtimeMs}:${s.size}`); } catch {} }));
                else files.set(r, '');
                if (over()) break;
            } else if (ent.isDirectory() && !(opts.skipDirs?.has(ent.name)) && !skip(r, ent.name)) work.push(walk(join(d, ent.name), r, depth + 1));
        }
        await Promise.all(work);
    };
    await walk(root, '', 0);
    over();   // the budget may have run out in the last stats
    return { files, complete: !stopped };
}

// ── write detection ──────────────────────────────────────────────────────────

/** Relative path → "mtimeMs:size", or 'gone' for a listed file that does not exist. */
export type Marks = Map<string, string>;
const _sig = async (abs: string): Promise<string> => { try { const s = await lstat(abs); return `${s.mtimeMs}:${s.size}`; } catch { return 'gone'; } };

/**
 * What a later snapshotMarks() can be compared with to find files a command wrote. In a git repository the marks are the files git
 * reports as changed or untracked (clean files cannot have been written without showing up there); elsewhere every file under a
 * budgeted walk. Null when the answer is unknown: the repository is too dirty to list quickly, or the walk ran out of budget.
 */
export function snapshotMarks(root: string): Promise<Marks | null> {
    return trackOp(`workspace scan (${root})`, _scanSlot(async () => {
        const cdup = await _cdup(root);
        if (cdup !== null) {
            const r = await _git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', '.'], GIT_STATUS_MAX_ENTRIES, GIT_DEADLINE_MS);
            if (!r.ok) return null;
            const top = resolve(root, cdup);
            const marks: Marks = new Map();
            await Promise.all(r.out.split('\0').filter(e => e.length > 3).map(async e => {
                const path = e.slice(3);
                if (path.endsWith('/')) return;                       // a nested repository: not this project's files
                const rel = relative(root, resolve(top, path)).split(sep).join('/');
                marks.set(rel, await _sig(join(root, rel)));
            }));
            return marks;
        }
        const w = await _walk(root, { maxEntries: SCAN_MAX_ENTRIES, deadlineMs: SCAN_DEADLINE_MS, withStat: true });
        return w.complete ? w.files : null;
    }));
}

/** The files written between two snapshotMarks(): new, changed, or (a file already listed that left the list) touched since. */
export async function changedSince(root: string, before: Marks, after: Marks): Promise<string[]> {
    const written: string[] = [];
    for (const [p, m] of after) if (m !== 'gone' && before.get(p) !== m) written.push(p);
    // Listed before, clean now: a revert or a commit. Only a file whose own mark changed counts, not the git operation.
    for (const [p, m] of before) {
        if (after.has(p) || m === 'gone') continue;
        const now = await _sig(join(root, p));
        if (now !== 'gone' && now !== m) written.push(p);   // a deleted file is not a written one
    }
    return written;
}

// ── file lists (checkpoints) ─────────────────────────────────────────────────

export interface FileListing { files: string[]; complete: boolean }
/**
 * The project's files (relative paths): tracked and untracked-but-not-ignored in a git repository, otherwise a budgeted walk.
 * `complete` is false when the list was cut at `maxEntries` or `deadlineMs`. Folders named in `skipDirs` are left out either way.
 */
export function listFiles(root: string, opts: { maxEntries: number; deadlineMs?: number; skipDirs?: ReadonlySet<string> }): Promise<FileListing> {
    const deadlineMs = opts.deadlineMs ?? 5_000;
    return trackOp(`file list (${root})`, _scanSlot(async (): Promise<FileListing> => {
        const cdup = await _cdup(root);
        if (cdup !== null) {
            const r = await _git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], opts.maxEntries, deadlineMs);
            if (r.ok || r.truncated) {
                const seen = new Set<string>();
                for (const p of r.out.split('\0')) {
                    if (!p || p.endsWith('/')) continue;
                    if (opts.skipDirs && p.split('/').slice(0, -1).some(c => opts.skipDirs!.has(c))) continue;
                    seen.add(p);
                }
                // A truncated read ends mid-entry: its last name may be cut.
                const files = [...seen]; if (r.truncated) files.pop();
                return { files, complete: r.ok };
            }
        }
        const w = await _walk(root, { skipDirs: opts.skipDirs, maxEntries: opts.maxEntries, deadlineMs, withStat: false });
        return { files: [...w.files.keys()], complete: w.complete };
    }));
}
