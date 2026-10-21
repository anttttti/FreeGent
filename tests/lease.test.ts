import { describe, it, expect, beforeEach } from 'vitest';
import { lease, revokeLeases, liveLeases } from '../lease.ts';
import { bumpWorkspaceEpoch, workspaceEpoch } from '../exec-limits.ts';

const W: any = globalThis;
beforeEach(() => { localStorage.clear(); W.activeChatId = 'A'; revokeLeases('t'); });

describe('lease conditions', () => {
    it('is valid until revoked, and revoke runs the cleanups once', () => {
        const t = lease('t'); let n = 0;
        t.onInvalid(() => n++);
        expect(t.valid()).toBe(true);
        t.revoke(); t.revoke();
        expect(t.valid()).toBe(false);
        expect(n).toBe(1);
    });
    it('activeChat: invalid once the reader is in another chat; without it the lease follows its chat', () => {
        const follow = lease('t', { chat: 'A', activeChat: true }), own = lease('t', { chat: 'A' });
        W.activeChatId = 'B';
        expect(follow.valid()).toBe(false);
        expect(own.valid()).toBe(true);
        expect(own.chat).toBe('A');
    });
    it('epoch: a project replace invalidates, and the cleanup runs when the work comes back', () => {
        const t = lease('t', { epoch: 'now' }); let cleaned = 0;
        t.onInvalid(() => cleaned++);
        bumpWorkspaceEpoch();
        expect(cleaned).toBe(0);                 // nobody has asked yet
        expect(t.finish()).toBe(false);
        expect(cleaned).toBe(1);
        expect(workspaceEpoch()).toBeGreaterThan(0);
    });
    it('node: a dialog that left the document invalidates', () => {
        const d = document.createElement('div'); document.body.appendChild(d);
        const t = lease('t', { node: d });
        expect(t.valid()).toBe(true);
        d.remove();
        expect(t.valid()).toBe(false);
    });
    it('check: any condition, evaluated on demand', () => {
        let ok = true;
        const t = lease('t', { check: () => ok });
        expect(t.valid()).toBe(true);
        ok = false;
        expect(t.valid()).toBe(false);
    });
});

describe('finishing', () => {
    it('finishing valid never runs the cleanups, even if the world changes afterwards', () => {
        const t = lease('t', { epoch: 'now' }); let n = 0;
        t.onInvalid(() => n++);
        expect(t.finish()).toBe(true);
        bumpWorkspaceEpoch();
        t.valid();
        expect(n).toBe(0);
    });
    it('onInvalid on a lease that is already invalid runs at once', () => {
        const t = lease('t'); t.revoke(); let n = 0;
        t.onInvalid(() => n++);
        expect(n).toBe(1);
    });
    it('a throwing cleanup does not stop the others or the caller', () => {
        const t = lease('t'); let n = 0;
        t.onInvalid(() => { throw new Error('x'); }); t.onInvalid(() => n++);
        expect(() => t.revoke()).not.toThrow();
        expect(n).toBe(1);
    });
});

describe('registry', () => {
    it('latest: a new lease revokes the earlier ones of its kind only', () => {
        const a = lease('t', { latest: true }), other = lease('u');
        const b = lease('t', { latest: true });
        expect(a.valid()).toBe(false); expect(b.valid()).toBe(true); expect(other.valid()).toBe(true);
        other.revoke();
    });
    it('revokeLeases takes a predicate, and finished leases are not touched', () => {
        const keep = lease('t', { meta: { keep: true } }), drop = lease('t', { meta: { keep: false } }), done = lease('t');
        done.finish();
        expect(revokeLeases<{ keep: boolean }>('t', l => !l.meta.keep)).toBe(1);
        expect(keep.valid()).toBe(true); expect(drop.valid()).toBe(false);
        expect(liveLeases('t')).toEqual([keep]);
    });
});
