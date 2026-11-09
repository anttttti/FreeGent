// codex R579: a cut listing (the Docker adapter's marker entry) is not the whole workspace, so the worker snapshot must not treat a missing name as absent.
import { describe, it, expect, afterEach } from 'vitest';
import '../workers.ts';
import { setWorkspaceAdapter } from '../workspace.ts';

const takeWorkspaceSnapshot = () => (window as any).takeWorkspaceSnapshot();
afterEach(() => setWorkspaceAdapter(null));
const adapter = (names: string[]) => ({
    agentListFiles: async () => names.map(name => ({ name, size: 1, lastModified: 1 })),
    agentReadFile: async () => '', agentWriteFile: async () => {}, agentDeleteFile: async () => {},
});

describe('takeWorkspaceSnapshot', () => {
    it('a full listing is a known inventory', async () => {
        setWorkspaceAdapter(adapter(['a.py', 'b.py']) as any);
        expect((await takeWorkspaceSnapshot()).inventoryKnown).toBe(true);
    });
    it('a listing with the truncation or failure marker is not', async () => {
        setWorkspaceAdapter(adapter(['a.py', '[listing truncated at 500 entries — use execute_code bash `find` or `ls` for full coverage]']) as any);
        expect((await takeWorkspaceSnapshot()).inventoryKnown).toBe(false);
        setWorkspaceAdapter(adapter(['[listing failed: no such container — the container may be stopped]']) as any);
        expect((await takeWorkspaceSnapshot()).inventoryKnown).toBe(false);
    });
});

describe('loadRoles with a cut listing (codex R688)', () => {
    it('keeps the custom roles already loaded when the listing carries the truncation marker', async () => {
        const W = window as any;
        W.rolesRegistry.set('mycustom', { name: 'mycustom', body: 'x' });
        try {
            setWorkspaceAdapter(adapter(['[listing truncated at 500 entries — use execute_code bash `find` or `ls` for full coverage]']) as any);
            await W.loadRoles();
            expect(W.rolesRegistry.has('mycustom')).toBe(true);
            setWorkspaceAdapter(adapter([]) as any);   // a complete listing without the role: it is gone
            await W.loadRoles();
            expect(W.rolesRegistry.has('mycustom')).toBe(false);
        } finally { W.rolesRegistry.delete('mycustom'); }
    });
});

