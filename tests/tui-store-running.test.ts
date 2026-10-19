// tui-store.ts: "running" follows the work in flight, not whichever entry was finalized last (TUI report cases 038,
// 054, 082: a local notice, a session list or a finished /compact marked the TUI ready under a running reply, and the next
// message started a second turn on the same session).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Store from '../tui-store.ts';

let turnsRunning = false;
beforeEach(() => { vi.useFakeTimers(); Store.resetRunning(); turnsRunning = false; Store.setBusyProbe(() => turnsRunning); });
afterEach(() => { Store.setBusyProbe(null); vi.useRealTimers(); });
const tick = (n = 4) => vi.advanceTimersByTime(Store.SYNC_INTERVAL_MS * n);

describe('tui-store running flag', () => {
    it('a message sets running; it clears two checks after the work ended', () => {
        turnsRunning = true;
        Store.addUserMessage('first');
        expect(Store.getState().agentRunning).toBe(true);
        tick();
        expect(Store.getState().agentRunning).toBe(true);
        turnsRunning = false;
        tick(1);
        expect(Store.getState().agentRunning).toBe(true);      // one idle check is not enough: a queued turn may follow
        tick(2);
        expect(Store.getState().agentRunning).toBe(false);
    });
    it('a local notice finishing does not clear running while a reply is in flight', () => {
        turnsRunning = true;
        Store.addUserMessage('long task');
        const t = Store.addTurn();
        Store.finalizeTurn(t, '_Previous sessions_');           // /resume listing, a slash-command notice
        tick(6);
        expect(Store.getState().agentRunning).toBe(true);
    });
    it('a local operation (/compact) keeps running until it ends, even with no reply in flight', () => {
        Store.beginLocalOp();
        tick(6);
        expect(Store.getState().agentRunning).toBe(true);
        Store.endLocalOp();
        tick(4);
        expect(Store.getState().agentRunning).toBe(false);
    });
    it('goes back to ready when nothing is running at all (a send that failed before its turn started)', () => {
        Store.addUserMessage('x');
        tick(4);
        expect(Store.getState().agentRunning).toBe(false);
    });
    it('a second turn starting between two checks keeps the flag', () => {
        turnsRunning = true;
        Store.addUserMessage('a');
        turnsRunning = false; tick(1);
        turnsRunning = true;  tick(1);                          // the queued message's turn began
        turnsRunning = false; tick(1);
        expect(Store.getState().agentRunning).toBe(true);
    });
});
