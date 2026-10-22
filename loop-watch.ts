// loop-watch.ts — notices when the event loop was held, and says what was running.
//
// A TUI run with parallel workers froze for 15 minutes in a repo with 160k files: every command walked the workspace
// synchronously, and nothing said so. The heartbeat in the log showed gaps but not their cause. This watcher measures how late a
// timer fires; the late interval is the stall. Slow work that is awaited (a workspace scan, a checkpoint) registers itself with
// trackOp(), so a stall names the operations in flight; whether the process was busy (CPU time ≈ the stall) or just not
// scheduled (a suspended laptop, an overloaded machine) comes from process.cpuUsage().

const _ops = new Map<number, string>();
let _opSeq = 0;

/** Names the operation while `work` is pending, so a stall report can say what was in flight. */
export function trackOp<T>(label: string, work: Promise<T>): Promise<T> {
    const id = ++_opSeq;
    _ops.set(id, label);
    const done = () => { _ops.delete(id); };
    work.then(done, done);
    return work;
}
export function activeOps(): string[] { return [..._ops.values()]; }

export interface Stall {
    /** How long the loop was held beyond the interval, in ms. */
    ms: number;
    /** The process used about as much CPU as the stall lasted: synchronous work held the loop (otherwise it was not scheduled). */
    busy: boolean;
    /** Operations registered with trackOp() that were in flight when the stall ended. */
    ops: string[];
}

/**
 * Calls `onStall` whenever a timer fires more than `thresholdMs` late. Returns a function that stops the watcher.
 * A gap over `maxMs` is ignored: the machine was suspended, not the program.
 */
export function startLoopWatch(onStall: (s: Stall) => void, opts: { intervalMs?: number; thresholdMs?: number; maxMs?: number } = {}): () => void {
    const interval = opts.intervalMs ?? 100, threshold = opts.thresholdMs ?? 500, max = opts.maxMs ?? 60_000;
    let last = Date.now();
    let cpu = process.cpuUsage();
    const timer = setInterval(() => {
        const now = Date.now();
        const late = now - last - interval;
        const used = process.cpuUsage(cpu);
        last = now; cpu = process.cpuUsage();
        if (late < threshold || late > max) return;
        const cpuMs = (used.user + used.system) / 1000;
        try { onStall({ ms: late, busy: cpuMs >= late * 0.6, ops: activeOps() }); } catch { /* a report must not break the loop it measures */ }
    }, interval);
    timer.unref?.();
    return () => clearInterval(timer);
}

/**
 * Turns stalls into at most one user-facing message: only repeated long stalls are worth interrupting for.
 * `say` gets the text; the caller decides where it goes (a notice in the TUI).
 */
export function stallAnnouncer(say: (text: string) => void, opts: { minMs?: number; count?: number; windowMs?: number; quietMs?: number; where?: string } = {}) {
    const minMs = opts.minMs ?? 1000, count = opts.count ?? 3, windowMs = opts.windowMs ?? 60_000, quietMs = opts.quietMs ?? 300_000;
    let recent: Array<{ at: number; s: Stall }> = [];
    let lastSaid = -Infinity;
    return (s: Stall, now = Date.now()) => {
        if (s.ms < minMs) return;
        recent = recent.filter(r => now - r.at <= windowMs); recent.push({ at: now, s });
        if (recent.length < count || now - lastSaid < quietMs) return;
        lastSaid = now;
        const total = recent.reduce((n, r) => n + r.s.ms, 0);
        const ops = [...new Set(recent.flatMap(r => r.s.ops))];
        const cause = recent.some(r => r.s.busy)
            ? (ops.length ? `busy with ${ops.slice(0, 3).join(', ')}` : 'busy with synchronous work')
            : 'the machine was not scheduling the program (load or suspend)';
        say(`The interface was held up ${recent.length} times in the last minute (${(total / 1000).toFixed(1)} s in all); ${cause}.${opts.where ? ` Details in ${opts.where}.` : ''}`);
    };
}
