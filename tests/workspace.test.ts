/**
 * Workspace tests — IndexedDB CRUD + unified agent file API.
 */
import { IDBFactory } from 'fake-indexeddb';

// Each test gets a fresh database so there's no cross-test state.
beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    await window.initDB();
});

// ── Low-level IndexedDB helpers ───────────────────────────────────────────────

describe('writeWorkspaceFile / readWorkspaceFile', () => {
    it('writes and reads a file', async () => {
        await window.writeWorkspaceFile('hello.txt', 'Hello World');
        const rec = await window.readWorkspaceFile('hello.txt');
        expect(rec.name).toBe('hello.txt');
        expect(rec.content).toBe('Hello World');
    });

    it('returns null for a missing file', async () => {
        const rec = await window.readWorkspaceFile('nonexistent.txt');
        expect(rec).toBeNull();
    });

    it('overwrites file on second write', async () => {
        await window.writeWorkspaceFile('f.txt', 'v1');
        await window.writeWorkspaceFile('f.txt', 'v2');
        const rec = await window.readWorkspaceFile('f.txt');
        expect(rec.content).toBe('v2');
    });

    it('stores a lastModified timestamp', async () => {
        const before = Date.now();
        await window.writeWorkspaceFile('ts.txt', 'data');
        const after = Date.now();
        const rec = await window.readWorkspaceFile('ts.txt');
        expect(rec.lastModified).toBeGreaterThanOrEqual(before);
        expect(rec.lastModified).toBeLessThanOrEqual(after);
    });
});

describe('listWorkspaceFiles', () => {
    it('returns empty array when no files', async () => {
        const files = await window.listWorkspaceFiles();
        expect(files).toEqual([]);
    });

    it('lists all written files', async () => {
        await window.writeWorkspaceFile('a.txt', 'aaa');
        await window.writeWorkspaceFile('b.md',  'bbb');
        const files = await window.listWorkspaceFiles();
        const names = files.map(f => f.name);
        expect(names).toContain('a.txt');
        expect(names).toContain('b.md');
    });
});

describe('deleteWorkspaceFile', () => {
    it('removes the file', async () => {
        await window.writeWorkspaceFile('gone.txt', 'bye');
        await window.deleteWorkspaceFile('gone.txt');
        const rec = await window.readWorkspaceFile('gone.txt');
        expect(rec).toBeNull();
    });

    it('does not error when deleting non-existent file', async () => {
        await expect(window.deleteWorkspaceFile('nope.txt')).resolves.not.toThrow();
    });
});

// ── Unified agent file API ────────────────────────────────────────────────────

describe('agentWriteFile / agentReadFile', () => {
    it('writes then reads workspace file', async () => {
        await window.agentWriteFile('data.json', '{"x":1}');
        const content = await window.agentReadFile('data.json');
        expect(content).toBe('{"x":1}');
    });

    it('throws for missing file', async () => {
        await expect(window.agentReadFile('missing.txt'))
            .rejects.toThrow('File not found');
    });

    it('overwrites existing file', async () => {
        await window.agentWriteFile('notes.md', '# v1');
        await window.agentWriteFile('notes.md', '# v2');
        expect(await window.agentReadFile('notes.md')).toBe('# v2');
    });
});

describe('agentDeleteFile', () => {
    it('deletes a workspace file', async () => {
        await window.agentWriteFile('tmp.txt', 'delete me');
        await window.agentDeleteFile('tmp.txt');
        await expect(window.agentReadFile('tmp.txt')).rejects.toThrow();
    });

    it('silently succeeds for local/ path when no FSA open (graceful fallback)', async () => {
        // agentDeleteFile tries FSA first, falls back to IDB; no error when file absent
        await expect(window.agentDeleteFile('local/file.txt')).resolves.not.toThrow();
    });
});

describe('agentListFiles', () => {
    it('returns empty list initially', async () => {
        const files = await window.agentListFiles();
        expect(files).toEqual([]);
    });

    it('returns files with name and size metadata', async () => {
        await window.agentWriteFile('report.txt', '1234567890');
        const files = await window.agentListFiles();
        const entry = files.find(f => f.name === 'report.txt');
        expect(entry).toBeDefined();
        expect(entry.size).toBe(10);
        expect(entry.lastModified).toBeGreaterThan(0);
    });

    it('lists multiple files', async () => {
        await window.agentWriteFile('one.txt', 'a');
        await window.agentWriteFile('two.txt', 'bb');
        const files = await window.agentListFiles();
        expect(files.length).toBe(2);
    });

    it('does not include deleted files', async () => {
        await window.agentWriteFile('keep.txt', 'ok');
        await window.agentWriteFile('drop.txt', 'bye');
        await window.agentDeleteFile('drop.txt');
        const files = await window.agentListFiles();
        expect(files.find(f => f.name === 'drop.txt')).toBeUndefined();
        expect(files.find(f => f.name === 'keep.txt')).toBeDefined();
    });
});

describe('agentReadFile local/ path', () => {
    it('throws File not found when no FSA open and file absent', async () => {
        // No FSA handle + no IDB record → throws 'File not found: local/...'
        await expect(window.agentReadFile('local/readme.txt'))
            .rejects.toThrow('File not found');
    });
});

describe('openLocalFolder', () => {
    it('returns null silently when FSA is not supported', async () => {
        const orig = window.showDirectoryPicker;
        delete window.showDirectoryPicker;
        const result = await window.openLocalFolder();
        expect(result).toBeNull();
        if (orig) window.showDirectoryPicker = orig;
    });
});
