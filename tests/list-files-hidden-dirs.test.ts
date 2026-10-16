import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NodeFsAdapter } from '../node-fs-adapter.js';

describe('list_files names the directories it leaves out', () => {
    const root = mkdtempSync(join(tmpdir(), 'fg-hidden-'));
    let exec: any;
    beforeAll(async () => {
        for (const d of ['build', '__pycache__', 'data']) mkdirSync(join(root, d));
        writeFileSync(join(root, 'app.py'), 'x');
        writeFileSync(join(root, 'build/out.bin'), 'x');
        writeFileSync(join(root, '__pycache__/app.pyc'), 'x');
        writeFileSync(join(root, 'data/r.csv'), 'x');
        const ws = await import('../workspace.js');
        ws.setWorkspaceAdapter(new NodeFsAdapter(root));
        Object.assign(globalThis, {
            agentListFiles: ws.agentListFiles, agentListFilesInDir: ws.agentListFilesInDir, agentHiddenDirs: ws.agentHiddenDirs,
        });
        exec = (await import('../tools.js')).executeToolAsync;
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('the adapter reports the hidden top-level directories', async () => {
        expect(await new NodeFsAdapter(root).agentHiddenDirs()).toEqual(['__pycache__', 'build']);
    });
    it('a root listing says build/ and __pycache__/ exist, and a path lists them', async () => {
        const root_ = await exec('list_files', {});
        expect(root_.files.map((f: any) => f.name)).toEqual(['app.py', 'data/r.csv']);
        expect(root_.note).toMatch(/build\/.*__pycache__\/|__pycache__\/.*build\//);
        const b = await exec('list_files', { path: 'build' });
        expect(b.files.map((f: any) => f.name)).toEqual(['build/out.bin']);
        const p = await exec('list_files', { path: '__pycache__/' });
        expect(p.files.map((f: any) => f.name)).toEqual(['__pycache__/app.pyc']);
    });
});
