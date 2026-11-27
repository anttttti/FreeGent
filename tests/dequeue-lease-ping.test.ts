// A dequeue waits for another tab's lease holder to answer; a second dequeue during that wait must not ping again or release the lease.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import * as MsgQueue from '../msg-queue.ts';

const lease = vi.hoisted(() => ({ acquire: vi.fn(), alive: vi.fn(), release: vi.fn() }));
vi.mock('../chat-lease', async (orig) => ({ ...(await orig<any>()), acquireChatLease: lease.acquire, chatLeaseHolderAlive: lease.alive, releaseChatLease: lease.release }));

const W: any = window;
beforeAll(async () => {
    W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    await import('../chat-attachments.ts'); await import('../settings-ui.ts'); await import('../agent-core.ts'); await import('../chat-state.ts');
});
beforeEach(() => { MsgQueue.clear(); W.setAgentStreaming(false); W.setAiJob(''); vi.clearAllMocks(); vi.useFakeTimers(); });

describe('dequeue while the lease holder is being asked', () => {
    it('a second attempt returns at once: one ping, the first one decides, no lease is released under it', async () => {
        let answer!: (alive: boolean) => void;
        lease.acquire.mockReturnValue(false);                              // another tab holds the chat
        lease.alive.mockReturnValue(new Promise<boolean>(r => { answer = r; }));
        MsgQueue.enqueue('one', 'queued'); MsgQueue.enqueue('two', 'queued');
        const first = W._processQueue();
        await W._processQueue();                                           // while the first waits
        expect(lease.alive).toHaveBeenCalledTimes(1);
        expect(MsgQueue.getAll().map(m => m.text)).toEqual(['one', 'two']);
        answer(true);                                                      // the holder is alive: the message stays queued, tried again later
        await first;
        expect(lease.release).not.toHaveBeenCalled();
        expect(MsgQueue.size()).toBe(2);
        vi.useRealTimers(); MsgQueue.clear();
    });
});
