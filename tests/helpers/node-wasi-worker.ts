// A real Worker (Node worker_threads) over the same bundle the exec sandbox ships, for tests.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WasiWorkerLike } from '../../shiro/wasi-host';

let bundle: string | null = null;
function workerBundle(): string {
  // esbuild cannot run inside the jsdom test environment, so build the bundle in a plain Node process
  if (bundle) return bundle;
  if (process.env.FG_TEST_WASI_WORKER_BUNDLE) return (bundle=readFileSync(process.env.FG_TEST_WASI_WORKER_BUNDLE,'utf8'));
  const entry = resolve(process.cwd(), 'shiro/wasi-worker.ts');
  const script = `import('esbuild').then(async e => { const r = await e.build({ entryPoints: [${JSON.stringify(entry)}], bundle: true, format: 'iife', platform: 'browser', target: 'es2020', write: false, logLevel: 'silent' }); process.stdout.write(r.outputFiles[0].text); })`;
  return (bundle = execFileSync(process.execPath, ['-e', script], { maxBuffer: 1 << 26, cwd: process.cwd() }).toString());
}

export async function nodeWorkerFactory(): Promise<() => WasiWorkerLike> {
  const built = { outputFiles: [{ text: workerBundle() }] };
  const shim = "const {parentPort}=require('worker_threads');globalThis.self=globalThis;" +
    "globalThis.postMessage=m=>parentPort.postMessage(m);" +
    "parentPort.on('message',d=>globalThis.onmessage&&globalThis.onmessage({data:d}));\n";
  const { Worker } = await import('node:worker_threads');
  return () => {
    const w = new Worker(shim + built.outputFiles[0].text, { eval: true });
    const wrap: WasiWorkerLike = {
      postMessage: m => w.postMessage(m),
      onmessage: null, onerror: null,
      terminate: () => { void w.terminate(); },
    };
    w.on('message', data => wrap.onmessage?.({ data }));
    w.on('error', e => wrap.onerror?.({ message: e.message }));
    return wrap;
  };
}

