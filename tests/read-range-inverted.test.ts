// read_file with start_line past end_line reads on from start_line instead of failing the step.
// v0.59: 77 such errors, most start = end + 1 ("continue after line 1850" with a stale end).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setWorkspaceAdapter } from '../workspace.ts';

const W = window as any;
const file = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n');

beforeAll(async () => { await import('../tools.ts'); });
beforeEach(() => {
    W.mainAgentRole = null;
    setWorkspaceAdapter({
        agentReadFile: async () => file,
        agentListFiles: async () => [{ name: 'f.py', size: file.length }],
        agentWriteFile: async () => {}, agentDeleteFile: async () => {},
        agentFileMtime: async () => null, agentListFilesInDir: async () => [],
    } as any);
});
afterAll(() => setWorkspaceAdapter(null));

describe('read_file inverted range', () => {
    it('start = end + 1: reads from start_line with a note', async () => {
        const r = await W.executeToolAsync('read_file', { path: 'f.py', start_line: 201, end_line: 200 });
        expect(r.error).toBeUndefined();
        expect(r.start_line).toBe(201);
        expect(r.content.split('\n')[0]).toBe('line 201');
        expect(r.note).toMatch(/end_line \(200\) was before start_line \(201\)/);
    });
    it('a start past the end of the file still says so', async () => {
        const r = await W.executeToolAsync('read_file', { path: 'f.py', start_line: 1300, end_line: 446 });
        expect(r.error).toBeUndefined();
        expect(r.note).toMatch(/exceeds file length \(300 lines\)/);
    });
});

// Y012: a worker's own base64 write is read back before its commit as the committed record reads it.
describe('read_file of a worker\'s staged base64 write', () => {
    const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');
    const staged = (path: string, bytes: number[]) => ({ snapshot: new Map(), staging: new Map(), binary: new Map([[path, b64(bytes)]]), depth: 0 });
    it('reads UTF-16 with a BOM and Windows-1252 as text, and still refuses bytes that are not text', async () => {
        const utf16 = await W.executeToolAsync('read_file', { path: 'u.txt' }, staged('u.txt', [0xff, 0xfe, 0x43, 0, 0xe9, 0]));
        expect(utf16.content).toBe('Cé');
        const cp1252 = await W.executeToolAsync('read_file', { path: 'w.txt' }, staged('w.txt', [0x43, 0x61, 0x66, 0xe9, 0x20, 0x80]));
        expect(cp1252.content).toBe('Café €');
        expect((await W.executeToolAsync('read_file', { path: 'n.txt' }, staged('n.txt', [0x41, 0, 0xff, 0x80]))).error).toMatch(/written as binary/);
    });
});

// Y015: a ledger/progress file that is missing reads as empty; one that exists but cannot be read is an error.
describe('read_file of a ledger that cannot be read', () => {
    const readWith = async (message: string, path = 'fg-tasks/ledger.md') => {
        setWorkspaceAdapter({ agentReadFile: async () => { throw new Error(message); }, agentListFiles: async () => [], agentWriteFile: async () => {}, agentDeleteFile: async () => {}, agentFileMtime: async () => null, agentListFilesInDir: async () => [] } as any);
        return W.executeToolAsync('read_file', { path });
    };
    it('missing: empty content; permission denied or a directory: the error', async () => {
        expect((await readWith('File not found: fg-tasks/ledger.md')).content).toBe('');
        expect((await readWith('Permission denied reading "fg-tasks/ledger.md".')).error).toMatch(/Permission denied/);
        expect((await readWith('"progress.md" is a directory — use list_files', 'progress.md')).error).toMatch(/directory/);
    });
});
