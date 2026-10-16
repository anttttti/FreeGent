// exec-sandbox/js-worker-entry.ts — execute_code in JavaScript, in a Worker.
// A synchronous loop in the sandbox frame ran on the page's own thread: the page froze, and Stop could not be
// processed until the loop ended (codex campaign 4: 3.5 s; an endless loop never). In a worker the page stays responsive,
// and the page's Stop / 60 s timeout remove the sandbox frame, which ends its workers with it.
//
// The runner is the same runJs (js-run.ts). Only the network differs: like the Pyodide worker, a plain GET the browser
// refuses (this worker has the sandbox's opaque origin) is relayed through the frame to the page's proxy.
//
// Bundled separately (dev-api.ts buildExecSandbox) and started from a blob URL by entry.ts.

import '../polyfills';
import { runJs } from './js-run';

const _directFetch = self.fetch.bind(self);
const _netWaiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let _netSeq = 0;
self.fetch = async (input: any, init: any = {}) => {
    try {
        return await _directFetch(input, init);
    } catch (err) {
        if (!(err instanceof TypeError)) throw err;
        const url    = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = String(init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        if ((method !== 'GET' && method !== 'HEAD') || init.body != null || !/^https?:\/\//i.test(url)) throw err;
        const id = ++_netSeq;
        const r: any = await new Promise((resolve, reject) => {
            _netWaiting.set(id, { resolve, reject });
            self.postMessage({ type: 'net', id, url });
        });
        const headers: Record<string, string> = { 'X-FG-Via-Proxy': '1' };
        if (r.contentType) headers['Content-Type'] = r.contentType;
        return new Response([101, 204, 205, 304].includes(r.status) ? null : r.body, { status: r.status, headers });
    }
};

self.onmessage = async ({ data }: MessageEvent) => {
    if (data?.type === 'net-reply') {
        const w = _netWaiting.get(data.id);
        if (!w) return;
        _netWaiting.delete(data.id);
        if (data.error !== undefined) w.reject(new TypeError(`Failed to fetch: ${data.error}`)); else w.resolve(data.value);
        return;
    }
    if (data?.type === 'run') {
        try { self.postMessage({ type: 'result', result: await runJs(String(data.code ?? ''), data.files ?? {}) }); }
        catch (e: any) { self.postMessage({ type: 'error', message: String(e?.message ?? e) }); }
    }
};
