/**
 * wasi-worker-core.ts — the part of a WASM run that happens inside a Worker.
 *
 * The host (wasi-host.ts) preloads the files, ships them with the module as a WasiJob, and gets
 * back stdout/stderr as they are produced plus the file changes when the program ends. The worker
 * has no filesystem, so a program that loops forever can simply be terminated.
 */
import { WasiRT, type WasiJob, type WasiWrites, type ExecRequest, type ExecResult } from './wasi-runtime';
import { memoryImports } from './wasm-module';

export interface RunRequest { type: 'run'; module?: WebAssembly.Module; bytes?: Uint8Array; job: WasiJob; trace?: boolean }

export type WorkerReply =
  | { type: 'stdout' | 'stderr' | 'trace'; text: string }
  | { type: 'exec'; id: number; req: ExecRequest }
  | { type: 'done'; code: number; writes: WasiWrites }
  | { type: 'error'; message: string };

export type HostMessage = RunRequest | { type: 'exec-result'; id: number; result?: ExecResult; error?: string };

/** The message handler of a worker: runs jobs, and routes the host's answers to exec requests. */
export function makeHandler(post: (m: WorkerReply) => void): (msg: HostMessage) => void {
  const pending = new Map<number, { resolve: (r: ExecResult) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  const exec = (req: ExecRequest) => new Promise<ExecResult>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    post({ type: 'exec', id, req });
  });
  return msg => {
    if (msg?.type === 'run') void handleRun(msg, post, exec);
    else if (msg?.type === 'exec-result') {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (!p) return;
      if (msg.error !== undefined) p.reject(new Error(msg.error)); else p.resolve(msg.result!);
    }
  };
}

export async function handleRun(req: RunRequest, post: (m: WorkerReply) => void, exec?: (r: ExecRequest) => Promise<ExecResult>): Promise<void> {
  try {
    const module = req.module ?? (req.bytes ? await WebAssembly.compile(req.bytes as unknown as BufferSource) : null);
    if (!module) throw new Error('WASM worker request has no module or bytes');
    // WeakMap metadata does not survive structured clone: re-attach it from the job
    if (req.job.memory) {
      memoryImports.set(module, { module: 'env', name: 'memory', ...req.job.memory, wasShared: false });
    }
    const rt = WasiRT.fromJob(req.job, {
      onStdout: text => post({ type: 'stdout', text }),
      onStderr: text => post({ type: 'stderr', text }),
      trace: req.trace ? (text => post({ type: 'trace', text })) : undefined,
      exec,
    });
    const code = await rt.runProgram(module);
    post({ type: 'done', code, writes: rt.takeWrites() });
  } catch (e: any) {
    post({ type: 'error', message: String(e?.message ?? e) });
  }
}
