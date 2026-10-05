// exec-sandbox/channel.ts — the sandbox frame's side of the postMessage channel to the page.
//
// Only messages from window.parent are accepted. The frame's origin is opaque, so it can't name
// the page's origin as a postMessage target; '*' is safe here because the target is the fixed
// parent window object, not a URL.
//
//   page → frame   { fg: 'call', id, kind, ...payload }          run something
//   frame → page   { fg: 'reply', id, value } | { fg: 'reply', id, error }
//   frame → page   { fg: 'ws', id, op, args }                    workspace file operation
//   page → frame   { fg: 'ws-reply', id, value } | { ..., error }
//   frame → page   { fg: 'net', id, url }                        proxied plain GET (net.ts)
//   page → frame   { fg: 'net-reply', id, value: { status, contentType, body } } | { ..., error }
//   frame → page   { fg: 'event', name, data }                   unsolicited (Pyodide worker)
//   frame → page   { fg: 'ready' }

type Handler = (msg: any) => Promise<any>;

const parentWin = window.parent;
let handler: Handler | null = null;
let seq = 0;
const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

export function post(msg: any, transfer: Transferable[] = []): void {
    parentWin.postMessage(msg, '*', transfer);
}

export function onCall(h: Handler): void { handler = h; }

function requestToPage(msg: any): Promise<any> {
    const id = ++seq;
    return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        post({ ...msg, id });
    });
}

// Ask the page to run a workspace operation (see exec-sandbox-host.ts for the allowed ops).
export function workspaceCall(op: string, args: any[]): Promise<any> {
    return requestToPage({ fg: 'ws', op, args });
}

export function packageCacheCall(request:import('../shiro/wasi-packages').PackageCacheRequest): Promise<any> {
    return requestToPage({fg:'package-cache',request});
}

export interface PageFetchResult { status: number; contentType: string; body: ArrayBuffer; }

// Ask the page for a plain GET through the fetch proxy (exec-sandbox-host.ts _answerNet).
export function pageFetch(url: string): Promise<PageFetchResult> {
    return requestToPage({ fg: 'net', url });
}

window.addEventListener('message', async (e: MessageEvent) => {
    if (e.source !== parentWin) return;
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.fg === 'ws-reply' || d.fg === 'net-reply' || d.fg === 'package-cache-reply') {
        const w = waiting.get(d.id);
        if (!w) return;
        waiting.delete(d.id);
        if (d.error !== undefined) w.reject(new Error(d.error)); else w.resolve(d.value);
        return;
    }
    if (d.fg === 'call' && handler) {
        try { post({ fg: 'reply', id: d.id, value: await handler(d) }); }
        catch (err: any) { post({ fg: 'reply', id: d.id, error: String(err?.message ?? err) }); }
    }
});
