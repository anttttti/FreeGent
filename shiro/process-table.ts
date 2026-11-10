/**
 * Process Table - global registry for windowed processes.
 */


interface ShiroProcess {
  pid: number;
  command: string;
  status: 'running' | 'exited' | 'killed';
  exitCode: number;
  startTime: number;
  promise: Promise<number>;
  kill: () => void;
  abortController: AbortController | null;
}

class ProcessTable {
  private processes = new Map<number, ShiroProcess>();
  private nextPid = 100;

  allocate(command: string): ShiroProcess {
    const pid = this.nextPid++;
    const proc: ShiroProcess = {
      pid,
      command,
      status: 'running',
      exitCode: 0,
      startTime: Date.now(),
      promise: Promise.resolve(0), // replaced by spawn
      kill: () => {}, // replaced by spawn
      abortController: null,
    };
    this.processes.set(pid, proc);
    return proc;
  }

  kill(pid: number): boolean {
    const proc = this.processes.get(pid);
    if (!proc || proc.status !== 'running') return false;
    if (proc.abortController) proc.abortController.abort();
    proc.kill();
    proc.status = 'killed';
    proc.exitCode = 130;
    return true;
  }

  list(): ShiroProcess[] {
    return Array.from(this.processes.values());
  }

  get(pid: number): ShiroProcess | undefined {
    return this.processes.get(pid);
  }

  remove(pid: number): void {
    this.processes.delete(pid);
  }

  markExited(pid: number, exitCode: number): void {
    const proc = this.processes.get(pid);
    if (proc && proc.status === 'running') {
      proc.status = 'exited';
      proc.exitCode = exitCode;
      // Auto-remove after 30 seconds
      setTimeout(() => this.processes.delete(pid), 30_000);
    }
  }
}

// Singleton — reuse window global to survive double evaluation
// (entry chunk is both inlined in HTML and loaded as file by lazy chunks)
export const processTable: ProcessTable =
  (typeof window !== 'undefined' && (window as any).__processTable?.allocate)
    ? (window as any).__processTable
    : new ProcessTable();
if (typeof window !== 'undefined') {
  (window as any).__processTable = processTable;
}
