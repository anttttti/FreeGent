import { describe, it, expect } from 'vitest';
import { startLoopWatch, stallAnnouncer, trackOp, activeOps, type Stall } from '../loop-watch.ts';

const spin = (ms: number) => { const t = Date.now(); while (Date.now() - t < ms); };

describe('loop watch', () => {
    it('reports a held event loop as busy, with the operations in flight', async () => {
        const seen: Stall[] = [];
        const stop = startLoopWatch(s => seen.push(s), { intervalMs: 20, thresholdMs: 100 });
        const op = trackOp('demo scan', new Promise<void>(r => setTimeout(r, 400)));
        await new Promise(r => setTimeout(r, 40));
        spin(300);
        await new Promise(r => setTimeout(r, 60));
        stop(); await op;
        expect(seen.length).toBeGreaterThan(0);
        expect(seen[0].ms).toBeGreaterThanOrEqual(200);
        expect(seen[0].busy).toBe(true);
        expect(seen[0].ops).toContain('demo scan');
        expect(activeOps()).not.toContain('demo scan');
    });
    it('is quiet while the loop is free', async () => {
        const seen: Stall[] = [];
        const stop = startLoopWatch(s => seen.push(s), { intervalMs: 20, thresholdMs: 100 });
        await new Promise(r => setTimeout(r, 300));
        stop();
        expect(seen).toEqual([]);
    });
    it('a gap longer than the suspend bound is not a stall', async () => {
        const seen: Stall[] = [];
        const stop = startLoopWatch(s => seen.push(s), { intervalMs: 20, thresholdMs: 100, maxMs: 200 });
        await new Promise(r => setTimeout(r, 30)); spin(400); await new Promise(r => setTimeout(r, 60));
        stop();
        expect(seen).toEqual([]);
    });
});

describe('stall announcer', () => {
    const stall = (ms: number, ops: string[] = [], busy = true): Stall => ({ ms, busy, ops });
    it('speaks once for repeated long stalls and names the cause, then stays quiet', () => {
        const said: string[] = [];
        const a = stallAnnouncer(t => said.push(t), { where: '/tmp/x.log' });
        a(stall(1500, ['workspace scan (/w)']), 1000); a(stall(2000), 2000);
        expect(said).toEqual([]);
        a(stall(1200), 3000);
        expect(said.length).toBe(1);
        expect(said[0]).toMatch(/3 times/); expect(said[0]).toMatch(/workspace scan/); expect(said[0]).toMatch(/\/tmp\/x\.log/);
        a(stall(5000), 4000); a(stall(5000), 5000); a(stall(5000), 6000);
        expect(said.length).toBe(1);
    });
    it('short stalls and stalls spread over minutes never speak; an unscheduled process is said so', () => {
        const said: string[] = [];
        const a = stallAnnouncer(t => said.push(t));
        for (let i = 0; i < 10; i++) a(stall(600), i * 1000);
        for (let i = 0; i < 5; i++) a(stall(2000), 100_000 + i * 70_000);
        expect(said).toEqual([]);
        a(stall(2000, [], false), 500_000); a(stall(2000, [], false), 501_000); a(stall(2000, [], false), 502_000);
        expect(said[0]).toMatch(/not scheduling/);
    });
});
