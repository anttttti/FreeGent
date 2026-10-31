// Ctrl+X Ctrl+S: send the next waiting message into the running work now (WebUI and TUI share steerNextQueued).
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as MsgQueue from '../msg-queue.ts';

const W: any = window;
beforeAll(async () => {
    W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    await import('../chat-attachments.ts');
    await import('../settings-ui.ts');
    await import('../agent-core.ts');
    await import('../chat-state.ts');
});
beforeEach(() => { MsgQueue.clear(); W.setAgentStreaming(false); W.setAiJob(''); });
afterEach(() => { MsgQueue.clear(); W.setAgentStreaming(false); W.setAiJob(''); });

describe('steerNextQueued', () => {
    it('the first waiting message becomes a steering message at the head', () => {
        MsgQueue.enqueue('first', 'queued');
        const b = MsgQueue.enqueue('second', 'queued');
        const r = W.steerNextQueued('');
        expect(r).toEqual({ did: 'queued', text: 'first' });
        expect(MsgQueue.getAll().map(m => [m.text, m.mode])).toEqual([['first', 'steering'], ['second', 'queued']]);
        expect(MsgQueue.getAll()[1].id).toBe(b.id);
    });
    it('a message behind a steering one moves up to the head when steered', () => {
        const a = MsgQueue.enqueue('already', 'steering');
        MsgQueue.enqueue('later', 'queued');
        const r = W.steerNextQueued('');
        expect(r.text).toBe('later');
        expect(MsgQueue.getAll()[0].text).toBe('later');
        expect(MsgQueue.getAll().every(m => m.mode === 'steering')).toBe(true);
        expect(MsgQueue.getAll().some(m => m.id === a.id)).toBe(true);
    });
    it('with nothing queued, the box text is sent as a steering message while something runs', () => {
        W.setAgentStreaming(true);
        const r = W.steerNextQueued('  change course  ');
        expect(r).toEqual({ did: 'composer', text: 'change course' });
        expect(MsgQueue.getAll().map(m => [m.text, m.mode])).toEqual([['change course', 'steering']]);
    });
    it('does nothing when nothing runs, or there is nothing to send', () => {
        expect(W.steerNextQueued('hello').did).toBe('none');   // idle: Enter sends it
        W.setAgentStreaming(true);
        expect(W.steerNextQueued('   ').did).toBe('none');
        expect(MsgQueue.size()).toBe(0);
    });
    it('a message already steering is reported, not queued twice', () => {
        MsgQueue.enqueue('go', 'steering');
        expect(W.steerNextQueued('typed').did).toBe('queued');
        expect(MsgQueue.size()).toBe(1);
    });
});

describe('an asynchronous dequeue hook (the TUI copies the workspace for /rewind first)', () => {
    afterEach(() => { delete W._onQueueDequeue; });
    it('keeps the chat claimed while it runs: nothing else is dequeued or started in the gap', async () => {
        const { preparing } = await import('../turn-owner.ts');
        const seen: any = { during: null, second: null };
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        W._onQueueDequeue = async () => {
            await Promise.resolve();                       // the claim is taken as soon as the hook returns its promise
            seen.during = preparing();
            await W._processQueue();                       // a second dequeue attempt while the hook is awaited
            seen.second = MsgQueue.getAll().map(m => m.text);
            await gate;
        };
        MsgQueue.enqueue('one', 'queued'); MsgQueue.enqueue('two', 'queued');
        const run = W._processQueue();
        await new Promise(r => setTimeout(r, 20));
        expect(seen.during).toBe(true);
        expect(seen.second).toEqual(['two']);              // 'one' was taken, 'two' still waits
        release();
        await Promise.race([run, new Promise(r => setTimeout(r, 500))]);
        expect(preparing()).toBe(false);                   // the slot was handed on, not leaked
    });
});
