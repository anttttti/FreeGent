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
        return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
    },
    resolve(...parts: string[]): string {
        let p = '';
        for (const part of parts) p = part.startsWith('/') ? part : (p ? `${p}/${part}` : part);
        return posix.normalize(p.startsWith('/') ? p : `${WORKSPACE}/${p}`);
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
    const e: any = new Error(`${code}: ${code === 'ENOENT' ? 'no such file or directory' : code === 'EISDIR' ? 'illegal operation on a directory' : 'operation failed'}, ${op} '${p}'`);
    e.code = code;
    return e;
}

export function createWorkspaceFs(files: Record<string, string>) {
    const written: Record<string, string> = {};
    const deleted = new Set<string>();
    const scratch = new Map<string, string>();     // outside /workspace: this run only
    const dirs = new Set<string>();                 // made with mkdirSync

    // Absolute path → workspace-relative name, or null when outside /workspace.
    const wsName = (abs: string) => abs === WORKSPACE ? '' : abs.startsWith(WORKSPACE + '/') ? abs.slice(WORKSPACE.length + 1) : null;
    const get = (p: string) => {
        const abs = posix.resolve(p), name = wsName(abs);
        return name === null ? scratch.get(abs) : files[name];
    };
    const put = (p: string, content: string) => {
        const abs = posix.resolve(p), name = wsName(abs);
        if (name === null) { scratch.set(abs, content); return; }
        if (name === '') throw fsError('EISDIR', 'open', p);
        files[name] = content; written[name] = content; deleted.delete(name);
    };
    const keys = () => [...Object.keys(files).map(n => `${WORKSPACE}/${n}`), ...scratch.keys(), ...dirs];
    const isDir = (p: string) => {
        const abs = posix.resolve(p);
        return abs === WORKSPACE || abs === '/' || dirs.has(abs) || keys().some(k => k.startsWith(abs + '/'));
    };
    const toText = (c: any) => typeof c === 'string' ? c : c instanceof Uint8Array ? new TextDecoder().decode(c) : String(c);

    const fs = {
        readFileSync(p: string, _enc?: any): string {
            const c = get(p);
            if (c === undefined) throw fsError(isDir(p) ? 'EISDIR' : 'ENOENT', 'open', p);
            return c;
        },
        writeFileSync(p: string, c: any) { put(p, toText(c)); },
        appendFileSync(p: string, c: any) { put(p, (get(p) ?? '') + toText(c)); },
        existsSync(p: string) { return get(p) !== undefined || isDir(p); },
        readdirSync(p: string = '.') {
            if (!isDir(p)) throw fsError('ENOENT', 'scandir', p);
            const pre = posix.resolve(p).replace(/\/?$/, '/');
            return [...new Set(keys().filter(k => k.startsWith(pre)).map(k => k.slice(pre.length).split('/')[0]).filter(Boolean))].sort();
        },
        statSync(p: string) {
            const c = get(p), dir = c === undefined && isDir(p);
            if (c === undefined && !dir) throw fsError('ENOENT', 'stat', p);
            return { size: c?.length ?? 0, isFile: () => !dir, isDirectory: () => dir, mtime: new Date(), mtimeMs: Date.now() };
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
        renameSync(from: string, to: string) { const c = fs.readFileSync(from); fs.unlinkSync(from); put(to, c); },
        copyFileSync(from: string, to: string) { put(to, fs.readFileSync(from)); },
    };
    const promises = Object.fromEntries(Object.entries(fs).map(([k, f]) =>
        [k.replace(/Sync$/, ''), async (...a: any[]) => (f as any)(...a)]));
    return { fs: { ...fs, promises }, written, deleted };
}
