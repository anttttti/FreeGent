// exec-sandbox-host.ts — FreeGent: the page's side of the exec sandbox.
//
// Agent code that runs in the browser (execute_code in JavaScript or Python, and the WASM bash
// shell with its node/js-eval/python commands) runs in one hidden <iframe sandbox="allow-scripts">.
// Without allow-same-origin the frame has an opaque origin: it can't read localStorage (typed API
// keys), IndexedDB (chats), the page's DOM, or the dev-server token, and the dev server refuses
// its requests. Workers it starts inherit that origin.
//
// The frame loads fg-exec-sandbox.js (exec-sandbox/entry.ts, bundled by dev-api.ts
// buildExecSandbox and served next to the app). The only things it can ask the page for are the
// workspace operations in WS_OPS — the same file access the agent's own tools have — and a
// proxied plain GET (_answerNet), the same network access fetch_url has, and a fixed public
// package cache whose keys and artifact hashes are validated before access.
//
// Not used headless: there execute_code runs through nativeExec.

import { checkFetchAllowed } from './fetch-allow.js';

const LOAD_TIMEOUT_MS = 30_000;

// Largest workspace file (stored characters; base64 for binary files) copied into a JavaScript or
// Python run. Bash reads the workspace directly and has no limit.
export const EXEC_FILE_MAX_CHARS = 10_000_000;

let frame: HTMLIFrameElement | null = null;
let ready: Promise<void> | null = null;
let boot: { frame: HTMLIFrameElement; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; onReady: (e: MessageEvent) => void } | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: any; cleanup?: () => void; onProgress?: (message: string) => void }>();
const eventListeners = new Map<string, Set<(data: any) => void>>();

// Workspace operations the frame may request (the page's bridged workspace functions).
const WS_OPS = new Set(['agentWriteFile', 'agentDeleteFile', 'agentListFiles', 'readWorkspaceFile']);

function _onMessage(e: MessageEvent): void {
    if (!frame || e.source !== frame.contentWindow) return;
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.fg === 'load-error') {
        if (boot) resetSandbox('The execution sandbox script could not load; reload the page and check the connection');
    } else if (d.fg === 'progress') {
        if (typeof d.message === 'string') pending.get(d.id)?.onProgress?.(d.message);
    } else if (d.fg === 'reply') {
        const p = pending.get(d.id);
        if (!p) return;
        pending.delete(d.id);
        clearTimeout(p.timer);
        p.cleanup?.();
        if (d.error !== undefined) p.reject(new Error(d.error)); else p.resolve(d.value);
    } else if (d.fg === 'ws') {
        void _answerWorkspace(d,frame.contentWindow!);
    } else if (d.fg === 'net') {
        void _answerNet(d,frame.contentWindow!);
    } else if (d.fg === 'package-cache') {
        void _answerPackageCache(d,frame.contentWindow!);
    } else if (d.fg === 'event') {
        for (const l of eventListeners.get(d.name) ?? []) l(d.data);
    }
}

async function _answerWorkspace(d: any, target:Window): Promise<void> {
    const reply = (msg: any) => target.postMessage({ fg: 'ws-reply', id: d.id, ...msg }, '*');
    try {
        if (!WS_OPS.has(d.op) || !Array.isArray(d.args)) throw new Error(`workspace op not allowed: ${d.op}`);
        const fn = (globalThis as any)[d.op];
        if (typeof fn !== 'function') throw new Error(`workspace op unavailable: ${d.op}`);
        reply({ value: await fn(...d.args) });
    } catch (err: any) {
        reply({ error: String(err?.message ?? err) });
    }
}

async function _answerPackageCache(d:any, target:Window): Promise<void> {
    try {
        const {handlePackageCacheRequest} = await import('./shiro/wasi-packages.js');
        const value = await handlePackageCacheRequest(d.request);
        target.postMessage({fg:'package-cache-reply',id:d.id,value},'*',value instanceof ArrayBuffer ? [value] : []);
    } catch(error:any) {
        target.postMessage({fg:'package-cache-reply',id:d.id,error:String(error?.message ?? error)},'*');
    }
}

// Network fallback for the frame (exec-sandbox/net.ts). The frame fetches directly first; its
// requests carry Origin: null, so sites that don't allow cross-origin reads refuse them. For
// those it may ask the page for a plain GET, which goes through the same proxy as fetch_url's
// plain GETs: public HTTPS addresses only, no credentials or custom headers, the proxy's rate
// limit. The page never fetches the URL itself — that would carry the page's origin (and on the
// dev server its token) — and the frame never reaches the proxy directly: the CF Worker would
// have to accept Origin: null, which any site's sandboxed iframe can send.
const NET_TIMEOUT_MS = 30_000;
const NET_MAX_BYTES  = 25 * 1024 * 1024;

async function _answerNet(d: any, target:Window): Promise<void> {
    const reply = (msg: any, transfer: Transferable[] = []) =>
        target.postMessage({ fg: 'net-reply', id: d.id, ...msg }, '*', transfer);
    try {
        const url = String(d.url ?? '');
        if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) URLs can be fetched');
        const denied = checkFetchAllowed(url);
        if (denied) throw new Error(denied);
        const proxy = typeof getEffectiveProxy === 'function' ? getEffectiveProxy() : '';
        if (!proxy) throw new Error('no fetch proxy is configured');
        const resp = await fetch(`${proxy}?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(NET_TIMEOUT_MS) });
        if (resp.headers.get('X-FG-Proxy-Error')) {
            const why = await resp.json().then(j => j?.error, () => '').catch(() => '');
            throw new Error(`the proxy refused this URL${why ? ` — ${why}` : ''}`);
        }
        if (Number(resp.headers.get('Content-Length') ?? 0) > NET_MAX_BYTES) throw new Error(`response is larger than ${NET_MAX_BYTES >> 20} MB`);
        const body = await resp.arrayBuffer();
        if (body.byteLength > NET_MAX_BYTES) throw new Error(`response is larger than ${NET_MAX_BYTES >> 20} MB`);
        reply({ value: { status: resp.status, contentType: resp.headers.get('Content-Type') ?? '', body } }, [body]);
    } catch (err: any) {
        reply({ error: String(err?.message ?? err) });
    }
}

export function sandboxScriptUrl(): string {
    return new URL('fg-exec-sandbox.js', document.baseURI).href;
}

function _ensureFrame(): Promise<void> {
    if (ready) return ready;
    window.addEventListener('message', _onMessage);
    frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    const src = sandboxScriptUrl().replace(/"/g, '&quot;');
    frame.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><script src="${src}" onerror="parent.postMessage({fg:'load-error'},'*')"></script></head><body></body></html>`;
    const ownedFrame = frame;
    ready = new Promise<void>((resolve, reject) => {
        const onReady = (e: MessageEvent) => {
            if (e.source !== ownedFrame.contentWindow || e.data?.fg !== 'ready') return;
            window.removeEventListener('message', onReady);
            clearTimeout(timer);
            if (boot?.frame === ownedFrame) boot = null;
            resolve();
        };
        const timer = setTimeout(() => {
            if (boot?.frame === ownedFrame) resetSandbox('The code sandbox did not load within 30 seconds');
        }, LOAD_TIMEOUT_MS);
        boot = { frame: ownedFrame, reject, timer, onReady };
        window.addEventListener('message', onReady);
    });
    document.body.appendChild(frame);
    return ready;
}

export function sandboxBusy(): boolean { return !!boot || pending.size > 0; }

// Tear the frame down (stuck code, or a fresh start). Pending calls fail; the next call reloads it.
export function resetSandbox(reason = 'the code sandbox was reset', errorName = 'Error'): void {
    const error = new Error(reason); error.name = errorName;
    if (boot) {
        const loading = boot; boot = null;
        clearTimeout(loading.timer);
        window.removeEventListener('message', loading.onReady);
        loading.reject(error);
    }
    for (const [, p] of pending) { clearTimeout(p.timer); p.cleanup?.(); p.reject(error); }
    pending.clear();
    for (const l of eventListeners.get('py-error') ?? []) l(reason);
    frame?.remove();
    frame = null;
    ready = null;
    window.removeEventListener('message', _onMessage);
}

export async function sandboxCall(kind: string, payload: Record<string, any> = {}, timeoutMs = 0, onProgress?: (message: string) => void, signal?: AbortSignal): Promise<any> {
    const cancelled = () => { const error = new Error('Execution cancelled'); error.name = 'AbortError'; return error; };
    if (signal?.aborted) throw cancelled();
    const start = _ensureFrame();
    if (signal) await new Promise<void>((resolve, reject) => {
        const abort = () => { resetSandbox('Execution cancelled', 'AbortError'); reject(cancelled()); };
        const cleanup = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        start.then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
        if (signal.aborted) abort();
    });
    else await start;
    if (signal?.aborted) throw cancelled();
    const id = ++seq;
    return new Promise((resolve, reject) => {
        const timer = timeoutMs > 0
            ? setTimeout(() => resetSandbox(`timed out after ${Math.round(timeoutMs / 1000)} s — the code sandbox was restarted`), timeoutMs)
            : null;
        const abort = () => resetSandbox('Execution cancelled', 'AbortError');
        const cleanup = () => signal?.removeEventListener('abort', abort);
        pending.set(id, { resolve, reject, timer, cleanup, onProgress });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        try { frame!.contentWindow!.postMessage({ fg: 'call', id, kind, ...payload }, '*'); }
        catch (error) { pending.delete(id); clearTimeout(timer); cleanup(); reject(error); }
    });
}

function _on(name: string, fn: (data: any) => void): () => void {
    if (!eventListeners.has(name)) eventListeners.set(name, new Set());
    eventListeners.get(name)!.add(fn);
    return () => eventListeners.get(name)!.delete(fn);
}

// A Worker-shaped handle for the Pyodide worker running inside the sandbox, so config.ts keeps
// its postMessage / onmessage / onerror code.
export function createSandboxedPyodideWorker(): { postMessage(msg: any): void; onmessage: ((e: { data: any }) => void) | null; onerror: ((e: any) => void) | null; terminate(): void } {
    const handle: any = { onmessage: null, onerror: null };
    const offMsg = _on('py', data => handle.onmessage?.({ data }));
    const offErr = _on('py-error', message => handle.onerror?.({ message }));
    const started = sandboxCall('py-start').catch(err => { handle.onerror?.({ message: String(err?.message ?? err) }); });
    handle.postMessage = (msg: any) => { void started.then(() => sandboxCall('py-post', { msg })).catch(err => handle.onerror?.({ message: String(err?.message ?? err) })); };
    handle.terminate = () => { offMsg(); offErr(); };
    return handle;
}
