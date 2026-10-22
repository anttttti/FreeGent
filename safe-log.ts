// safe-log.ts — where the headless runner and the TUI write their transcripts, and how.
//
// The log holds every prompt and every reply. It used to be a fixed name in /tmp opened with plain appendFileSync: another local user could
// plant a symlink there first (the transcript was then appended to any file the victim could write: ~/.bashrc, authorized_keys), and the file
// was created with the umask, readable by every local user (hermes C10). Now: a per-user directory, a refusal to follow a symlink at the end of
// the path, and mode 0600.
import { openSync, writeSync, closeSync, constants, mkdirSync, lstatSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const OWN_ONLY = 0o600;

/** Append one line. Never follows a symlink at `path`, creates the file private to the user; throws if it cannot (callers swallow log errors). */
export function logAppend(path: string, line: string, _encoding?: string): void {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, OWN_ONLY);
    try { writeSync(fd, line); } finally { closeSync(fd); }
}

function ownedDir(dir: string): boolean {
    try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const st = lstatSync(dir);
        // Our own directory, not a link to somewhere else and not another user's.
        return st.isDirectory() && !st.isSymbolicLink() && (typeof process.getuid !== 'function' || st.uid === process.getuid());
    } catch { return false; }
}

/** The default log file for `name`: in the user's own ~/.freegent, else in a private directory under the temp folder. */
export function defaultLogPath(name: string): string {
    const home = join(homedir(), '.freegent');
    if (ownedDir(home)) return join(home, name);
    const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
    const tmp = join(tmpdir(), `freegent-${uid}`);
    if (ownedDir(tmp)) return join(tmp, name);
    return join(tmp, name);   // unusable directory: opening it fails, and the log is simply not written
}
export const logDir = (path: string): string => dirname(path);
