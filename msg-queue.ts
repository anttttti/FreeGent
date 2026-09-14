// msg-queue.ts — FreeGent pending-message queue.
// Pure module; no DOM, no Ink, no imports — works in browser and JSDOM identically.
// The queue holds messages the user submitted while the agent was busy.
// Each message is either 'queued' (waits its turn) or 'steering' (interrupts the
// current turn as soon as it reaches the head of the queue).

export type QueueMode = 'steering' | 'queued';

export interface QueuedMsg {
    id:   string;
    text: string;
    mode: QueueMode;
}

const _queue: QueuedMsg[]            = [];
const _listeners = new Set<() => void>();
let   _nextId = 0;

function _notify(): void {
    for (const fn of _listeners) fn();
}

// ── Mutations ──────────────────────────────────────────────────────────────────

export function enqueue(text: string, mode: QueueMode): QueuedMsg {
    const msg: QueuedMsg = { id: `mq${++_nextId}`, text, mode };
    _queue.push(msg);
    _notify();
    return msg;
}

export function cancel(id: string): void {
    const i = _queue.findIndex(m => m.id === id);
    if (i === -1) return;
    _queue.splice(i, 1);
    _notify();
}

/** Toggle or set the mode of a queued message. */
export function setMode(id: string, mode: QueueMode): void {
    const m = _queue.find(m => m.id === id);
    if (!m || m.mode === mode) return;
    m.mode = mode;
    _notify();
}

/** Move a message one slot toward the head (delta = -1) or tail (delta = 1). */
export function move(id: string, delta: -1 | 1): void {
    const i = _queue.findIndex(m => m.id === id);
    if (i === -1) return;
    const j = i + delta;
    if (j < 0 || j >= _queue.length) return;
    [_queue[i], _queue[j]] = [_queue[j], _queue[i]];
    _notify();
}

/** Remove and return the first message. */
export function shift(): QueuedMsg | undefined {
    if (!_queue.length) return undefined;
    const msg = _queue.shift()!;
    _notify();
    return msg;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export function peek(): QueuedMsg | undefined           { return _queue[0]; }
export function getAll(): readonly QueuedMsg[]          { return [..._queue]; }
export function size(): number                          { return _queue.length; }

// ── Pub/sub ───────────────────────────────────────────────────────────────────

export function subscribe(fn: () => void): () => void {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
}
