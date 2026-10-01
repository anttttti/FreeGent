// pyodide-worker.ts — runs Python in a Web Worker via Pyodide (the run itself: pyodide-run.ts).
// Bundled into one classic script by dev-api.ts buildExecSandbox().
import { runInPyodide } from './pyodide-run';

importScripts('https://cdn.jsdelivr.net/pyodide/v0.27.0/full/pyodide.js');

let pyodide: any = null;

// Network: fetch (used by pyodide.http.pyfetch and micropip) goes out directly; a plain GET the
// browser refuses (CORS — this worker has the exec sandbox's opaque origin) is retried through
// FreeGent's fetch proxy, relayed by the sandbox frame to the page (exec-sandbox/net.ts has the
// same logic for the frame; this worker is built separately, so it keeps its own copy).
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

async function init() {
    try {
        pyodide = await loadPyodide({
            indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/'
        });
        await pyodide.loadPackage("micropip");

        // In-memory /workspace: the page sends the workspace files with every run and it is
        // emptied after the run (the workspace is the only lasting copy). The worker runs in the
        // exec sandbox's opaque origin, where IndexedDB (IDBFS) is not available.
        pyodide.FS.mkdirTree('/workspace');

        self.postMessage({ type: 'ready' });
    } catch (e) {
        self.postMessage({ type: 'error', message: e.message });
    }
}

let _runChain: Promise<void> = Promise.resolve();

self.onmessage = async ({ data }) => {
    if (data.type === 'net-reply') {
        const w = _netWaiting.get(data.id);
        if (!w) return;
        _netWaiting.delete(data.id);
        if (data.error !== undefined) w.reject(new TypeError(`Failed to fetch: ${data.error}`)); else w.resolve(data.value);
        return;
    }
    if (data.type === 'install_packages') {
        const { id, packages } = data;
        try {
            await pyodide.runPythonAsync(`
                import micropip
                await micropip.install(${JSON.stringify(packages)})
            `);
            self.postMessage({ type: 'result', id, stdout: '', stderr: '', exit_code: 0, changedFiles: {} });
        } catch (e) {
            self.postMessage({ type: 'result', id, stdout: '', stderr: e.message, exit_code: 1, changedFiles: {} });
        }
        return;
    }

    if (data.type !== 'run') return;
    const { id, code, files, filepath } = data;

    // One run at a time: they share /workspace, which each run fills and then empties, and a
    // run awaiting (pyfetch, micropip) would otherwise see another run's files come and go.
    const prevRun = _runChain;
    let releaseRun!: () => void;
    _runChain = new Promise<void>(r => { releaseRun = r; });
    await prevRun;
    try {
        self.postMessage({ type: 'result', id, ...(await runInPyodide(pyodide, { code, files, filepath })) });
    } finally {
        releaseRun();
    }
};

init();
