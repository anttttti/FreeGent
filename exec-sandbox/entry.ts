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

import '../polyfills';
import './storage-shim';
import { onCall, post, pageFetch, packageCacheCall, workspaceCall } from './channel';
import { sandboxFetch } from './net';
import { runJs } from './js-run';

// Everything in the frame fetches through sandboxFetch: direct, with a proxied fallback for
// plain GETs the browser refuses (net.ts).
globalThis.fetch = sandboxFetch as typeof fetch;
// Separately compiled trusted bundles share this channel, including its RPC IDs.
(globalThis as any).__fgExecChannel = { workspaceCall, pageFetch, packageCacheCall };

declare const __PYODIDE_WORKER_SRC__: string;
declare const __BASH_SANDBOX_SRC__: string;
declare const __MODERN_JS_SRC__: string;

function loadTrustedBundle(source: string, name: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        script.src = url;
        const cleanup = () => { URL.revokeObjectURL(url); script.remove(); };
        script.onload = () => { const value = (globalThis as any)[name]; cleanup(); typeof value === 'function' ? resolve(value) : reject(new Error('Execution runtime did not initialize')); };
        script.onerror = () => { cleanup(); reject(new Error('Execution runtime could not load')); };
        document.head.appendChild(script);
    });
}
let bashRuntime: Promise<any> | null = null;
let modernJs: Promise<any> | null = null;
function loadModernJs(): Promise<any> {
    if (!modernJs) {
        let supported = typeof BigInt === 'function';
        try { new RegExp('(?<=a)b'); } catch { supported = false; }
        modernJs = supported ? loadTrustedBundle(__MODERN_JS_SRC__, '__fgRunJsModern').catch(() => null) : Promise.resolve(null);
    }
    return modernJs;
}
async function browserBash(code: string, onProgress: (message: string) => void) {
    if (typeof BigInt !== 'function' || typeof WebAssembly !== 'object' || typeof Worker !== 'function' || typeof DataView.prototype.getBigUint64 !== 'function' || typeof DataView.prototype.setBigUint64 !== 'function')
        throw new Error('Browser bash requires BigInt, WebAssembly and Workers. Use JavaScript or a configured local execution server on this browser.');
    await loadModernJs();
    if (!bashRuntime) bashRuntime = loadTrustedBundle(__BASH_SANDBOX_SRC__, '__fgRunBash').catch(error => { bashRuntime = null; throw error; });
    return (await bashRuntime)(code, onProgress);
}

// ── Python (Pyodide worker) ───────────────────────────────────────────────────

let pyWorker: Worker | null = null;

function startPython(): void {
    if (pyWorker) return;
    const url = URL.createObjectURL(new Blob([__PYODIDE_WORKER_SRC__], { type: 'text/javascript' }));
    try { pyWorker = new Worker(url); } catch (error) { URL.revokeObjectURL(url); throw error; }
    const ownedWorker = pyWorker;
    ownedWorker.onmessage = ({ data }) => {
        if (pyWorker !== ownedWorker) return;
        URL.revokeObjectURL(url);
        // The worker's fetch asks for a proxied plain GET when the browser refuses one
        // (pyodide-worker.ts); relay it to the page and the answer back.
        if (data?.type === 'net') {
            const w = ownedWorker;
            pageFetch(String(data.url ?? '')).then(
                value => w?.postMessage({ type: 'net-reply', id: data.id, value }, [value.body]),
                err   => w?.postMessage({ type: 'net-reply', id: data.id, error: String(err?.message ?? err) }));
            return;
        }
        post({ fg: 'event', name: 'py', data });
    };
    ownedWorker.onerror = (ev) => { URL.revokeObjectURL(url); ownedWorker.terminate(); post({ fg: 'event', name: 'py-error', data: String((ev as any).message || 'worker error') }); if (pyWorker === ownedWorker) pyWorker = null; };
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

onCall(async (d: any) => {
    switch (d.kind) {
        case 'js':
            return (await loadModernJs() || runJs)(String(d.code ?? ''), d.files ?? {});
        case 'bash':
            return browserBash(String(d.code ?? ''), message => post({ fg: 'progress', id: d.id, message }));
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
