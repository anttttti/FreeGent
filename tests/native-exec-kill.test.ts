// killChildGroup (native-exec.ts): a command that never started has no pid, and `-(pid ?? 0)` made the Stop or the deadline signal process group 0, the caller's own (explorations W014).
import { describe, it, expect, vi } from 'vitest';
import { killChildGroup } from '../native-exec.ts';

describe('killChildGroup', () => {
    it('signals the command\'s group by its negative pid, then the child', () => {
        const killPid = vi.fn(), child = { pid: 4321, kill: vi.fn() };
        killChildGroup(child, killPid);
        expect(killPid).toHaveBeenCalledWith(-4321, 'SIGKILL');
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });
    it('never targets group 0 or a made-up pid when the spawn failed', () => {
        for (const pid of [undefined, 0, -5, NaN, 1.5]) {
            const killPid = vi.fn(), child = { pid: pid as any, kill: vi.fn() };
            killChildGroup(child, killPid);
            expect(killPid).not.toHaveBeenCalled();
            expect(child.kill).toHaveBeenCalledWith('SIGKILL');
        }
    });
    it('survives a kill that throws', () => {
        expect(() => killChildGroup({ pid: 7, kill() { throw new Error('ESRCH'); } }, () => { throw new Error('ESRCH'); })).not.toThrow();
    });
});
