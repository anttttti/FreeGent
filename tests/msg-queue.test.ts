// tests/msg-queue.test.ts — unit tests for the message queue module.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    enqueue, cancel, setMode, move, shift, peek, getAll, size, subscribe,
    type QueueMode,
} from '../msg-queue.js';

// Reset queue between tests by shifting everything out.
beforeEach(() => { while (shift()) {} });

describe('enqueue', () => {
    it('adds a message and returns it', () => {
        const m = enqueue('hello', 'queued');
        expect(m.text).toBe('hello');
        expect(m.mode).toBe('queued');
        expect(typeof m.id).toBe('string');
        expect(size()).toBe(1);
    });

    it('ids are unique across multiple enqueues', () => {
        const a = enqueue('a', 'queued');
        const b = enqueue('b', 'steering');
        expect(a.id).not.toBe(b.id);
    });

    it('appends to the tail', () => {
        enqueue('first', 'queued');
        enqueue('second', 'queued');
        const all = getAll();
        expect(all[0].text).toBe('first');
        expect(all[1].text).toBe('second');
    });
});

describe('shift', () => {
    it('removes and returns the head', () => {
        enqueue('a', 'queued');
        enqueue('b', 'queued');
        const head = shift();
        expect(head?.text).toBe('a');
        expect(size()).toBe(1);
        expect(getAll()[0].text).toBe('b');
    });

    it('returns undefined on empty queue', () => {
        expect(shift()).toBeUndefined();
    });
});

describe('peek', () => {
    it('returns head without removing it', () => {
        enqueue('x', 'queued');
        expect(peek()?.text).toBe('x');
        expect(size()).toBe(1);
    });

    it('returns undefined when empty', () => {
        expect(peek()).toBeUndefined();
    });
});

describe('cancel', () => {
    it('removes a message by id', () => {
        const m = enqueue('drop me', 'queued');
        enqueue('keep me', 'queued');
        cancel(m.id);
        expect(size()).toBe(1);
        expect(getAll()[0].text).toBe('keep me');
    });

    it('is a no-op for an unknown id', () => {
        enqueue('safe', 'queued');
        cancel('nonexistent');
        expect(size()).toBe(1);
    });
});

describe('setMode', () => {
    it('changes the mode of a message', () => {
        const m = enqueue('msg', 'queued');
        setMode(m.id, 'steering');
        expect(getAll()[0].mode).toBe('steering');
    });

    it('is a no-op when mode is already the target', () => {
        const m = enqueue('msg', 'steering');
        const before = getAll()[0];
        setMode(m.id, 'steering');
        expect(getAll()[0]).toBe(before);  // same reference — no mutation
    });

    it('is a no-op for unknown id', () => {
        enqueue('a', 'queued');
        setMode('bad-id', 'steering');
        expect(getAll()[0].mode).toBe('queued');
    });
});

describe('move', () => {
    it('moves a message toward the head (delta -1)', () => {
        const a = enqueue('a', 'queued');
        const b = enqueue('b', 'queued');
        move(b.id, -1);
        const all = getAll();
        expect(all[0].text).toBe('b');
        expect(all[1].text).toBe('a');
    });

    it('moves a message toward the tail (delta 1)', () => {
        const a = enqueue('a', 'queued');
        enqueue('b', 'queued');
        move(a.id, 1);
        const all = getAll();
        expect(all[0].text).toBe('b');
        expect(all[1].text).toBe('a');
    });

    it('clamps at head — cannot go before index 0', () => {
        const a = enqueue('a', 'queued');
        enqueue('b', 'queued');
        move(a.id, -1);  // already at head
        expect(getAll()[0].text).toBe('a');
    });

    it('clamps at tail — cannot go past last index', () => {
        enqueue('a', 'queued');
        const b = enqueue('b', 'queued');
        move(b.id, 1);  // already at tail
        expect(getAll()[1].text).toBe('b');
    });
});

describe('subscribe', () => {
    it('notifies on enqueue', () => {
        const spy = vi.fn();
        const unsub = subscribe(spy);
        enqueue('x', 'queued');
        expect(spy).toHaveBeenCalledTimes(1);
        unsub();
    });

    it('notifies on cancel', () => {
        const m = enqueue('x', 'queued');
        const spy = vi.fn();
        const unsub = subscribe(spy);
        cancel(m.id);
        expect(spy).toHaveBeenCalledTimes(1);
        unsub();
    });

    it('notifies on setMode', () => {
        const m = enqueue('x', 'queued');
        const spy = vi.fn();
        const unsub = subscribe(spy);
        setMode(m.id, 'steering');
        expect(spy).toHaveBeenCalledTimes(1);
        unsub();
    });

    it('notifies on move', () => {
        enqueue('a', 'queued');
        const b = enqueue('b', 'queued');
        const spy = vi.fn();
        const unsub = subscribe(spy);
        move(b.id, -1);
        expect(spy).toHaveBeenCalledTimes(1);
        unsub();
    });

    it('notifies on shift', () => {
        enqueue('x', 'queued');
        const spy = vi.fn();
        const unsub = subscribe(spy);
        shift();
        expect(spy).toHaveBeenCalledTimes(1);
        unsub();
    });

    it('does NOT notify after unsubscribe', () => {
        const spy = vi.fn();
        const unsub = subscribe(spy);
        unsub();
        enqueue('x', 'queued');
        expect(spy).not.toHaveBeenCalled();
    });

    it('multiple subscribers all fire', () => {
        const a = vi.fn(), b = vi.fn();
        const ua = subscribe(a), ub = subscribe(b);
        enqueue('x', 'queued');
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
        ua(); ub();
    });
});

describe('getAll', () => {
    it('returns a readonly view — mutating it does not affect the queue', () => {
        enqueue('a', 'queued');
        const snap = getAll() as any[];
        snap.push({ id: 'fake', text: 'injected', mode: 'queued' });
        expect(size()).toBe(1);
    });
});

describe('steering semantics — queue order under mode changes', () => {
    it('promoting tail item to steering does not reorder queue', () => {
        enqueue('first', 'queued');
        const second = enqueue('second', 'queued');
        setMode(second.id, 'steering');
        const all = getAll();
        // Queue order unchanged; caller must move it to head if they want it first.
        expect(all[0].text).toBe('first');
        expect(all[1].mode).toBe('steering');
    });

    it('first-in-queue steering message is peeked with correct mode', () => {
        enqueue('first', 'steering');
        enqueue('second', 'queued');
        expect(peek()?.mode).toBe('steering');
    });
});
