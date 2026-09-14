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

import { FileSystem, globPatternToRegex } from './filesystem';
import type { StatResult } from './filesystem';
import {
    agentWriteFile,
    agentDeleteFile,
    agentListFiles,
    readWorkspaceFile,
} from '../workspace';

// ── constants ────────────────────────────────────────────────────────────────

export const WORKSPACE_MOUNT = '/workspace';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** True when a Uint8Array contains null bytes — definitive sign of binary content.
 *  UTF-8 text never contains 0x00; binary formats (ZIP/XLSX/PDF/PNG…) always do. */
function _hasBinaryBytes(data: Uint8Array): boolean {
    const probe = data.subarray(0, 8192);
    return probe.includes(0);
}

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

function makeStat(type: 'file' | 'dir', size = 0, mtime = Date.now()): StatResult {
    const mt = new Date(mtime);
    return {
        type,
        mode: type === 'dir' ? 0o755 : 0o644,
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

    /** Skip Shiro's IDB init — FreeGent workspace is already ready. */
    override async init(): Promise<void> {
        // Ensure basic in-memory dirs exist (stat() checks will succeed)
        // No actual IDB needed.
    }

    override async stat(path: string): Promise<StatResult> {
        const wsPath = toWsPath(path);
        if (wsPath !== null) {
            if (wsPath === '') return makeStat('dir'); // workspace root
            // Use readWorkspaceFile directly (agentReadFile runs text extraction on binary
            // files, returning the wrong size and potentially throwing for non-doc binaries).
            const rec = await readWorkspaceFile(wsPath).catch(() => null);
            if (rec !== null && rec !== undefined) {
                // Binary files stored as base64: approximate decoded byte count (0.75 × base64 chars)
                const size = rec.encoding === 'base64'
                    ? Math.round((rec.content as string).length * 0.75)
                    : (rec.content as string ?? '').length;
                return makeStat('file', size);
            }
            // Not a file — check if it is an implicit directory (has child entries)
            const prefix = wsPath + '/';
            const all = await agentListFiles();
            if (all.some(f => f.name.startsWith(prefix))) {
                return makeStat('dir');
            }
            throw makeError('ENOENT', `no such file or directory: ${path}`);
        }
        // In-memory
        if (this.mem.has(path)) {
            return makeStat('file', this.mem.get(path)!.byteLength);
        }
        // Virtual dirs: /, /tmp, /home, /home/user, /workspace
        if (this._isVirtualDir(path)) return makeStat('dir');
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
        const wsPath = toWsPath(path);
        if (wsPath !== null && wsPath !== '') {
            // Read the raw record so binary files (encoding='base64') return actual bytes,
            // not a text-extraction of their content.
            const rec = await readWorkspaceFile(wsPath);
            if (!rec) throw makeError('ENOENT', `no such file or directory: ${path}`);
            if (rec.encoding === 'base64') {
                // Decode base64 → Uint8Array for binary workspace files.
                // Use _base64ToBytes (robust against interior '=' from legacy chunked encoding).
                return encoding === 'utf8' ? rec.content as string : _base64ToBytes(rec.content as string);
            }
            const content = rec.content as string ?? '';
            if (encoding === 'utf8') return content;
            return enc.encode(content);
        }
        if (this.mem.has(path)) {
            const data = this.mem.get(path)!;
            return encoding === 'utf8' ? dec.decode(data) : data;
        }
        throw makeError('ENOENT', `no such file or directory: ${path}`);
    }

    override async writeFile(path: string, data: Uint8Array | string, _opts?: { mode?: number }): Promise<void> {
        const wsPath = toWsPath(path);
        if (wsPath !== null && wsPath !== '') {
            if (typeof data === 'string') {
                await agentWriteFile(wsPath, data);
            } else if (_hasBinaryBytes(data)) {
                // Binary content (null bytes → not valid UTF-8 text) — persist as base64.
                // Use _bytesToBase64 (no chunking → no interior '=' → atob round-trips correctly).
                await agentWriteFile(wsPath, _bytesToBase64(data), 'base64');
            } else {
                // Safe UTF-8 text delivered as Uint8Array (e.g. from shell echo)
                await agentWriteFile(wsPath, dec.decode(data));
            }
            return;
        }
        this.mem.set(path, typeof data === 'string' ? enc.encode(data) : data);
    }

    override async appendFile(path: string, data: Uint8Array | string): Promise<void> {
        const wsPath = toWsPath(path);
        if (wsPath !== null && wsPath !== '') {
            // Read the raw record so appending to a text workspace file doesn't corrupt it.
            // Appending to a binary workspace file is not meaningful (binary formats require
            // proper serialization) so binary files are left untouched.
            const rec = await readWorkspaceFile(wsPath).catch(() => null);
            if (rec?.encoding === 'base64') {
                // Don't corrupt a binary file with a text append — no-op for binary workspace files.
                return;
            }
            const existing = rec?.content as string ?? '';
            const addition = typeof data === 'string' ? data : dec.decode(data);
            await agentWriteFile(wsPath, existing + addition);
            return;
        }
        const existing = this.mem.get(path) ?? new Uint8Array(0);
        const toAdd = typeof data === 'string' ? enc.encode(data) : data;
        const merged = new Uint8Array(existing.byteLength + toAdd.byteLength);
        merged.set(existing);
        merged.set(toAdd, existing.byteLength);
        this.mem.set(path, merged);
    }

    override async mkdir(_path: string, _opts?: { recursive?: boolean }): Promise<void> {
        // Workspace dirs are implicit in file paths; mem dirs are also implicit.
        // No-op (compatible with all callers that ignore the return value).
    }

    override async readdir(path: string): Promise<string[]> {
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
        return [...children].sort();
    }

    override async unlink(path: string): Promise<void> {
        const wsPath = toWsPath(path);
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
        // Virtual/implicit dirs vanish when empty — nothing to persist.
    }

    override async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
        let st: StatResult;
        try { st = await this.stat(path); } catch { return; } // already gone
        if (st.isDirectory()) {
            if (!opts?.recursive) throw makeError('EISDIR', `is a directory: ${path}`);
            const entries = await this.readdir(path);
            await Promise.all(entries.map(e => this.rm(path + '/' + e, opts)));
        } else {
            await this.unlink(path);
        }
    }

    override async rename(oldPath: string, newPath: string): Promise<void> {
        const content = await this.readFile(oldPath);
        await this.writeFile(newPath, content);
        await this.unlink(oldPath);
    }

    override async chmod(_path: string, _mode: number): Promise<void> {
        // FreeGent workspace has no Unix permissions — no-op.
    }

    override async symlink(_target: string, _path: string): Promise<void> {
        throw makeError('EPERM', 'symlinks not supported by FreeGent workspace');
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
        return [...new Set([...dirs, ...wsPaths, ...memPaths])];
    }
}
