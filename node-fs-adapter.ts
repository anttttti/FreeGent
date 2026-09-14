// node-fs-adapter.js — NodeFsAdapter: filesystem backend for agent workspace ops (Node.js only).
// Never imported by browser code. Injected via window.setWorkspaceAdapter() in the headless runner.
import { readFile, writeFile, mkdir, unlink, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import type { WorkspaceAdapter } from './workspace.js';

const _LOCAL = 'local/';
const _SKIP  = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__']);

export class NodeFsAdapter implements WorkspaceAdapter {
    constructor(root, { sidecarRoot = null, sidecarPrefixes = [] } = {}) {
        this._root = resolve(root);
        this._sidecarRoot = sidecarRoot ? resolve(sidecarRoot) : null;
        this._sidecarPrefixes = sidecarPrefixes;
    }

    _resolve(path) {
        if (path == null) throw new Error(`agentWriteFile/agentReadFile: path is required (got ${path})`);
        const rel = path.startsWith(_LOCAL) ? path.slice(_LOCAL.length) : path;
        // Absolute paths outside the workspace root (e.g. /usr/stock.log) cannot be served by
        // this adapter — they live on the container FS, not the agent workspace. Give an
        // actionable error so the model uses execute_code instead of getting a confusing
        // "file not found". Absolute paths that start with the workspace root are fine — strip
        // the prefix to normalise (avoids join('/workspace', '/workspace/x') double-nesting).
        if (rel.startsWith('/') && !rel.startsWith(this._root + '/') && !rel.startsWith(this._root)) {
            throw new Error(`Path '${path}' is an absolute container path — use execute_code(language='bash', code='cat "${path}"') to read files outside the workspace`);
        }
        const norm = rel.startsWith(this._root + '/') ? rel.slice(this._root.length + 1)
                   : rel.startsWith('/') ? rel.slice(1)
                   : rel;
        let abs: string;
        if (this._sidecarRoot && this._sidecarPrefixes.some(p => norm.startsWith(p))) {
            abs = join(this._sidecarRoot, norm);
            if (!abs.startsWith(this._sidecarRoot))
                throw new Error(`Path '${path}' escapes workspace — use a relative path`);
        } else {
            abs = join(this._root, norm);
            if (!abs.startsWith(this._root))
                throw new Error(`Path '${path}' escapes workspace — use a relative path`);
        }
        return abs;
    }

    async agentListFiles() {
        const files: Array<{name: string; size: number; lastModified: number}> = [];
        const walk  = async (dir: string, prefix: string): Promise<void> => {
            let entries;
            try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
            const subs: Promise<void>[] = [];
            const stats: Promise<void>[] = [];
            for (const e of entries) {
                if (_SKIP.has(e.name) || e.name.startsWith('.')) continue;
                const rel = prefix ? `${prefix}/${e.name}` : e.name;
                const abs = join(dir, e.name);
                if (e.isDirectory()) {
                    subs.push(walk(abs, rel));
                } else {
                    stats.push(
                        stat(abs)
                            .then(s => { files.push({ name: rel, size: s.size, lastModified: s.mtimeMs }); })
                            .catch(() => { files.push({ name: rel, size: 0, lastModified: 0 }); })
                    );
                }
            }
            if (subs.length || stats.length) await Promise.all([...subs, ...stats]);
        };
        await walk(this._root, '');
        return files;
    }

    /** Full workspace walk with _SKIP exclusions, WITHOUT stat() calls, and with a
     *  depth cap.  Used by collectWorkspacePaths() for skill-trigger matching.
     *
     *  Why the depth cap matters: a workspace like FreeGent keeps benchmark
     *  output in tmp/ (57K files at full depth).  Without the cap, all those
     *  async readdir callbacks land on the event loop concurrently with Ink's
     *  render cycle and freeze the TUI for several seconds.  maxDepth=4 still
     *  covers every realistic source-tree layout while bounding the total entry
     *  count to a few thousand regardless of how large tmp/, bench/, logs/ etc. grow.
     */
    async agentListFilesNoStat(maxDepth = 4): Promise<Array<{name: string}>> {
        const files: Array<{name: string}> = [];
        const walk  = async (dir: string, prefix: string, depth: number): Promise<void> => {
            let entries;
            try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
            const subs: Promise<void>[] = [];
            for (const e of entries) {
                if (_SKIP.has(e.name) || e.name.startsWith('.')) continue;
                const rel = prefix ? `${prefix}/${e.name}` : e.name;
                if (e.isDirectory()) {
                    if (depth < maxDepth) subs.push(walk(join(dir, e.name), rel, depth + 1));
                } else {
                    files.push({ name: rel });
                }
            }
            if (subs.length) await Promise.all(subs);
        };
        await walk(this._root, '', 0);
        return files;
    }

    /** Scan a single subdirectory without stat() calls — used by loadSkills() to
     *  avoid a full workspace walk (64K files × per-tick JSDOM overhead = ~5 s). */
    async agentListFilesInDir(dir: string): Promise<Array<{name: string}>> {
        const root  = join(this._root, dir);
        const files: Array<{name: string}> = [];
        const walk  = async (d: string, prefix: string): Promise<void> => {
            let entries;
            try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
            const subs: Promise<void>[] = [];
            for (const e of entries) {
                if (e.name.startsWith('.')) continue;
                const rel = prefix ? `${prefix}/${e.name}` : e.name;
                if (e.isDirectory()) subs.push(walk(join(d, e.name), rel));
                else files.push({ name: rel });
            }
            if (subs.length) await Promise.all(subs);
        };
        await walk(root, '');
        return files;
    }

    async agentReadFile(path) {
        const abs = this._resolve(path);
        if (/\.(odt|ods|odp|odf|docx|xlsx|pptx)$/i.test(abs)) {
            const _py = [
                'import zipfile,sys,re',
                'try:',
                ' z=zipfile.ZipFile(sys.argv[1])',
                ' n=z.namelist()',
                " cands=['content.xml','word/document.xml']+[x for x in n if x.endswith('/content.xml') or x.startswith('xl/')]",
                " t=[re.sub(r'<[^>]+>',' ',z.read(f).decode('utf-8','ignore')) for f in cands if f in n]",
                " print((re.sub(r'\\s+',' ',' '.join(t)).strip() or '[no text in archive]')[:100000])",
                'except Exception as e:',
                " print('[doc extract failed: '+str(e)+']')",
            ].join('\n');
            const text = await new Promise<string>((res) => {
                execFile('python3', ['-c', _py, abs], { maxBuffer: 10_000_000 },
                    (err, stdout) => res(err ? '' : stdout));
            });
            if (text.trim() && !text.startsWith('[doc extract failed')) return text;
        }
        let buf: Buffer;
        try {
            buf = await readFile(abs);
        } catch {
            throw new Error(`File not found: ${path}`);
        }
        const probe = buf.slice(0, 512);
        if (probe.includes(0)) {
            const magic = probe.slice(0, 5).toString('ascii');
            const hint = magic.startsWith('%PDF-')
                ? `Use execute_code(language='bash', code='pdftotext "${path}" -') to extract text.`
                : `Use execute_code(language='bash', code='file "${path}"') to identify the format.`;
            throw new Error(`Binary file — cannot read as text: ${path}. ${hint}`);
        }
        return buf.toString('utf8');
    }

    async agentWriteFile(path, content, encoding = null) {
        const abs = this._resolve(path);
        await mkdir(dirname(abs), { recursive: true });
        if (encoding === 'base64') {
            await writeFile(abs, Buffer.from(content ?? '', 'base64'));
        } else {
            await writeFile(abs, content ?? '', 'utf8');
        }
    }

    async agentDeleteFile(path) {
        try {
            await unlink(this._resolve(path));
        } catch (e) {
            throw new Error(`Cannot delete: ${path}`);
        }
    }

    async agentFileMtime(path: string): Promise<number | null> {
        try { return (await stat(this._resolve(path))).mtimeMs; } catch { return null; }
    }
}

// DockerFsAdapter — routes read_file/write_file/list_files/delete_file into a running Docker container
// via `docker exec`. Used by Terminal-Bench so the agent's file tools operate on the task container
// instead of the FreeGent container's local workspace.
export class DockerFsAdapter implements WorkspaceAdapter {
    private _ctr: string;
    constructor(ctr: string) { this._ctr = ctr; }

    async agentReadFile(path: string): Promise<string> {
        const esc = path.replace(/'/g, "'\\''");
        if (/\.(odt|ods|odp|odf|docx|xlsx|pptx)$/i.test(path)) {
            const _py = [
                'import zipfile,re',
                `try:`,
                ` z=zipfile.ZipFile(${JSON.stringify(path)})`,
                ` n=z.namelist()`,
                ` cands=['content.xml','word/document.xml']+[x for x in n if x.endswith('/content.xml') or x.startswith('xl/')]`,
                ` t=[re.sub(r'<[^>]+>',' ',z.read(f).decode('utf-8','ignore')) for f in cands if f in n]`,
                ` print((re.sub(r'\\s+',' ',' '.join(t)).strip() or '[no text in archive]')[:100000])`,
                'except Exception as e:',
                ` print('[doc extract failed: '+str(e)+']')`,
            ].join('\n');
            const text = await new Promise<string>((res) => {
                execFile('docker', ['exec', this._ctr, 'python3', '-c', _py],
                    { maxBuffer: 10_000_000 },
                    (err, stdout) => res(err ? '' : stdout));
            });
            if (text.trim() && !text.startsWith('[doc extract failed')) return text;
        }
        return new Promise((resolve, reject) => {
            execFile('docker', ['exec', this._ctr, 'bash', '-c', `cat '${esc}'`],
                { maxBuffer: 10_000_000, encoding: 'buffer' },
                (err, stdout) => {
                    if (err) { reject(new Error(`File not found in container: ${path}`)); return; }
                    const probe = (stdout as unknown as Buffer).slice(0, 512);
                    if (probe.includes(0)) {
                        const magic = probe.slice(0, 5).toString('ascii');
                        const hint = magic.startsWith('%PDF-')
                            ? `Use execute_code(language='bash', code='pdftotext "${path}" -') to extract text.`
                            : `Use execute_code(language='bash', code='file "${path}"') to identify the format.`;
                        reject(new Error(`Binary file — cannot read as text: ${path}. ${hint}`)); return;
                    }
                    resolve((stdout as unknown as Buffer).toString('utf8'));
                });
        });
    }

    async agentWriteFile(path: string, content: string, encoding: string | null = null): Promise<void> {
        const esc = path.replace(/'/g, "'\\''");
        return new Promise((resolve, reject) => {
            const child = execFile('docker', ['exec', '-i', this._ctr, 'bash', '-c',
                `mkdir -p "$(dirname '${esc}')" && tee '${esc}' > /dev/null`],
                (err) => err
                    ? reject(new Error(`write to container failed: ${err.message}`))
                    : resolve());
            if (encoding === 'base64') {
                child.stdin?.write(Buffer.from(content ?? '', 'base64'));
            } else {
                child.stdin?.write(content, 'utf8');
            }
            child.stdin?.end();
        });
    }

    async agentListFiles(): Promise<Array<{name: string, size: number, lastModified: number}>> {
        return new Promise((resolve) => {
            execFile('docker', ['exec', this._ctr, 'bash', '-c',
                'find /app /home /root /workspace /opt 2>/dev/null | head -500'],
                (err, stdout) => {
                    if (err) { resolve([]); return; }
                    const names = stdout.split('\n').filter(Boolean);
                    const files = names.map(f => ({ name: f, size: 0, lastModified: Date.now() }));
                    // The listing only covers fixed roots and caps at 500 entries — tell
                    // the agent instead of letting it assume the listing is complete.
                    if (names.length >= 500)
                        files.push({ name: '[listing truncated at 500 entries — use execute_code bash `find` or `ls` for full coverage]', size: 0, lastModified: Date.now() });
                    resolve(files);
                });
        });
    }

    async agentDeleteFile(path: string): Promise<void> {
        const esc = path.replace(/'/g, "'\\''");
        return new Promise((resolve, reject) => {
            execFile('docker', ['exec', this._ctr, 'bash', '-c', `rm -f '${esc}'`],
                (err) => err ? reject(err) : resolve());
        });
    }

    async agentFileMtime(path: string): Promise<number | null> {
        const esc = path.replace(/'/g, "'\\''");
        return new Promise(resolve => {
            // stat -c %Y prints mtime as seconds since epoch; multiply to get ms.
            execFile('docker', ['exec', this._ctr, 'bash', '-c', `stat -c %Y '${esc}'`],
                (err, stdout) => resolve(err ? null : (parseInt(stdout.trim(), 10) * 1000) || null));
        });
    }
}
