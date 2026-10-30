// opencode §4.1-4.3 and §12: a connected local folder and the workspace store agree about writes and deletes, and a failure in the folder is the
// operation's failure.
import 'fake-indexeddb/auto';
import { beforeAll, afterEach, it, expect, vi, describe } from 'vitest';

const W = window as any;
class MFile {
    kind = 'file';
    constructor(public name: string, public disk: Map<string, Uint8Array>, public fail: { write?: boolean }) {}
    async getFile() { const b = this.disk.get(this.name)!; return { size: b.length, lastModified: 1, arrayBuffer: async () => b.slice().buffer, text: async () => new TextDecoder().decode(b) }; }
    async createWritable() {
        const self = this;
        return { write: async (c: any) => { if (self.fail.write) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); self.disk.set(self.name, typeof c === 'string' ? new TextEncoder().encode(c) : new Uint8Array(c)); }, close: async () => {} };
    }
}
class MDir {
    name = 'Own folder'; kind = 'directory'; disk = new Map<string, Uint8Array>(); fail: { write?: boolean; remove?: boolean } = {};
    async *entries() { for (const n of this.disk.keys()) yield [n, new MFile(n, this.disk, this.fail)]; }
    async getFileHandle(name: string, opts: any = {}) {
        if (!this.disk.has(name)) { if (!opts.create) throw Object.assign(new Error('not found'), { name: 'NotFoundError' }); this.disk.set(name, new Uint8Array()); }
        return new MFile(name, this.disk, this.fail);
    }
    async removeEntry(name: string) { if (this.fail.remove) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); if (!this.disk.delete(name)) throw Object.assign(new Error('not found'), { name: 'NotFoundError' }); }
}
const text = (d: MDir, n: string) => d.disk.has(n) ? new TextDecoder().decode(d.disk.get(n)!) : null;

beforeAll(() => { vi.stubGlobal('isSecureContext', true); W.maybeRunInitAgent = async () => {}; W.generateAndShowSuggestion = async () => {}; });
afterEach(() => { W.closeFsaFolder(); vi.restoreAllMocks(); });
async function connect(files: Record<string, string> = {}) {
    localStorage.clear();
    const dir = new MDir();
    for (const [n, c] of Object.entries(files)) dir.disk.set(n, new TextEncoder().encode(c));
    W.showDirectoryPicker = vi.fn(async () => dir);
    await W.openLocalFolder(); await new Promise(r => setTimeout(r, 0));
    return dir;
}

describe('a bare path', () => {
    it('is written to the folder when the folder has the file, and a new bare file stays a workspace file', async () => {
        const dir = await connect({ 'existing.txt': 'DISK' });
        await W.agentWriteFile('existing.txt', 'CHANGED');
        expect(text(dir, 'existing.txt')).toBe('CHANGED');
        await W.agentWriteFile('brand-new.txt', 'NEW');
        expect(text(dir, 'brand-new.txt')).toBeNull();
        expect(await W.agentReadFile('brand-new.txt')).toBe('NEW');
    });
    it('a write the folder refuses fails, and the workspace copy is not changed behind it', async () => {
        const dir = await connect({ 'ro.txt': 'ORIGINAL' });
        await W.agentWriteFile('ro.txt', 'ORIGINAL');
        dir.fail.write = true;
        await expect(W.agentWriteFile('ro.txt', 'NEW')).rejects.toThrow(/quota/);
        expect(text(dir, 'ro.txt')).toBe('ORIGINAL');
        expect(await W.agentReadFile('ro.txt')).toBe('ORIGINAL');
    });
    it('a delete removes the file from the folder AND the workspace store, so a read does not bring it back', async () => {
        const dir = await connect({ 'existing.txt': 'DISK' });
        await W.agentWriteFile('existing.txt', 'CHANGED');             // now in both
        await W.agentDeleteFile('existing.txt');
        expect(text(dir, 'existing.txt')).toBeNull();
        expect(await W.readWorkspaceFile('existing.txt')).toBeFalsy();
        await expect(W.agentReadFile('existing.txt')).rejects.toThrow(/not found/i);
    });
    it('a delete the folder refuses fails and leaves both copies', async () => {
        const dir = await connect({ 'gone.txt': 'GONE' });
        await W.agentWriteFile('gone.txt', 'GONE');
        dir.fail.remove = true;
        await expect(W.agentDeleteFile('gone.txt')).rejects.toThrow(/denied/);
        expect(text(dir, 'gone.txt')).toBe('GONE');
        expect(await W.agentReadFile('gone.txt')).toBe('GONE');
    });
});

describe('local/ paths', () => {
    it('deleting one removes the folder file and a stale snapshot record; the read is "not found", not the snapshot', async () => {
        const dir = await connect({ 'stale.txt': 'DISK' });
        await W.writeWorkspaceFile('local/stale.txt', 'SNAPSHOT');
        expect(await W.agentReadFile('local/stale.txt')).toBe('DISK');
        await W.agentDeleteFile('local/stale.txt');
        expect(text(dir, 'stale.txt')).toBeNull();
        expect(await W.readWorkspaceFile('local/stale.txt')).toBeFalsy();
        await expect(W.agentReadFile('local/stale.txt')).rejects.toThrow(/not found/i);
    });
    it('with a folder synced, a local/ file the folder lacks is not served from an old snapshot', async () => {
        await connect({});
        await W.writeWorkspaceFile('local/old.txt', 'SNAPSHOT');
        await expect(W.agentReadFile('local/old.txt')).rejects.toThrow(/not found/i);
    });
});

// codex R232: a byte read of local/… served an old snapshot of a file the synced folder no longer has.
// codex R233/R234: a write or delete paused in the folder committed into the project that replaced the one it was started in.
describe('folder authority and project changes during a folder operation', () => {
    it('agentReadFileBytes of a local/ path the folder lacks is not found, like agentReadFile', async () => {
        await connect({});
        await W.writeWorkspaceFile('local/gone.txt', 'OLD SNAPSHOT');
        await expect(W.agentReadFile('local/gone.txt')).rejects.toThrow(/not found/);
        await expect(W.agentReadFileBytes('local/gone.txt')).rejects.toThrow(/not found/);
    });
    it('the record read the exec sandbox shell uses goes through the folder too (codex R268)', async () => {
        const dir = await connect({ 'live.txt': 'LIVE' });
        await W.writeWorkspaceFile('local/gone.txt', 'OLD SNAPSHOT');
        expect(await W.readWorkspaceRecord('local/gone.txt')).toBeNull();
        const rec = await W.readWorkspaceRecord('local/live.txt');
        expect(rec.encoding).toBe('base64');
        expect(atob(rec.content)).toBe('LIVE');
        void dir;
    });
    it('a write or delete whose project changes while the folder works is not applied to the workspace store', async () => {
        const { workspaceEpoch, bumpWorkspaceEpoch } = await import('../exec-limits.ts');
        const dir = await connect({ 'shared.txt': 'DISK' });
        await W.agentWriteFile('shared.txt', 'V1');
        let release!: () => void;
        const slowHas = vi.spyOn(dir, 'getFileHandle').mockImplementation(async function (this: any, name: string, opts: any) {
            await new Promise<void>(r => { release = r; });
            slowHas.mockRestore();
            return dir.getFileHandle(name, opts);
        } as any);
        const writing = W.agentWriteFile('shared.txt', 'FROM OLD PROJECT', null, { epoch: workspaceEpoch() });
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        bumpWorkspaceEpoch();
        release();
        await expect(writing).rejects.toThrow(/cleared or replaced/);
        expect(await W.agentReadFile('shared.txt')).toBe('V1');
        const deleting = W.agentDeleteFile('shared.txt', { epoch: workspaceEpoch() });
        bumpWorkspaceEpoch();
        await expect(deleting).rejects.toThrow(/cleared or replaced/);
        expect(await W.readWorkspaceFile('shared.txt')).toBeTruthy();
    });
});
