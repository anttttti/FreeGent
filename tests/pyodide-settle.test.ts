// codex R194/R195/R196: a Python run on the in-browser Pyodide worker must always settle, and a stopped run must not write files later.
// The exec sandbox frame is emulated over its message protocol, as in tests/fake-sandbox.ts, with a worker the test controls.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { resetSandbox } from '../exec-sandbox-host';
import * as config from '../config.ts';
const W = globalThis as any;

const calls: string[] = [];
let runs: { id: number }[] = [];
let toPage: (data: any) => void = () => {};
let readyOnStart = true;
let running = false;
const result = (id: number, extra: any = {}) => toPage({ fg: 'event', name: 'py', data: { type: 'result', id, stdout: 'ok', stderr: '', exit_code: 0, ...extra } });
const crash = () => { running = false; toPage({ fg: 'event', name: 'py-error', data: 'out of memory' }); };

let observer: MutationObserver;
beforeAll(async () => {
    globalThis.indexedDB = new IDBFactory();
    await W.initDB();
    observer = new MutationObserver(records => {
        for (const r of records) for (const node of r.addedNodes) {
            if (!(node instanceof HTMLIFrameElement)) continue;
            const cw = node.contentWindow as any;
            toPage = (data: any) => window.dispatchEvent(new MessageEvent('message', { data, source: cw }));
            cw.postMessage = (msg: any) => {
                if (msg?.fg !== 'call') return;
                calls.push(msg.kind);
                // As exec-sandbox/entry.ts: py-start while a worker runs does nothing; py-stop ends it.
                if (msg.kind === 'py-start' && !running) { running = true; if (readyOnStart) setTimeout(() => toPage({ fg: 'event', name: 'py', data: { type: 'ready' } }), 0); }
                if (msg.kind === 'py-stop') running = false;
                if (msg.kind === 'py-post' && msg.msg?.type === 'run') runs.push({ id: msg.msg.id });
                toPage({ fg: 'reply', id: msg.id, value: true });
            };
            setTimeout(() => toPage({ fg: 'ready' }), 0);
        }
    });
    observer.observe(document.body, { childList: true });
});
afterAll(() => { observer.disconnect(); resetSandbox(); });

const until = async (f: () => any) => { for (let i = 0; i < 200 && !f(); i++) await new Promise(r => setTimeout(r, 5)); };

describe('Pyodide runs settle', () => {
    it('a worker crash after "ready" ends the runs waiting on it (R195)', async () => {
        await W.startPyodide();
        runs = [];
        const p = W.runWithPyodide('while True: pass');
        await until(() => runs.length);
        crash();
        const r = await p;
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/Pyodide worker failed: out of memory/);
        expect(config.pyodideStatus).toBe('error');
    });

    it('Stop Now ends the run, restarts the worker, and a late result writes nothing (R194)', async () => {
        await W.startPyodide();
        runs = []; calls.length = 0;
        const ac = new AbortController();
        const p = W.runWithPyodide("open('late.txt','w').write('x')", { signal: ac.signal });
        await until(() => runs.length);
        const id = runs[0].id;
        ac.abort();
        const r = await p;
        expect(r.exit_code).toBe(130);
        expect(calls).toContain('py-stop');
        expect(calls.filter(c => c === 'py-start').length).toBe(1);   // the fresh worker
        result(id, { changedFiles: { 'late.txt': 'x' } });            // the old worker's answer, had it come
        await new Promise(r => setTimeout(r, 30));
        await expect(W.agentReadFile('late.txt')).rejects.toThrow();
        await until(() => config.pyodideStatus === 'ready');
        expect(config.pyodideStatus).toBe('ready');
    });

    it('a start that never says "ready" fails after its deadline, and so does a run waiting on it (R196)', async () => {
        crash();   // end the current worker
        readyOnStart = false;
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const start = W.startPyodide();
            start.catch(() => {});
            const run = W.runWithPyodide('print(1)').catch((e: Error) => e);
            await vi.advanceTimersByTimeAsync(180_000);
            await expect(start).rejects.toThrow(/did not start within 180 s/);
            expect(String(await run)).toMatch(/Pyodide not loaded/);
            expect(config.pyodideStatus).toBe('error');
        } finally { vi.useRealTimers(); readyOnStart = true; }
    });
});
