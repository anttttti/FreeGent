// pyodide-worker.ts — runs Python in a Web Worker via Pyodide (the run itself: pyodide-run.ts).
// Bundled into one classic script by dev-api.ts buildExecSandbox().
import './polyfills';
import { runInPyodide } from './pyodide-run';
import { PYODIDE_CDN } from './pyodide-version';
import { installWorkerFetch, handleNetReply } from './exec-sandbox/worker-fetch';

importScripts(PYODIDE_CDN + 'pyodide.js');

let pyodide: any = null;

// Network: fetch (used by pyodide.http.pyfetch and micropip) goes out directly; a plain GET the
// browser refuses is retried through the page (exec-sandbox/worker-fetch.ts).
installWorkerFetch();

async function init() {
    try {
        pyodide = await loadPyodide({
            indexURL: PYODIDE_CDN
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
    if (handleNetReply(data)) return;
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
