// turn-owner.ts — FreeGent: who owns the chat between a click on Send and the first streamed token.
//
// A turn used to be "owned" by five separate things: agentStreaming, aiJob ('runner' | 'init' | 'send-preparing' |
// 'turn-preparing'), a `_sendPreparing` boolean, the send's `_prep` record and the dequeued turn's `_turnPrep` lease. Stop,
// Escape, New chat, the queue and the Send button each read a different subset, and the Playwright reports kept finding the
// combination that one of them missed (codex 319-322, 329, 352-355). The preparation is now one slot:
//
//     const p = beginPreparation('send', { chat, check });   // null when something else already owns the chat
//     ...await attachments, scans, prelude...
//     if (!p.lease.valid()) return;                          // Escape, Stop, another chat: nothing was taken
//     endPreparation(p);                                     // the turn is streaming now (or the send gave up)
//
// Phases, derived and never stored:  idle → preparing → streaming → idle,  or  job (runner / init own the chat).
import { lease, type Lease } from './lease.js';

export interface Preparation {
    readonly kind: 'send' | 'turn';
    readonly lease: Lease;
    /** Ends a wait this preparation is parked in (attachments, a loading chat). */
    wake: () => void;
}
let _cur: Preparation | null = null;

export function currentPreparation(): Preparation | null { return _cur; }
export function preparing(): boolean { return _cur !== null; }

/** Claims the chat for a send or a dequeued turn. Returns null when a preparation is already in progress. */
export function beginPreparation(kind: Preparation['kind'], opts: { chat: string | null; check?: () => boolean }): Preparation | null {
    if (_cur) return null;
    const p: Preparation = { kind, lease: lease(kind === 'send' ? 'send-prep' : 'turn-prep', { chat: opts.chat, activeChat: true, check: opts.check }), wake: () => {} };
    _cur = p;
    return p;
}
/** Releases the slot. Safe to call twice, and for a preparation that is no longer current. */
export function endPreparation(p: Preparation | null): void {
    if (!p) return;
    p.lease.finish();
    if (_cur === p) _cur = null;
}
/** Escape / Stop / New chat / replacing the conversation: ends the preparation, wakes whatever it waits in. True if one was running. */
export function cancelPreparation(): boolean {
    const p = _cur;
    if (!p) return false;
    p.lease.revoke();
    p.wake();
    return true;
}
export type TurnPhase = 'idle' | 'preparing' | 'streaming' | 'job';
export function turnPhase(streaming: boolean, job: string): TurnPhase {
    return job ? 'job' : _cur ? 'preparing' : streaming ? 'streaming' : 'idle';
}
