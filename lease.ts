// lease.ts — FreeGent: "is this async work still wanted?" in one place.
//
// Work that outlives the moment it was started in (a file read, a title request, a search, an upload, a send waiting for its
// attachments) has to ask, when it comes back, whether the world it started in still exists: the same chat, the same dialog,
// the same project. Each site used to carry its own test (`activeChatId !== id`, a counter, `overlay.isConnected`, a
// `cancelled` flag, an epoch compare), and the Playwright reports kept finding the place that forgot one or asked at the wrong
// moment. A lease names the conditions once, when the work starts:
//
//     const t = lease('upload', { epoch: workspaceEpoch(), node: overlay });
//     t.onInvalid(() => deleteOrphan(path));         // runs once if the lease is found invalid; never if it finished valid
//     const bytes = await read(path);
//     if (!t.finish()) return;                        // valid() plus cleanup bookkeeping; call it when the work ends
//
// A lease is valid while none of its conditions is broken:
//   - revoked      : revoke() or revokeLeases(kind, pred) was called (Clear, Escape, close, a newer search ...)
//   - activeChat   : the reader is still in `chat` (work that must not touch another chat's composer or list)
//   - epoch        : the project was not cleared or replaced (in this tab or another)
//   - node         : the dialog or element it belongs to is still in the document
//   - check        : any other condition, evaluated on demand (e.g. "the chat still carries the draft name")
// Work that should follow its chat around (a read that finishes into a parked chat) gives `chat` but not `activeChat`.
// `latest: true` makes a new lease revoke the earlier ones of its kind (a newer keystroke supersedes the search before it).

import { workspaceEpoch } from './exec-limits.js';

export interface LeaseOptions<M> {
    chat?: string | null;
    activeChat?: boolean;
    epoch?: number | 'now';
    node?: { isConnected: boolean } | null;
    check?: () => boolean;
    latest?: boolean;
    meta?: M;
}
export interface Lease<M = Record<string, never>> {
    readonly kind: string;
    readonly chat: string | null;
    readonly meta: M;
    /** The work moved to another chat on purpose (a send carried to a new chat): the lease now follows that one. */
    rebind(chat: string | null): void;
    /** True while none of the lease's conditions is broken. Finding it broken runs its onInvalid callbacks (once). */
    valid(): boolean;
    /** Ends the lease for good: later valid() calls are false. */
    revoke(): void;
    /** Runs `cb` once when the lease is found invalid (immediately if it already is). Not run when it finishes valid. */
    onInvalid(cb: () => void): void;
    /** The work is over: returns whether the lease was still valid, runs cleanups if not, and takes the lease out of the registry. */
    finish(): boolean;
}

const _live = new Set<LeaseImpl<any>>();
const _activeChat = (): string | null => (globalThis as any).activeChatId ?? null;

class LeaseImpl<M> implements Lease<M> {
    chat: string | null;
    readonly meta: M;
    private _revoked = false;
    private _done = false;
    private _cbs: (() => void)[] = [];
    private readonly _activeOnly: boolean;
    private readonly _epoch: number | undefined;
    private readonly _node: { isConnected: boolean } | null;
    private readonly _check: (() => boolean) | undefined;
    readonly kind: string;
    constructor(kind: string, o: LeaseOptions<M>) {
        this.kind = kind;
        this.chat = o.chat ?? null;
        this.meta = (o.meta ?? {}) as M;
        this._activeOnly = !!o.activeChat;
        this._epoch = o.epoch === 'now' ? workspaceEpoch() : o.epoch;
        this._node = o.node ?? null;
        this._check = o.check;
    }
    private _holds(): boolean {
        if (this._revoked) return false;
        if (this._activeOnly && _activeChat() !== this.chat) return false;
        if (this._epoch !== undefined && workspaceEpoch() !== this._epoch) return false;
        if (this._node && !this._node.isConnected) return false;
        if (this._check && !this._check()) return false;
        return true;
    }
    rebind(chat: string | null): void { this.chat = chat; }
    valid(): boolean {
        if (this._done && !this._revoked) return this._holds();
        const ok = this._holds();
        if (!ok) this._invalidate();
        return ok;
    }
    revoke(): void { this._revoked = true; this._invalidate(); }
    onInvalid(cb: () => void): void {
        if (this._revoked || (this._done && !this._holds())) { try { cb(); } catch { /* cleanup must not break the caller */ } return; }
        this._cbs.push(cb);
    }
    finish(): boolean {
        const ok = this.valid();
        this._done = true; _live.delete(this);
        this._cbs = [];
        return ok;
    }
    private _invalidate(): void {
        _live.delete(this);
        const cbs = this._cbs; this._cbs = [];
        for (const cb of cbs) { try { cb(); } catch { /* cleanup must not break the caller */ } }
    }
}

export function lease<M = Record<string, never>>(kind: string, opts: LeaseOptions<M> = {}): Lease<M> {
    if (opts.latest) revokeLeases(kind);
    const l = new LeaseImpl<M>(kind, opts);
    _live.add(l);
    return l;
}
/** Revoke every unfinished lease of `kind` (matching `pred`, when given). Returns how many. */
export function revokeLeases<M = any>(kind: string, pred?: (l: Lease<M>) => boolean): number {
    let n = 0;
    for (const l of [..._live]) if (l.kind === kind && (!pred || pred(l))) { l.revoke(); n++; }
    return n;
}
/** The unfinished leases of `kind` that are still valid. */
export function liveLeases<M = any>(kind: string): Lease<M>[] {
    return [..._live].filter(l => l.kind === kind && l.valid());
}
