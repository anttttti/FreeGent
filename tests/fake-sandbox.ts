// The browser's tools in a test: the real page side (executeToolAsync, tools.ts, config.ts
// runWithPyodide, the workspace on a fake IndexedDB) and the real runners (the WASM shell,
// exec-sandbox/js-run.ts, pyodide-run.ts on a real Pyodide). Only the exec sandbox iframe and its
// Pyodide worker are emulated, over the same message protocol: the fake frame answers calls as
// exec-sandbox/entry.ts does, and runs Python as pyodide-worker.ts does.
import { IDBFactory } from 'fake-indexeddb';
import { __setPyodideForTest } from '../shiro/commands/python';
import { runInPyodide } from '../pyodide-run';
import { runJs } from '../exec-sandbox/js-run';
import { runBash } from '../exec-sandbox/bash-run';
import { resetSandbox } from '../exec-sandbox-host';
import { resetShell } from '../shiro/shell-singleton';
import { loadNodePyodide } from './parity-utils';

const W = globalThis as any;

/** Answers the page's sandbox calls as exec-sandbox/entry.ts does inside the real iframe. */
function installFakeSandboxFrame(py: any) {
    const observer = new MutationObserver(records => {
        for (const r of records) for (const node of r.addedNodes) {
            if (!(node instanceof HTMLIFrameElement)) continue;
            const cw = node.contentWindow as any;
            const toPage = (data: any) => window.dispatchEvent(new MessageEvent('message', { data, source: cw }));
            const worker = (data: any) => toPage({ fg: 'event', name: 'py', data });   // pyodide-worker.ts messages
            let runChain = Promise.resolve();
            cw.postMessage = (msg: any) => {
                if (msg?.fg !== 'call') return;
                const reply = (p: Promise<any>) => p.then(value => toPage({ fg: 'reply', id: msg.id, value }),
                                                          err => toPage({ fg: 'reply', id: msg.id, error: String(err?.message ?? err) }));
                switch (msg.kind) {
                    case 'js': reply(runJs(String(msg.code ?? ''), msg.files ?? {})); break;
                    case 'bash': reply(runBash(String(msg.code ?? ''),message => toPage({fg:'progress',id:msg.id,message}))); break;
                    case 'py-start': reply(Promise.resolve(true)); setTimeout(() => worker({ type: 'ready' }), 0); break;
                    case 'py-post': {
                        const m = msg.msg;
                        if (m?.type === 'run') runChain = runChain.then(async () =>
                            worker({ type: 'result', id: m.id, ...(await runInPyodide(py, { code: m.code, files: m.files, filepath: m.filepath })) }));
                        reply(Promise.resolve(true));
                        break;
                    }
                    default: reply(Promise.reject(new Error(`unknown sandbox call: ${msg.kind}`)));
                }
            };
            setTimeout(() => toPage({ fg: 'ready' }), 0);
        }
    });
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
}

let uninstall: (() => void) | null = null;

/** A fresh workspace, a fresh shell, and the sandbox (frame + Pyodide worker) ready. */
export async function setupBrowserTools(): Promise<void> {
    globalThis.indexedDB = new IDBFactory();
    await W.initDB();
    W.mainAgentRole = null;
    resetShell();
    localStorage.setItem('fg_sandbox_provider', 'wasm');
    if (!uninstall) {
        const py = await loadNodePyodide();
        __setPyodideForTest(py);   // the shell's python3
        uninstall = installFakeSandboxFrame(py);
        afterAll(() => { uninstall?.(); uninstall = null; resetSandbox(); });
        await W.startPyodide();
    }
}
