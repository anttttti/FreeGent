import { base64ToBytes } from '../shiro/utils/bytes.js';
import { fsError as makeFsError } from '../shiro/utils/errors.js';
// exec-sandbox/js-fs.ts — the `fs` and `path` modules for execute_code JavaScript.
//
// The same /workspace the bash shell and Python see: the working directory is /workspace, and
// paths resolve like there — "a.txt", "./a.txt" and "/workspace/a.txt" are the same file.
// The page sends a copy of the workspace files with each run and applies `written` and
// `deleted` afterwards. Paths outside /workspace (/tmp/…) are scratch space for the run.

export const WORKSPACE = '/workspace';

const posix = {
    normalize(p: string): string {
        const abs = p.startsWith('/');
        const out: string[] = [];
        for (const seg of p.split('/')) {
            if (!seg || seg === '.') continue;
            if (seg === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); continue; }
            out.push(seg);
        }
        const joined = (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
        return p.endsWith('/') && !joined.endsWith('/') ? joined + '/' : joined;   // Node keeps a trailing /
    },
    resolve(...parts: string[]): string {
        let p = '';
        for (const part of parts) p = part.startsWith('/') ? part : (p ? `${p}/${part}` : part);
        return posix.normalize(p.startsWith('/') ? p : `${WORKSPACE}/${p}`).replace(/(.)\/$/, '$1');   // no trailing /
    },
};

export const path = {
    sep: '/',
    normalize: posix.normalize,
    resolve: posix.resolve,
    join:     (...a: string[]) => posix.normalize(a.filter(Boolean).join('/')),
    dirname:  (p: string) => { const n = posix.normalize(p); const i = n.lastIndexOf('/'); return i > 0 ? n.slice(0, i) : i === 0 ? '/' : '.'; },
    basename: (p: string, e?: string) => { const b = posix.normalize(p).split('/').pop()!; return e && b.endsWith(e) ? b.slice(0, -e.length) : b; },
    extname:  (p: string) => { const m = path.basename(p).match(/.(\.[^.]+)$/); return m ? m[1] : ''; },
    isAbsolute: (p: string) => p.startsWith('/'),
    relative: (from: string, to: string) => {
        const a = posix.resolve(from).split('/').filter(Boolean), b = posix.resolve(to).split('/').filter(Boolean);
        let k = 0; while (k < a.length && a[k] === b[k]) k++;
        return [...a.slice(k).map(() => '..'), ...b.slice(k)].join('/');
    },
};

function fsError(code: string, op: string, p: string): Error {
    const what = code === 'ENOENT' ? 'no such file or directory' : code === 'EISDIR' ? 'illegal operation on a directory' : 'operation failed';
    return makeFsError(code, `${code}: ${what}, ${op} '${p}'`, op, p);
}

/** A workspace file as the page sends it: text, or binary as base64. */
export type WorkspaceFileData = string | { base64: string };
type Content = string | Uint8Array;

const fromBase64 = base64ToBytes;

/**
 * Buffer stands in for Node's Buffer (shiro/node-compat/buffer.ts in the sandbox): reads without
 * an encoding return one, as in Node. Without it they return plain Uint8Arrays.
 */
export function createWorkspaceFs(sent: Record<string, WorkspaceFileData>, Buffer?: { from(data: any, enc?: string): Uint8Array & { toString(enc?: string): string } }) {
    const files: Record<string, Content> = {};
    for (const [name, v] of Object.entries(sent)) files[name] = typeof v === 'string' ? v : fromBase64(v.base64);
    const written: Record<string, Content> = {};
    const deleted = new Set<string>();
    const scratch = new Map<string, Content>();    // outside /workspace: this run only
    const dirs = new Set<string>();                 // made with mkdirSync

    // Absolute path → workspace-relative name, or null when outside /workspace.
    const wsName = (abs: string) => abs === WORKSPACE ? '' : abs.startsWith(WORKSPACE + '/') ? abs.slice(WORKSPACE.length + 1) : null;
    const get = (p: string) => {
        const abs = posix.resolve(p), name = wsName(abs);
        return name === null ? scratch.get(abs) : files[name];
    };
    const put = (p: string, content: Content) => {
        const abs = posix.resolve(p), name = wsName(abs);
        // As in Node: the directory must exist (mkdirSync first). Writing anyway made it appear.
        const dir = abs.slice(0, abs.lastIndexOf('/')) || '/';
        if (!isDir(dir)) throw fsError('ENOENT', 'open', p);
        if (name === null) { scratch.set(abs, content); return; }
        if (name === '') throw fsError('EISDIR', 'open', p);
        files[name] = content; written[name] = content; deleted.delete(name);
    };
    const keys = () => [...Object.keys(files).map(n => `${WORKSPACE}/${n}`), ...scratch.keys(), ...dirs];
    const isDir = (p: string) => {
        const abs = posix.resolve(p);
        return abs === WORKSPACE || abs === '/' || abs === '/tmp' || dirs.has(abs) || keys().some(k => k.startsWith(abs + '/'));
    };
    const toText = (c: any) => typeof c === 'string' ? c : ArrayBuffer.isView(c) ? new TextDecoder().decode(c) : String(c);
    const bytesOf = (c: Content) => typeof c === 'string' ? new TextEncoder().encode(c) : c;
    const size = (c: Content) => bytesOf(c).length;
    const encodingOf = (o: any): string | undefined => typeof o === 'string' ? o : o?.encoding ?? undefined;
    const isUtf8 = (e: string) => /^utf-?8$/i.test(e);
    // Written data as stored: a string in a non-UTF-8 encoding ('base64', 'hex', 'latin1' …) and
    // typed arrays become bytes, other strings stay text.
    const toContent = (c: any, enc?: string): Content =>
        typeof c === 'string' ? (enc && !isUtf8(enc) && Buffer ? new Uint8Array(Buffer.from(c, enc)) : c)
            : c instanceof Uint8Array ? c : ArrayBuffer.isView(c) ? new Uint8Array(c.buffer, c.byteOffset, c.byteLength) : toText(c);

    const stored = (p: string): Content => {
        const c = get(p);
        if (c === undefined) throw fsError(isDir(p) ? 'EISDIR' : 'ENOENT', 'open', p);
        return c;
    };
    const fs = {
        // As in Node: bytes (a Buffer) without an encoding, text with one.
        readFileSync(p: string, opts?: any): any {
            const c = get(p);
            if (c === undefined) throw fsError(isDir(p) ? 'EISDIR' : 'ENOENT', 'open', p);
            const enc = encodingOf(opts);
            if (!enc) return Buffer ? Buffer.from(bytesOf(c)) : bytesOf(c);
            if (isUtf8(enc)) return toText(c);
            return Buffer ? Buffer.from(bytesOf(c)).toString(enc) : toText(c);
        },
        writeFileSync(p: string, c: any, opts?: any) { put(p, toContent(c, encodingOf(opts))); },
        appendFileSync(p: string, c: any, opts?: any) {
            const was = get(p) ?? '', add = toContent(c, encodingOf(opts));
            if (typeof was === 'string' && typeof add === 'string') { put(p, was + add); return; }
            const a = bytesOf(was), b = bytesOf(add), all = new Uint8Array(a.length + b.length);
            all.set(a); all.set(b, a.length);
            put(p, all);
        },
        existsSync(p: string) { return get(p) !== undefined || isDir(p); },
        readdirSync(p: string = '.') {
            if (!isDir(p)) throw fsError('ENOENT', 'scandir', p);
            const pre = posix.resolve(p).replace(/\/?$/, '/');
            return [...new Set(keys().filter(k => k.startsWith(pre)).map(k => k.slice(pre.length).split('/')[0]).filter(Boolean))].sort();
        },
        statSync(p: string) {
            const c = get(p), dir = c === undefined && isDir(p);
            if (c === undefined && !dir) throw fsError('ENOENT', 'stat', p);
            return { size: c === undefined ? 0 : size(c), isFile: () => !dir, isDirectory: () => dir, mtime: new Date(), mtimeMs: Date.now() };
        },
        mkdirSync(p: string, _opts?: any) { dirs.add(posix.resolve(p)); },
        unlinkSync(p: string) {
            const abs = posix.resolve(p), name = wsName(abs);
            if (get(p) === undefined) throw fsError('ENOENT', 'unlink', p);
            if (name === null) { scratch.delete(abs); return; }
            delete files[name]; delete written[name]; deleted.add(name);
        },
        rmSync(p: string, opts?: { recursive?: boolean; force?: boolean }) {
            if (get(p) !== undefined) return fs.unlinkSync(p);
            if (isDir(p) && opts?.recursive) {
                const pre = posix.resolve(p) + '/';
                for (const k of keys()) if (k.startsWith(pre) && get(k) !== undefined) fs.unlinkSync(k);
                for (const d of [...dirs]) if (d === pre.slice(0, -1) || d.startsWith(pre)) dirs.delete(d);
                return;
            }
            if (!opts?.force) throw fsError('ENOENT', 'rm', p);
        },
        // The stored content as is: a text file stays text.
        renameSync(from: string, to: string) {
            const c = stored(from);
            if (posix.resolve(from) === posix.resolve(to)) return;
            put(to, c);   // first: when the target can't be written, the source stays
            fs.unlinkSync(from);
        },
        copyFileSync(from: string, to: string) { put(to, stored(from)); },
    };
    const promises = Object.fromEntries(Object.entries(fs).map(([k, f]) =>
        [k.replace(/Sync$/, ''), async (...a: any[]) => (f as any)(...a)]));
    return { fs: { ...fs, promises }, written, deleted };
}
