// TUI report: parallel workers' bash calls walked every file of a 160k-file workspace, twice each, synchronously — the screen froze for
// seconds and the workers crawled. The walk is asynchronous and leaves out folders the project's .gitignore names.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeExec } from '../native-exec.ts';

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fg-snap-'));
    for (const d of ['src', 'big', 'node_modules/pkg', 'deep/vendor']) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, '.gitignore'), '# comment\n/big/\nnode_modules/\nvendor\n*.log\n');
    writeFileSync(join(dir, 'src', 'a.txt'), 'a');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('execute_code write detection', () => {
    it('reports files the command wrote in the project and in folders .gitignore does not name', async () => {
        const exec = createNativeExec({ workspaceRoot: dir });
        const r = await exec('bash', 'echo x > src/new.txt; echo y >> src/a.txt');
        expect((r.files_written as string[]).sort()).toEqual(['src/a.txt', 'src/new.txt']);
    });
    it('does not walk ignored folders: a write there is not an edit of the project', async () => {
        const exec = createNativeExec({ workspaceRoot: dir });
        const r = await exec('bash', 'echo x > big/out.bin; echo y > node_modules/pkg/i.js; echo z > deep/vendor/v.js');
        expect(r.files_written).toBeUndefined();
    });
    it('a folder the ignore file does not name, and a wildcard pattern, are still walked', async () => {
        const exec = createNativeExec({ workspaceRoot: dir });
        const r = await exec('bash', 'mkdir -p other; echo x > other/o.txt; echo y > src/run.log');
        expect((r.files_written as string[]).sort()).toEqual(['other/o.txt', 'src/run.log']);
    });
    it('a workspace without an ignore file is walked in full', async () => {
        rmSync(join(dir, '.gitignore'));
        const exec = createNativeExec({ workspaceRoot: dir });
        const r = await exec('bash', 'echo x > big/out.bin');
        expect(r.files_written).toEqual(['big/out.bin']);
    });
    it('does not hold the event loop: the screen and other workers keep running while commands snapshot', async () => {
        for (let i = 0; i < 40; i++) { mkdirSync(join(dir, 'src', `d${i}`), { recursive: true }); for (let j = 0; j < 30; j++) writeFileSync(join(dir, 'src', `d${i}`, `f${j}`), 'x'); }
        const exec = createNativeExec({ workspaceRoot: dir });
        let worst = 0, last = Date.now();
        const iv = setInterval(() => { const n = Date.now(); worst = Math.max(worst, n - last - 10); last = n; }, 10);
        await Promise.all(Array.from({ length: 6 }, () => exec('bash', 'true')));
        clearInterval(iv);
        expect(worst).toBeLessThan(250);
    });
});
