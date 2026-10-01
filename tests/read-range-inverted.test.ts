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
