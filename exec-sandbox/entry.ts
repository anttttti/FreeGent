// exec-sandbox/entry.ts — runs agent code inside the exec sandbox frame.
//
// The frame is an <iframe sandbox="allow-scripts"> with an opaque origin (exec-sandbox-host.ts),
// so code running here can't read the app's storage, its DOM, or the dev-server token, and its
// requests to the dev server are refused as cross-origin. Three runners live here:
//   js     — execute_code in JavaScript, with fs/path over a copy of the workspace (js-fs.ts)
//   bash   — the WASM shell (shiro), whose /workspace is the page's workspace (workspace-rpc.ts)
//   python — Pyodide, in a worker started from this frame (so it shares the opaque origin)
//
// Bundled into one classic script by dev-api.ts buildExecSandbox().

import './storage-shim';
import { onCall, post, pageFetch } from './channel';
import { sandboxFetch } from './net';
import { createWorkspaceFs, path, WORKSPACE, type WorkspaceFileData } from './js-fs';

// Everything in the frame fetches through sandboxFetch: direct, with a proxied fallback for
// plain GETs the browser refuses (net.ts).
globalThis.fetch = sandboxFetch as typeof fetch;

declare const __PYODIDE_WORKER_SRC__: string;

// ── JavaScript ────────────────────────────────────────────────────────────────

async function runJs(code: string, files: Record<string, WorkspaceFileData>) {
    const stdout: string[] = [], stderr: string[] = [];
    // The same /workspace as bash and Python (js-fs.ts). Writes and deletions made before an
    // error still apply, as they would in the shell.
    const { fs, written, deleted } = createWorkspaceFs(files);
    const require = (m: string) => {
        const name = m.replace(/^node:/, '');
        if (name === 'fs') return fs;
        if (name === 'fs/promises') return fs.promises;
        if (name === 'path') return path;
        throw new Error(`Cannot find module '${m}' — only 'fs', 'fs/promises' and 'path' are available in the browser JS sandbox`);
    };
    const con = {
        log:   (...a: any[]) => stdout.push(a.map(String).join(' ')),
        info:  (...a: any[]) => stdout.push(a.map(String).join(' ')),
        error: (...a: any[]) => stderr.push(a.map(String).join(' ')),
        warn:  (...a: any[]) => stderr.push(a.map(String).join(' ')),
    };
    const process = { env: {}, argv: ['node', 'script.js'], cwd: () => WORKSPACE, platform: 'linux' };
    const result = (extra: Record<string, any> = {}) =>
        ({ stdout: stdout.join('\n'), stderr: stderr.join('\n'), written, deleted: [...deleted], ...extra });
    try {
        // eslint-disable-next-line no-new-func
        const fn = new Function('fs', 'require', 'console', 'process', `return (async()=>{ ${code} })()`);
        await fn(fs, require, con, process);
        return result();
    } catch (e: any) {
        return result({ stderr: [...stderr, String(e?.stack || e?.message || e)].join('\n'), failed: true });
    }
}

// ── Python (Pyodide worker) ───────────────────────────────────────────────────

let pyWorker: Worker | null = null;

function startPython(): void {
    if (pyWorker) return;
    const url = URL.createObjectURL(new Blob([__PYODIDE_WORKER_SRC__], { type: 'text/javascript' }));
    pyWorker = new Worker(url);
    pyWorker.onmessage = ({ data }) => {
        // The worker's fetch asks for a proxied plain GET when the browser refuses one
        // (pyodide-worker.ts); relay it to the page and the answer back.
        if (data?.type === 'net') {
            const w = pyWorker;
            pageFetch(String(data.url ?? '')).then(
                value => w?.postMessage({ type: 'net-reply', id: data.id, value }, [value.body]),
                err   => w?.postMessage({ type: 'net-reply', id: data.id, error: String(err?.message ?? err) }));
            return;
        }
        post({ fg: 'event', name: 'py', data });
    };
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
            // shell.exec returns terminal output (\n written as \r\n); the agent gets plain lines.
            const lf = (s: string) => s.replace(/\r\n/g, '\n');
            return { stdout: lf(stdout), stderr: lf(stderr), exit_code: exitCode ?? 0 };
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
