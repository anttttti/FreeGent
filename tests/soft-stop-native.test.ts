// Stop-after-this-step (Ctrl+C in the TUI) must let a running native command finish. It used to abort the turn instead:
// the command was detached, kept running, and wrote its file after the next turn had started and verified a newer one
// (TUI report cases 047-051, 072).
import { describe, it, expect, afterEach } from 'vitest';
import { runtime } from '../runtime.ts';

const W = window as any;
afterEach(() => { delete (globalThis as any).nativeExec; W.setActiveAbortController?.(null); W.setSoftStopPending?.(false); });

describe('native execution and soft stop', () => {
    it('nativeBusy is true while a command runs and false after, also when it fails', async () => {
        let release!: (v: any) => void;
        (globalThis as any).nativeExec = () => new Promise(r => { release = r; });
        expect(runtime.nativeBusy).toBe(false);
        const p = runtime.nativeExec('bash', 'sleep 1');
        expect(runtime.nativeBusy).toBe(true);
        release({ exit_code: 0 }); await p;
        expect(runtime.nativeBusy).toBe(false);
        (globalThis as any).nativeExec = () => Promise.reject(new Error('boom'));
        await expect(runtime.nativeExec('bash', 'x')).rejects.toThrow('boom');
        expect(runtime.nativeBusy).toBe(false);
    });
    it('stopAfterStep does not abort the turn while a native command runs, and does when none does', async () => {
        await import('../agent-core.ts');
        let release!: (v: any) => void;
        (globalThis as any).nativeExec = () => new Promise(r => { release = r; });
        const controller = new AbortController();
        W.setActiveAbortController(controller);
        const p = runtime.nativeExec('bash', 'echo late > out.txt');
        W.stopAfterStep();
        expect(controller.signal.aborted).toBe(false);        // the step is allowed to finish
        release({ stdout: '', exit_code: 0 }); await p;
        W.stopAfterStep();
        expect(controller.signal.aborted).toBe(true);         // nothing running: the turn ends at once
    });
});
