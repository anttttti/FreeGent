/**
 * wasi-host.ts — run a WASM program with a wall-clock deadline.
 *
 * WASM executes synchronously, so on the main thread a program that never returns freezes
 * everything and nothing can interrupt it. execWasi runs it in a Worker instead: the files are
 * preloaded here and shipped over, output streams back, and file changes are applied when the
 * program ends. When the deadline passes the Worker is terminated.
 *
 * Without a Worker (headless, tests that do not provide one) it falls back to running in-thread,
 * where no deadline can be enforced.
 */
import { WasiRT, type WasiConfig, type WasiJob } from './wasi-runtime';
import { memoryImports } from './wasm-module';
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
    return new Worker(url) as unknown as WasiWorkerLike;
  }
  return null;
}

/** Wall-clock limit for one program unless the caller passes its own. */
export const DEFAULT_DEADLINE_MS = 30_000;

export interface ExecOptions {
  /** Kill the program after this many milliseconds (Infinity: no limit). */
  deadlineMs?: number;
  /** Directory tree to preload so the program can read it (default: the cwd, 3 levels, 100 files). */
  preloadRoot?: string;
  preloadDepth?: number;
  preloadFiles?: number;
}

/** Exit status used when the deadline kills a program (as timeout(1) does). */
export const EXIT_DEADLINE = 124;

export async function execWasi(config: WasiConfig, module: WebAssembly.Module, opts: ExecOptions = {}): Promise<number> {
  const rt = new WasiRT(config);
  await rt.preloadTree(opts.preloadRoot ?? config.cwd, opts.preloadDepth ?? 3, opts.preloadFiles ?? 100);
  // package stubs live here; a program that searches PATH (a shell) has to see them
  if (config.commands) { await rt.preloadTree('/usr/local/bin', 1, 200); await rt.preloadDir('/tmp'); }

  let worker: WasiWorkerLike | null = null;
  try { worker = createWorker(); } catch { worker = null; }
  if (!worker) return rt.run(module);

  const mem = memoryImports.get(module);
  const job: WasiJob = rt.exportJob(mem ? { initial: mem.initial, maximum: mem.maximum } : undefined);
  const deadline = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const w = worker;

  return new Promise<number>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      w.onmessage = null;
      w.onerror = null;
      w.terminate();
      fn();
    };
    if (Number.isFinite(deadline)) {
      timer = setTimeout(() => finish(() => {
        config.onStderr?.(`shiro: ${config.args[0] ?? 'program'}: still running after ${deadline / 1000}s, killed\n`);
        resolve(EXIT_DEADLINE);
      }), deadline);
    }
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
            const result = await config.exec!({ ...m.req, writes: undefined, known: undefined, dirs: undefined });
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
    catch { finish(() => { rt.run(module).then(resolve, reject); }); }   // cannot be cloned: run in-thread
  });
}
