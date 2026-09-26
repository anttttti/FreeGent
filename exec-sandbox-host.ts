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
// workspace operations in WS_OPS — the same file access the agent's own tools have.
//
// Not used headless: there execute_code runs through nativeExec.

const LOAD_TIMEOUT_MS = 30_000;

let frame: HTMLIFrameElement | null = null;
let ready: Promise<void> | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: any }>();
const eventListeners = new Map<string, Set<(data: any) => void>>();

// Workspace operations the frame may request (the page's bridged workspace functions).
const WS_OPS = new Set(['agentWriteFile', 'agentDeleteFile', 'agentListFiles', 'readWorkspaceFile']);

function _onMessage(e: MessageEvent): void {
    if (!frame || e.source !== frame.contentWindow) return;
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.fg === 'reply') {
        const p = pending.get(d.id);
        if (!p) return;
        pending.delete(d.id);
        clearTimeout(p.timer);
        if (d.error !== undefined) p.reject(new Error(d.error)); else p.resolve(d.value);
    } else if (d.fg === 'ws') {
        void _answerWorkspace(d);
    } else if (d.fg === 'event') {
        for (const l of eventListeners.get(d.name) ?? []) l(d.data);
    }
}

async function _answerWorkspace(d: any): Promise<void> {
    const reply = (msg: any) => frame?.contentWindow?.postMessage({ fg: 'ws-reply', id: d.id, ...msg }, '*');
    try {
        if (!WS_OPS.has(d.op) || !Array.isArray(d.args)) throw new Error(`workspace op not allowed: ${d.op}`);
        const fn = (globalThis as any)[d.op];
        if (typeof fn !== 'function') throw new Error(`workspace op unavailable: ${d.op}`);
        reply({ value: await fn(...d.args) });
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
    frame.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><script src="${src}"></script></head><body></body></html>`;
    ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error('the code sandbox did not load')); resetSandbox(); }, LOAD_TIMEOUT_MS);
        const onReady = (e: MessageEvent) => {
            if (!frame || e.source !== frame.contentWindow || e.data?.fg !== 'ready') return;
            window.removeEventListener('message', onReady);
            clearTimeout(timer);
            resolve();
        };
        window.addEventListener('message', onReady);
    });
    document.body.appendChild(frame);
    return ready;
}

// Tear the frame down (stuck code, or a fresh start). Pending calls fail; the next call reloads it.
export function resetSandbox(reason = 'the code sandbox was reset'): void {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    pending.clear();
    for (const l of eventListeners.get('py-error') ?? []) l(reason);
    frame?.remove();
    frame = null;
    ready = null;
    window.removeEventListener('message', _onMessage);
}

export async function sandboxCall(kind: string, payload: Record<string, any> = {}, timeoutMs = 0): Promise<any> {
    await _ensureFrame();
    const id = ++seq;
    return new Promise((resolve, reject) => {
        const timer = timeoutMs > 0
            ? setTimeout(() => resetSandbox(`timed out after ${Math.round(timeoutMs / 1000)} s — the code sandbox was restarted`), timeoutMs)
            : null;
        pending.set(id, { resolve, reject, timer });
        frame!.contentWindow!.postMessage({ fg: 'call', id, kind, ...payload }, '*');
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
