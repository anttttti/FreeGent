import { describe, it, expect, vi, beforeEach } from 'vitest';
import { combineSignals, connectSignal } from '../abort.js';

const W: any = globalThis;

describe('combineSignals', () => {
    it('returns undefined with neither a user signal nor a timeout', () => {
        expect(combineSignals(undefined, undefined)).toBeUndefined();
        expect(combineSignals(null, 0)).toBeUndefined();
    });
    it('follows the user signal', () => {
        const u = new AbortController();
        const s = combineSignals(u.signal, 60_000)!;
        expect(s.aborted).toBe(false);
        u.abort();
        expect(s.aborted).toBe(true);
    });
    it('is already aborted when the user signal already is', () => {
        const u = new AbortController(); u.abort();
        expect(combineSignals(u.signal, 60_000)!.aborted).toBe(true);
    });
    it('aborts on timeout when no user signal', async () => {
        const s = combineSignals(null, 20)!;
        expect(s.aborted).toBe(false);
        await new Promise(r => setTimeout(r, 60));
        expect(s.aborted).toBe(true);
    });
    it('uses only the user signal when there is no timeout', () => {
        const u = new AbortController();
        expect(combineSignals(u.signal)).toBe(u.signal);
    });
    it('works without AbortSignal.any and AbortSignal.timeout (old Safari)', async () => {
        const any = (AbortSignal as any).any, timeout = (AbortSignal as any).timeout;
        (AbortSignal as any).any = undefined; (AbortSignal as any).timeout = undefined;
        try {
            const u = new AbortController();
            const s = combineSignals(u.signal, 20)!;
            u.abort();
            expect(s.aborted).toBe(true);
            const t = combineSignals(null, 20)!;
            await new Promise(r => setTimeout(r, 60));
            expect(t.aborted).toBe(true);
        } finally { (AbortSignal as any).any = any; (AbortSignal as any).timeout = timeout; }
    });
});

describe('connectSignal', () => {
    it('times out the connection phase, and clear() releases the timeout but not Stop', async () => {
        const a = connectSignal(null, 20);
        await new Promise(r => setTimeout(r, 60));
        expect(a.signal.aborted).toBe(true);

        const u = new AbortController();
        const b = connectSignal(u.signal, 20);
        b.clear();
        await new Promise(r => setTimeout(r, 60));
        expect(b.signal.aborted).toBe(false);
        u.abort();
        expect(b.signal.aborted).toBe(true);
    });
});

describe('Stop reaches MCP requests', () => {
    beforeEach(() => { localStorage.removeItem('fg_mcp_servers'); W.fetch.mockReset(); });
    it('aborts the in-flight request when the user presses Stop', async () => {
        let seen: AbortSignal | undefined;
        W.fetch.mockImplementation((_u: string, init: any) => new Promise((_res, rej) => {
            seen = init.signal;
            init.signal?.addEventListener('abort', () => rej(init.signal.reason), { once: true });
        }));
        localStorage.setItem('fg_mcp_servers', JSON.stringify([{ id: 'hung', name: 'hung', url: 'https://hung.example.com/mcp',
            enabled: true, enabledTools: ['t'], tools: [{ name: 't' }] }]));
        const ctrl = new AbortController();
        W.activeAbortController = ctrl;
        try {
            const p = W.executeToolAsync('mcp__hung__t', {});
            await new Promise(r => setTimeout(r, 10));
            expect(seen).toBeDefined();
            expect(seen!.aborted).toBe(false);
            ctrl.abort();
            expect(seen!.aborted).toBe(true);
            await p.catch(() => {});
        } finally { W.activeAbortController = null; }
    });
});
