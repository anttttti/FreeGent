/**
 * wasi-host.ts — run a WASM program with a wall-clock deadline.
 *
 * WASM executes synchronously, so on the main thread a program that never returns freezes
 * everything and nothing can interrupt it. execWasi runs it in a Worker instead: the files are
 * preloaded here and shipped over, output streams back, and file changes are applied when the
 * program ends. When the deadline passes the Worker is terminated.
 *
 * An unavailable Worker is an error. Trusted headless callers may explicitly opt into
 * execution without a deadline; browser command execution never does so.
 */
import { WasiRT, type WasiConfig, type WasiJob } from './wasi-runtime';
import { memoryImports, moduleBytes } from './wasm-module';
import type { WorkerReply } from './wasi-worker-core';

export interface WasiWorkerLike {
  postMessage(msg: unknown): void;
  onmessage: ((e: { data: WorkerReply }) => void) | null;
  onerror: ((e: { message?: string }) => void) | null;
  terminate(): void;
}

/** Set by the sandbox build (dev-api.ts): the bundled source of wasi-worker.ts. */
declare const __WASI_WORKER_SRC__: string | undefined;

let factory: (() => WasiWorkerLike) | null = null;

/** Choose how Workers are created (tests, other hosts). `null` restores the default. */
export function setWasiWorkerFactory(f: (() => WasiWorkerLike) | null): void { factory = f; }

function createWorker(): WasiWorkerLike | null {
  if (factory) return factory();
  if (typeof __WASI_WORKER_SRC__ !== 'undefined' && typeof Worker !== 'undefined' && typeof URL !== 'undefined' && typeof Blob !== 'undefined') {
    const url = URL.createObjectURL(new Blob([__WASI_WORKER_SRC__], { type: 'text/javascript' }));
    try {
      const worker = new Worker(url);
      const revoke = () => URL.revokeObjectURL(url);
      worker.addEventListener('message', revoke, {once:true});
      worker.addEventListener('error', revoke, {once:true});
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => { revoke(); terminate(); };
      return worker as unknown as WasiWorkerLike;
    } catch (error) { URL.revokeObjectURL(url); throw error; }
  }
  return null;
}

/** Wall-clock limit for one program unless the caller passes its own. */
export const DEFAULT_DEADLINE_MS = 30_000;

export interface ExecOptions {
  /** Kill the program after this many milliseconds (Infinity: no limit). */
  deadlineMs?: number;
  /** Complete filesystem root (default: /); explicit bounds fail instead of truncating. */
  preloadRoot?: string;
  preloadDepth?: number;
  preloadFiles?: number;
  preloadBytes?: number;
  signal?: AbortSignal;
  /** Only trusted headless callers may opt in; requires deadlineMs: Infinity. */
  allowInThread?: boolean;
}

/** Exit status used when the deadline kills a program (as timeout(1) does). */
export const EXIT_DEADLINE = 124;

export async function execWasi(config: WasiConfig, module: WebAssembly.Module, opts: ExecOptions = {}): Promise<number> {
  const deadline = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const cancellation = new AbortController();
  return new Promise<number>((resolve,reject) => {
    let settled = false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const finish = (code?:number, error?:unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort',abort);
      cancellation.abort();
      if (error !== undefined) reject(error); else resolve(code!);
    };
    const abort = () => finish(130);
    opts.signal?.addEventListener('abort',abort,{once:true});
    if (opts.signal?.aborted) {abort(); return;}
    if (Number.isFinite(deadline)) timer = setTimeout(() => {
      config.onStderr?.(`shiro: ${config.args[0] ?? 'program'}: still running after ${deadline / 1000}s, killed\n`);
      finish(EXIT_DEADLINE);
    },Math.max(0,deadline));
    runWasi(config,module,{...opts,signal:cancellation.signal,deadlineMs:Infinity,allowInThread:opts.allowInThread && deadline === Infinity})
      .then(code => finish(code),error => finish(undefined,error));
  });
}

async function runWasi(config:WasiConfig, module:WebAssembly.Module, opts:ExecOptions): Promise<number> {
  const rt = new WasiRT(config);
  if (opts.signal?.aborted) return 130;
  await rt.preloadTree(opts.preloadRoot ?? '/', opts.preloadDepth, opts.preloadFiles, opts.preloadBytes, opts.signal);
  if (opts.signal?.aborted) return 130;
  rt.mountPackageResources(); rt.installVirtualCommands();
  const worker = createWorker();
  if (!worker) {
    if (opts.allowInThread && opts.deadlineMs === Infinity) return rt.run(module);
    throw new Error('WASI execution requires a Worker to enforce cancellation and deadlines');
  }

  const mem = memoryImports.get(module);
  const job: WasiJob = rt.exportJob(mem ? { initial: mem.initial, maximum: mem.maximum } : undefined);
  const w = worker;
  const execution = new AbortController();

  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', abort);
      execution.abort();
      w.onmessage = null;
      w.onerror = null;
      w.terminate();
      fn();
    };
    const abort = () => finish(() => resolve(130));
    opts.signal?.addEventListener('abort', abort, {once:true});
    if (opts.signal?.aborted) { abort(); return; }
    w.onmessage = ({ data: m }) => {
      switch (m.type) {
        case 'stdout': config.onStdout?.(m.text); break;
        case 'stderr': config.onStderr?.(m.text); break;
        case 'trace': config.trace?.(m.text); break;
        case 'exec': {
          // the program asked to run another command: the shell is on this side
          const id = m.id;
          const reply = (msg: unknown) => { if (!settled) w.postMessage(msg); };
          if (!config.exec) { reply({ type: 'exec-result', id, error: 'exec is not available' }); break; }
          (async () => {
            if (m.req.writes) await rt.applyWrites(m.req.writes);          // the host sees the program's files first
            if (settled) return;
            const result = await config.exec!({ ...m.req, writes: undefined, known: undefined, dirs: undefined, signal:execution.signal });
            if (settled) return;
            result.updates = await rt.computeUpdates(m.req.known ?? [], m.req.dirs ?? []);   // and the program sees the host's changes
            reply({ type: 'exec-result', id, result });
          })().catch(e => reply({ type: 'exec-result', id, error: String(e?.message ?? e) }));
          break;
        }
        case 'done':
          // the file changes are applied before the caller sees the exit status
          if (!settled) {
            const writes = m.writes;
            finish(() => { rt.applyWrites(writes).then(() => resolve(m.code), reject); });
          }
          break;
        case 'error': finish(() => reject(new Error(m.message))); break;
      }
    };
    w.onerror = ev => finish(() => reject(new Error(ev?.message || 'worker error')));
    try { w.postMessage({ type: 'run', module, job, trace: !!config.trace }); }
    catch (e: any) {
      const bytes = moduleBytes.get(module);
      if (e?.name === 'DataCloneError' && bytes) {
        // Recompile in the worker; never run synchronously in the page/frame.
        try { w.postMessage({ type: 'run', bytes, job, trace: !!config.trace }); }
        catch (error) { finish(() => reject(error)); }
      } else finish(() => reject(e));
    }
  });
}
