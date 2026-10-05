// exec-sandbox/entry.ts — runs agent code inside the exec sandbox frame.
//
// The frame is an <iframe sandbox="allow-scripts"> with an opaque origin (exec-sandbox-host.ts),
// so code running here can't read the app's storage, its DOM, or the dev-server token, and its
// requests to the dev server are refused as cross-origin. Three runners live here:
//   js     — execute_code in JavaScript, with fs/path over a copy of the workspace (js-run.ts)
//   bash   — the WASM shell (shiro), whose /workspace is the page's workspace (workspace-rpc.ts)
//   python — Pyodide, in a worker started from this frame (so it shares the opaque origin)
//
// Bundled into one classic script by dev-api.ts buildExecSandbox().

import './storage-shim';
import { onCall, post, pageFetch, packageCacheCall } from './channel';
import { setPackageCacheTransport } from '../shiro/wasi-packages';
import { sandboxFetch } from './net';
import { runJs } from './js-run';
import { runBash } from './bash-run';

// Everything in the frame fetches through sandboxFetch: direct, with a proxied fallback for
// plain GETs the browser refuses (net.ts).
globalThis.fetch = sandboxFetch as typeof fetch;
setPackageCacheTransport(packageCacheCall);

declare const __PYODIDE_WORKER_SRC__: string;

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
        case 'bash':
            return runBash(String(d.code ?? ''), message => post({ fg: 'progress', id: d.id, message }));
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
