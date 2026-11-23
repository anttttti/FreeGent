// runPageCheck (tabs.ts): checks that want the separate window take turns. A check that fails before it has the window must hand its turn on, and a check waiting
// for its turn must end on Stop.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ensure = vi.hoisted(() => vi.fn());
vi.mock('../check-window.ts', async (orig) => ({ ...(await orig<any>()), ensureCheckWindow: ensure, wantsCheckWindow: () => true, releaseCheckWindow: () => {} }));
import './setup.js';
const W = window as any;
const within = <T,>(p: Promise<T>, ms: number): Promise<T | 'timeout'> => Promise.race([p, new Promise<'timeout'>(r => setTimeout(() => r('timeout'), ms))]);

describe('check_page window turns', () => {
    beforeEach(async () => {
        ensure.mockReset();
        await import('../tabs.ts');
        W.agentReadFile = async () => '<html><body>x</body></html>';
    });
    it('a check that throws before it has the window does not block the next one', async () => {
        ensure.mockRejectedValue(new Error('window.open failed'));
        await expect(W.runPageCheck('index.html')).rejects.toThrow(/window\.open failed/);
        const second = within(W.runPageCheck('index.html').catch((e: Error) => e.message), 2000);
        expect(await second).toMatch(/window\.open failed/);   // it reached ensureCheckWindow: it was not left waiting
        expect(ensure).toHaveBeenCalledTimes(2);
    });
    it('a check waiting for its turn ends on Stop, and the next one still waits for the one using the window', async () => {
        let free!: () => void;
        ensure.mockImplementationOnce(() => new Promise<boolean>(r => { free = () => r(false); }));   // the first check holds the window
        const first = W.runPageCheck('index.html', { waitMs: 10 }).catch(() => 'ended');
        await new Promise(r => setTimeout(r, 20));
        const ac = new AbortController();
        W.setActiveAbortController(ac);
        const waiting = W.runPageCheck('index.html');
        await new Promise(r => setTimeout(r, 20));
        ac.abort();
        expect(await within(waiting, 1000)).toEqual({ error: 'check_page stopped' });
        expect(ensure).toHaveBeenCalledTimes(1);                                                      // the stopped one never asked for the window
        W.setActiveAbortController(null);
        ensure.mockResolvedValue(false);
        free(); void first;
    });
});
