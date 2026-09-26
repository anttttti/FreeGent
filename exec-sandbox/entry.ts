// exec-sandbox/entry.ts — runs agent code inside the exec sandbox frame.
//
// The frame is an <iframe sandbox="allow-scripts"> with an opaque origin (exec-sandbox-host.ts),
// so code running here can't read the app's storage, its DOM, or the dev-server token, and its
// requests to the dev server are refused as cross-origin. Three runners live here:
//   js     — execute_code in JavaScript, with a small fs/path shim over a copy of the files
//   bash   — the WASM shell (shiro), whose /workspace is the page's workspace (workspace-rpc.ts)
//   python — Pyodide, in a worker started from this frame (so it shares the opaque origin)
//
// Bundled into one classic script by dev-api.ts buildExecSandbox().

import './storage-shim';
import { onCall, post } from './channel';

declare const __PYODIDE_WORKER_SRC__: string;

// ── JavaScript ────────────────────────────────────────────────────────────────

async function runJs(code: string, files: Record<string, string>) {
    const written: Record<string, string> = {};
    const stdout: string[] = [], stderr: string[] = [];
    const norm = (p: string) => p.replace(/^\.\//, '');
    const fs = {
        readFileSync:  (p: string, _enc?: any) => {
            const k = norm(p);
            if (!(k in files)) { const e: any = new Error(`ENOENT: no such file or directory, open '${p}'`); e.code = 'ENOENT'; throw e; }
            return files[k];
        },
        writeFileSync: (p: string, c: any) => { const k = norm(p); written[k] = typeof c === 'string' ? c : String(c); files[k] = written[k]; },
        appendFileSync:(p: string, c: any) => { const k = norm(p); written[k] = (files[k] ?? '') + c; files[k] = written[k]; },
        existsSync:    (p: string) => norm(p) in files,
        readdirSync:   (p: string) => {
            const pre = (p === '.' || p === '') ? '' : p.replace(/\/?$/, '/');
            return [...new Set(Object.keys(files).filter(f => f.startsWith(pre)).map(f => f.slice(pre.length).split('/')[0]).filter(Boolean))];
        },
    };
    const path = {
        join:     (...a: string[]) => a.join('/').replace(/\/+/g, '/').replace(/\/$/, '') || '.',
        dirname:  (p: string) => p.includes('/') ? p.split('/').slice(0, -1).join('/') || '/' : '.',
        basename: (p: string, e?: string) => { const b = p.split('/').pop()!; return e && b.endsWith(e) ? b.slice(0, -e.length) : b; },
        extname:  (p: string) => { const m = p.match(/\.[^./]+$/); return m ? m[0] : ''; },
        resolve:  (...a: string[]) => a.join('/').replace(/\/+/g, '/'),
    };
    const require = (m: string) => {
        if (m === 'fs') return fs;
        if (m === 'path') return path;
        throw new Error(`Cannot find module '${m}' — only 'fs' and 'path' are available in the browser JS sandbox`);
    };
    const con = {
        log:   (...a: any[]) => stdout.push(a.map(String).join(' ')),
        info:  (...a: any[]) => stdout.push(a.map(String).join(' ')),
        error: (...a: any[]) => stderr.push(a.map(String).join(' ')),
        warn:  (...a: any[]) => stderr.push(a.map(String).join(' ')),
    };
    try {
        // eslint-disable-next-line no-new-func
        const fn = new Function('fs', 'require', 'console', 'process', `return (async()=>{ ${code} })()`);
        await fn(fs, require, con, { env: {}, argv: ['node', 'script.js'], cwd: () => '.' });
        return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), written };
    } catch (e: any) {
        return { stdout: stdout.join('\n'), stderr: String(e?.stack || e?.message || e), written: {}, failed: true };
    }
}

// ── Python (Pyodide worker) ───────────────────────────────────────────────────

let pyWorker: Worker | null = null;

function startPython(): void {
    if (pyWorker) return;
    const url = URL.createObjectURL(new Blob([__PYODIDE_WORKER_SRC__], { type: 'text/javascript' }));
    pyWorker = new Worker(url);
    pyWorker.onmessage = ({ data }) => post({ fg: 'event', name: 'py', data });
    pyWorker.onerror = (ev) => { post({ fg: 'event', name: 'py-error', data: String((ev as any).message || 'worker error') }); pyWorker = null; };
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

onCall(async (d: any) => {
    switch (d.kind) {
        case 'js':
            return runJs(String(d.code ?? ''), d.files ?? {});
        case 'bash': {
            const { getShell } = await import('../shiro/shell-singleton');
            const shell = await getShell();
            const { stdout, stderr, exitCode } = await shell.exec(String(d.code ?? ''));
            return { stdout, stderr, exit_code: exitCode ?? 0 };
        }
        case 'py-start':
            startPython();
            return true;
        case 'py-post':
            if (!pyWorker) throw new Error('Pyodide worker is not running');
            pyWorker.postMessage(d.msg);
            return true;
        default:
            throw new Error(`unknown sandbox call: ${d.kind}`);
    }
});

post({ fg: 'ready' });
