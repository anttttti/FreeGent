// codex R48-001: an existing EMPTY directory called workspace is a directory, not the bash mount prefix: workspace/new.txt must not be redirected
// onto the project root, where it replaced another file.
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFsAdapter } from '../node-fs-adapter.ts';

const W: any = window;
const dirs: string[] = [];
afterEach(() => { W.setWorkspaceAdapter?.(null); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const root = () => { const d = mkdtempSync(join(tmpdir(), 'fg-r48-')); dirs.push(d); return d; };
beforeAll(async () => { await import('../workspace.ts'); await import('../tools.ts'); });
const write = (path: string, content: string) => W.executeToolAsync('write_file', { path, content });

describe('write_file with a workspace/ prefix', () => {
    it('absent directory: the prefix is the mount point and the file lands at the root (unchanged)', async () => {
        const d = root(); W.setWorkspaceAdapter(new NodeFsAdapter(d));
        await write('workspace/a.txt', 'A');
        expect(readFileSync(join(d, 'a.txt'), 'utf8')).toBe('A');
    });
    it('an EMPTY directory called workspace is a real directory: the file goes inside it and the root file is untouched', async () => {
        const d = root(); mkdirSync(join(d, 'workspace')); writeFileSync(join(d, 'own-new.txt'), 'ROOT_PREEXISTING');
        W.setWorkspaceAdapter(new NodeFsAdapter(d));
        await write('workspace/own-new.txt', 'NESTED');
        expect(readFileSync(join(d, 'own-new.txt'), 'utf8')).toBe('ROOT_PREEXISTING');
        expect(readFileSync(join(d, 'workspace', 'own-new.txt'), 'utf8')).toBe('NESTED');
    });
    it('a populated directory is kept as before', async () => {
        const d = root(); mkdirSync(join(d, 'workspace')); writeFileSync(join(d, 'workspace', 'x'), 'x');
        W.setWorkspaceAdapter(new NodeFsAdapter(d));
        await write('workspace/y.txt', 'Y');
        expect(existsSync(join(d, 'workspace', 'y.txt'))).toBe(true);
        expect(existsSync(join(d, 'y.txt'))).toBe(false);
    });
});
describe('agentDirExists', () => {
    it('true for an empty directory, false for a file and for nothing', async () => {
        const d = root(); mkdirSync(join(d, 'empty')); writeFileSync(join(d, 'f'), 'f');
        const a = new NodeFsAdapter(d);
        expect([await a.agentDirExists('empty'), await a.agentDirExists('f'), await a.agentDirExists('nope')]).toEqual([true, false, false]);
    });
});
