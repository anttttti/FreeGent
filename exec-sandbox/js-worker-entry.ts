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
import { installWorkerFetch, handleNetReply } from './worker-fetch';

installWorkerFetch();

self.onmessage = async ({ data }: MessageEvent) => {
    if (handleNetReply(data)) return;
    if (data?.type === 'run') {
        try { self.postMessage({ type: 'result', result: await runJs(String(data.code ?? ''), data.files ?? {}) }); }
        catch (e: any) { self.postMessage({ type: 'error', message: String(e?.message ?? e) }); }
    }
};
