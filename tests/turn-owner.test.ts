import { describe, it, expect, afterEach } from 'vitest';
import { beginPreparation, endPreparation, cancelPreparation, currentPreparation, preparing, turnPhase } from '../turn-owner.ts';
import { aiBusy } from '../state.ts';
import { workspaceEpoch, bumpWorkspaceEpoch, snapshotWorkspace, snapshotEpoch } from '../exec-limits.ts';

afterEach(() => { endPreparation(currentPreparation()); });

describe('turn-owner: one preparation slot', () => {
    it('a second claim is refused while one is held; busy and phase follow the slot', () => {
        expect(preparing()).toBe(false); expect(aiBusy()).toBe(false); expect(turnPhase(false, '')).toBe('idle');
        const p = beginPreparation('send', { chat: 'A' })!;
        expect(p).toBeTruthy();
        expect(beginPreparation('turn', { chat: 'A' })).toBeNull();
        expect(aiBusy()).toBe(true); expect(turnPhase(false, '')).toBe('preparing');
        expect(turnPhase(true, '')).toBe('preparing');       // a preparation precedes streaming
        expect(turnPhase(false, 'runner')).toBe('job');
        endPreparation(p);
        expect(aiBusy()).toBe(false); expect(turnPhase(true, '')).toBe('streaming');
    });
    it('cancel revokes the lease and wakes the waiter; ending twice is harmless', () => {
        const p = beginPreparation('send', { chat: 'A' })!;
        let woke = false; p.wake = () => { woke = true; };
        expect(cancelPreparation()).toBe(true);
        expect(woke).toBe(true); expect(p.lease.valid()).toBe(false);
        endPreparation(p); endPreparation(p);
        expect(cancelPreparation()).toBe(false);
        expect(beginPreparation('turn', { chat: 'A' })).toBeTruthy();
    });
    it('a stale ending does not release a newer preparation', () => {
        const a = beginPreparation('send', { chat: 'A' })!;
        endPreparation(a);
        const b = beginPreparation('turn', { chat: 'A' })!;
        endPreparation(a);
        expect(currentPreparation()).toBe(b);
    });
});

describe('epoch-stamped workspace writes', () => {
    it('snapshots carry the epoch they were taken in', () => {
        const s = snapshotWorkspace([]);
        expect(snapshotEpoch(s)).toBe(workspaceEpoch());
        expect(snapshotEpoch(new Map())).toBeUndefined();
        bumpWorkspaceEpoch();
        expect(snapshotEpoch(s)).not.toBe(workspaceEpoch());
    });
});

describe('the workspace refuses a stamped write from an earlier project', () => {
    it('agentWriteFile and agentDeleteFile with an old epoch change nothing', async () => {
        const { agentWriteFile, agentDeleteFile } = await import('../workspace.ts');
        const old = workspaceEpoch();
        bumpWorkspaceEpoch();
        await expect(agentWriteFile('stamped.txt', 'x', null, { epoch: old })).rejects.toThrow(/cleared or replaced/);
        await expect(agentDeleteFile('stamped.txt', { epoch: old })).rejects.toThrow(/cleared or replaced/);
    });
});
