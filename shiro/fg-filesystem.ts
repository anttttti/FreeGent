/**
 * fg-filesystem.ts — FreeGent FileSystem adapter for Shiro's Shell
 *
 * Bridges Shiro's FileSystem interface to FreeGent's workspace (IndexedDB via
 * agentReadFile / agentWriteFile / agentDeleteFile / agentListFiles).
 *
 * Mount layout:
 *   /workspace/**   → FreeGent workspace files (flat key-value, string content)
 *   /tmp/**         → in-memory (ephemeral; used by shell scripts)
 *   /home/user/**   → in-memory (shell history, dot-files)
 *   /               → virtual directory
 *
 * The Shell's CWD starts at /home/user.  Scripts that touch workspace files use
 * /workspace or switch CWD to /workspace.
 */

import { devProvider, FileSystem, globPatternToRegex } from './filesystem';
import type { StatResult } from './filesystem';
import { bytesToText, isTextBytes, textToBytes } from './utils/bytes';
import {
    agentWriteFile,
    agentDeleteFile,
    agentListFiles,
    readWorkspaceFile,
} from '../workspace';

// ── constants ────────────────────────────────────────────────────────────────

export const WORKSPACE_MOUNT = '/workspace';
/** Reads as empty, swallows writes — for commands that open it as a file (cat /dev/null, cmd < /dev/null). */

// Text records hold UTF-8 text exactly (a BOM, CRLF and lone CRs included).
const dec = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * Encode a Uint8Array to base64 without chunking.
 *
 * Chunked approaches (btoa per N-byte slice) insert '=' padding mid-string
 * whenever the chunk size is not a multiple of 3.  Browser atob() stops
 * decoding at the first interior '=', silently truncating files > N bytes.
 * Building the binary string char-by-char then calling btoa once produces
 * a single valid padded base64 string with no interior '='.
 */
function _bytesToBase64(data: Uint8Array): string {
    let s = '';
    for (let i = 0; i < data.length; i++) s += String.fromCharCode(data[i]);
    return btoa(s);
}

/**
 * Decode a base64 string to Uint8Array, tolerating interior '=' padding.
 *
 * Legacy data encoded with 8192-byte chunks has '=' mid-string; browser
 * atob() stops at the first interior '=', producing a truncated result.
 * Stripping all '=' then re-adding correct end-padding before calling atob
 * makes the decoder robust against both well-formed and chunked base64.
 */
function _base64ToBytes(b64: string): Uint8Array {
    const s   = b64.replace(/=/g, '');
    const pad = (4 - s.length % 4) % 4;
    const raw = atob(s + '='.repeat(pad));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** A workspace record's bytes: base64 decoded, or the text as UTF-8. */
function _recordBytes(rec: { content?: string; encoding?: string | null }): Uint8Array {
    return rec.encoding === 'base64' ? _base64ToBytes(rec.content ?? '') : textToBytes(rec.content ?? '');
}

function makeStat(type: 'file' | 'dir', size = 0, mtime = Date.now(), executable = false): StatResult {
    const mt = new Date(mtime);
    return {
        type,
        mode: type === 'dir' || executable ? 0o755 : 0o644,
        size,
        mtime: mt,
        ctime: mt,
        isFile: () => type === 'file',
        isDirectory: () => type === 'dir',
        isSymbolicLink: () => false,
    };
}

function makeError(code: string, msg: string): Error {
    const e = new Error(msg) as Error & { code: string };
    e.code = code;
    return e;
}

/**
 * Given an absolute shell path, return the FreeGent workspace-relative path,
 * or null if the path is outside /workspace.
 *
 * /workspace          → '' (workspace root)
 * /workspace/src/x.ts → 'src/x.ts'
 * /tmp/foo            → null (in-memory)
 */
function toWsPath(absPath: string): string | null {
    if (absPath === WORKSPACE_MOUNT) return '';
    if (absPath.startsWith(WORKSPACE_MOUNT + '/')) {
        return absPath.slice(WORKSPACE_MOUNT.length + 1);
    }
    return null;
}

// ── FWFileSystem ──────────────────────────────────────────────────────────────

export class FWFileSystem extends FileSystem {
    /** In-memory store for paths outside /workspace (e.g. /tmp, /home/user). */
    private mem = new Map<string, Uint8Array>();
    /**
     * Directories made with mkdir, by absolute path. The workspace stores files only, so a
     * directory otherwise exists only while it has files in it; these last for the session.
     */
    private dirs = new Set<string>();
    /** Files chmod made executable, for this session (the workspace keeps no permissions). */
    private executable = new Set<string>();

    /** Skip Shiro's IDB init — FreeGent workspace is already ready. */
    override async init(): Promise<void> {
        // Ensure basic in-memory dirs exist (stat() checks will succeed)
        // No actual IDB needed.
    }

    override async stat(path: string): Promise<StatResult> {
        if (devProvider.handles(path)) { const st = devProvider.stat(path); if (st) return st; }
        const wsPath = toWsPath(path);
        if (wsPath !== null) {
            if (wsPath === '') return makeStat('dir'); // workspace root
            // Use readWorkspaceFile directly (agentReadFile runs text extraction on binary
            // files, returning the wrong size and potentially throwing for non-doc binaries).
            const rec = await readWorkspaceFile(wsPath).catch(() => null);
            if (rec !== null && rec !== undefined) {
                return makeStat('file', _recordBytes(rec).byteLength, Date.now(), this.executable.has(path));
            }
            // Not a file — check if it is an implicit directory (has child entries)
            const prefix = wsPath + '/';
            const all = await agentListFiles();
            if (all.some(f => f.name.startsWith(prefix)) || this.dirs.has(path)) {
                return makeStat('dir');
            }
            throw makeError('ENOENT', `no such file or directory: ${path}`);
        }
        // In-memory
        if (this.mem.has(path)) {
            return makeStat('file', this.mem.get(path)!.byteLength, Date.now(), this.executable.has(path));
        }
        // Virtual dirs: /, /tmp, /home, /home/user, /workspace
        if (this._isVirtualDir(path) || this.dirs.has(path)) return makeStat('dir');
        // Check if any mem file lives under this path as a dir
        const prefix = path.endsWith('/') ? path : path + '/';
        if ([...this.mem.keys()].some(k => k.startsWith(prefix))) return makeStat('dir');
        throw makeError('ENOENT', `no such file or directory: ${path}`);
    }

    override async lstat(path: string): Promise<StatResult> {
        return this.stat(path); // no symlinks
    }

    override async exists(path: string): Promise<boolean> {
        try { await this.stat(path); return true; } catch { return false; }
    }

    override async readFile(path: string, encoding?: 'utf8'): Promise<Uint8Array | string> {
        if (devProvider.handles(path)) { const d = devProvider.readFile(path, encoding); if (d !== null) return encoding === 'utf8' && typeof d !== 'string' ? bytesToText(d) : d; throw makeError('EISDIR', `illegal operation on a directory: ${path}`); }
        const wsPath = toWsPath(path);
        if (wsPath !== null && wsPath !== '') {
            // Read the raw record so binary files (encoding='base64') return actual bytes,
            // not a text-extraction of their content.
            const rec = await readWorkspaceFile(wsPath);
            if (!rec) throw makeError('ENOENT', `no such file or directory: ${path}`);
            // As text, binary records decode with their non-UTF-8 bytes escaped (utils/bytes.ts).
            if (encoding === 'utf8') return rec.encoding === 'base64' ? bytesToText(_recordBytes(rec)) : rec.content ?? '';
            return _recordBytes(rec);
        }
        if (this.mem.has(path)) {
            const data = this.mem.get(path)!;
            return encoding === 'utf8' ? bytesToText(data) : data;
        }
        throw makeError('ENOENT', `no such file or directory: ${path}`);
    }

    override async writeFile(path: string, data: Uint8Array | string, _opts?: { mode?: number }): Promise<void> {
        if (devProvider.handles(path)) return;        // /dev/null and friends swallow writes
        const wsPath = toWsPath(path);
        const bytes = typeof data === 'string' ? textToBytes(data) : data;
        if (wsPath !== null && wsPath !== '') {
            // UTF-8 text without NULs is stored as text; anything else (binary, Latin-1 …) as
            // base64, so the bytes come back unchanged.
            if (isTextBytes(bytes)) await agentWriteFile(wsPath, dec.decode(bytes));
            else await agentWriteFile(wsPath, _bytesToBase64(bytes), 'base64');
            return;
        }
        this.mem.set(path, bytes);
    }

    override async appendFile(path: string, data: Uint8Array | string): Promise<void> {
        if (devProvider.handles(path)) return;        // /dev/null and friends swallow writes
        // Byte-level, for text and binary files alike.
        const existing = await this.readFile(path).catch(() => new Uint8Array(0)) as Uint8Array;
        const toAdd = typeof data === 'string' ? textToBytes(data) : data;
        const merged = new Uint8Array(existing.byteLength + toAdd.byteLength);
        merged.set(existing);
        merged.set(toAdd, existing.byteLength);
        await this.writeFile(path, merged);
    }

    override async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
        const dir = path.replace(/\/+$/, '') || '/';
        if (await this.exists(dir)) return;
        const parent = dir.slice(0, dir.lastIndexOf('/')) || '/';
        if (!opts?.recursive && !(await this.exists(parent))) {
            throw makeError('ENOENT', `no such file or directory: ${parent}`);
        }
        // Record the directory and, for -p, the parents it creates.
        for (let d = dir; d && d !== '/' && !(await this.exists(d)); d = d.slice(0, d.lastIndexOf('/'))) {
            this.dirs.add(d);
            if (!opts?.recursive) break;
        }
    }

    override async readdir(path: string): Promise<string[]> {
        if (path === '/dev') return devProvider.readdir(path) ?? [];
        const children = new Set<string>();
        const wsPath = toWsPath(path);

        if (wsPath !== null) {
            // Enumerate workspace files under this dir
            const prefix = wsPath ? wsPath + '/' : '';
            const all = await agentListFiles();
            for (const f of all) {
                if (!f.name.startsWith(prefix)) continue;
                const rest = f.name.slice(prefix.length);
                const seg = rest.split('/')[0];
                if (seg) children.add(seg);
            }
        } else {
            // Enumerate in-memory files under this dir
            const prefix = path.endsWith('/') ? path : path + '/';
            for (const k of this.mem.keys()) {
                if (!k.startsWith(prefix)) continue;
                const rest = k.slice(prefix.length);
                const seg = rest.split('/')[0];
                if (seg) children.add(seg);
            }
            // Add well-known virtual subdirs
            if (path === '/') {
                children.add('tmp');
                children.add('home');
                children.add('workspace');
            } else if (path === '/home') {
                children.add('user');
            }
        }
        const dirPrefix = path.endsWith('/') ? path : path + '/';
        for (const d of this.dirs) {
            if (!d.startsWith(dirPrefix)) continue;
            const seg = d.slice(dirPrefix.length).split('/')[0];
            if (seg) children.add(seg);
        }
        return [...children].sort();
    }

    override async unlink(path: string): Promise<void> {
        const wsPath = toWsPath(path);
        // The folder stays when its last file goes, as in bash (the workspace keeps only files,
        // so the shell remembers it like one made with mkdir).
        const parent = path.slice(0, path.lastIndexOf('/'));
        if (parent && parent !== WORKSPACE_MOUNT && parent !== '/tmp' && !this._isVirtualDir(parent)) this.dirs.add(parent);
        if (wsPath !== null && wsPath !== '') {
            await agentDeleteFile(wsPath);
            return;
        }
        if (!this.mem.has(path)) throw makeError('ENOENT', `no such file: ${path}`);
        this.mem.delete(path);
    }

    override async rmdir(path: string): Promise<void> {
        const entries = await this.readdir(path);
        if (entries.length > 0) throw makeError('ENOTEMPTY', `directory not empty: ${path}`);
        // Implicit dirs vanish when empty; ones made with mkdir are forgotten.
        this.dirs.delete(path);
    }

    override async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
        let st: StatResult;
        try { st = await this.stat(path); } catch { return; } // already gone
        if (st.isDirectory()) {
            if (!opts?.recursive) throw makeError('EISDIR', `is a directory: ${path}`);
            const entries = await this.readdir(path);
            await Promise.all(entries.map(e => this.rm(path + '/' + e, opts)));
            this.dirs.delete(path);
        } else {
            await this.unlink(path);
        }
    }

    override async rename(oldPath: string, newPath: string): Promise<void> {
        const st = await this.stat(oldPath);
        if (st.isDirectory()) {
            // Move every file under the directory, and the empty directories made with mkdir.
            const prefix = oldPath.replace(/\/+$/, '') + '/';
            for (const p of await this._allPaths()) {
                if (!p.startsWith(prefix) || this.dirs.has(p)) continue;
                const s2 = await this.stat(p).catch(() => null);
                if (!s2 || s2.isDirectory()) continue;
                await this.writeFile(newPath + '/' + p.slice(prefix.length), await this.readFile(p));
                await this.unlink(p);
            }
            for (const d of [...this.dirs]) {
                if (d === oldPath || d.startsWith(prefix)) { this.dirs.delete(d); this.dirs.add(newPath + d.slice(oldPath.length)); }
            }
            this.dirs.add(newPath);
            return;
        }
        const content = await this.readFile(oldPath);
        await this.writeFile(newPath, content);
        await this.unlink(oldPath);
    }

    override async chmod(path: string, mode: number): Promise<void> {
        if (mode & 0o111) this.executable.add(path); else this.executable.delete(path);
        // The workspace keeps no permissions: the execute bit lasts for the session (find -executable).
    }

    // The workspace has no links: a link is created as a copy of its target (reads work; later
    // changes to one don't show in the other).
    override async symlink(target: string, path: string): Promise<void> {
        const dir = path.slice(0, path.lastIndexOf('/')) || '/';
        const resolved = target.startsWith('/') ? target : dir + '/' + target;
        await this.writeFile(path, await this.readFile(resolved));
    }

    override async readlink(_path: string): Promise<string> {
        throw makeError('EINVAL', 'not a symbolic link');
    }

    override async glob(
        pattern: string,
        base = '/',
        opts?: { caseInsensitive?: boolean; dotglob?: boolean },
    ): Promise<string[]> {
        const allPaths = await this._allPaths();
        const regex = globPatternToRegex(pattern, base, opts?.caseInsensitive);
        return allPaths.filter(p => regex.test(p)).sort();
    }

    // ── private helpers ──────────────────────────────────────────────────────

    private _isVirtualDir(path: string): boolean {
        return ['/', '/tmp', '/home', '/home/user', WORKSPACE_MOUNT].includes(path);
    }

    private async _allPaths(): Promise<string[]> {
        const all = await agentListFiles();
        const wsPaths = all.map(f => WORKSPACE_MOUNT + '/' + f.name);
        const memPaths = [...this.mem.keys()];
        // Add canonical dirs
        const dirs = ['/', '/tmp', '/home', '/home/user', WORKSPACE_MOUNT];
        // Directories implied by file paths (the workspace stores files only).
        const implied: string[] = [];
        for (const f of [...wsPaths, ...memPaths]) {
            for (let k = f.indexOf('/', 1); k > 0; k = f.indexOf('/', k + 1)) implied.push(f.slice(0, k));
        }
        return [...new Set([...dirs, ...implied, ...wsPaths, ...memPaths, ...this.dirs])];
    }
}
