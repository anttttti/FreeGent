// The headless workspace listing is bounded: in a git repository it is the project's own files, however large the folders .gitignore leaves
// out. (TUI report: workers' commands, turn ends and list_files each stat-walked a 160k-file tree; 10 s of every 20 went to it.)
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { NodeFsAdapter } from '../node-fs-adapter.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'fg-list-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, stdio: 'pipe' });
function repo(): string {
    const d = tmp(); git(d, 'init', '-q');
    writeFileSync(join(d, '.gitignore'), '/bench/\n*.log\n');
    mkdirSync(join(d, 'src')); writeFileSync(join(d, 'src', 'a.ts'), 'a'); writeFileSync(join(d, 'README.md'), 'r');
    git(d, 'add', '-A'); git(d, 'commit', '-qm', 'i');
    return d;
}
const names = async (root: string) => (await new NodeFsAdapter(root).agentListFiles()).map(f => f.name).sort();

describe('listing in a git repository', () => {
    it('is the tracked and the untracked-but-not-ignored files, with size and time', async () => {
        const d = repo();
        mkdirSync(join(d, 'bench')); writeFileSync(join(d, 'bench', 'huge.bin'), 'x'); writeFileSync(join(d, 'run.log'), 'l');
        writeFileSync(join(d, 'new.ts'), 'n'); mkdirSync(join(d, 'node_modules')); writeFileSync(join(d, 'node_modules', 'm.js'), 'm');
        expect(await names(d)).toEqual(['.gitignore', 'README.md', 'new.ts', 'src/a.ts']);
        const f = (await new NodeFsAdapter(d).agentListFiles()).find(x => x.name === 'src/a.ts')!;
        expect(f.size).toBe(1); expect(f.lastModified).toBeGreaterThan(0);
    });
    it('leaves out dot-entries other than the project\'s own, and the noise folders, as before', async () => {
        const d = repo();
        mkdirSync(join(d, '.github')); writeFileSync(join(d, '.github', 'ci.yml'), 'c'); mkdirSync(join(d, '.venv')); writeFileSync(join(d, '.venv', 'v'), 'v');
        mkdirSync(join(d, 'dist')); writeFileSync(join(d, 'dist', 'o.js'), 'o'); git(d, 'add', '-f', 'dist/o.js');
        expect(await names(d)).toEqual(['.github/ci.yml', '.gitignore', 'README.md', 'src/a.ts']);
    });
    it('names the folders it leaves out, so "there is no bench/" is never concluded from the listing; an empty folder is not one of them', async () => {
        const d = repo();
        mkdirSync(join(d, 'bench')); writeFileSync(join(d, 'bench', 'huge.bin'), 'x'); mkdirSync(join(d, 'empty'));
        mkdirSync(join(d, 'node_modules'));
        expect(await new NodeFsAdapter(d).agentHiddenDirs()).toEqual(['bench', 'node_modules']);
    });
    it('a file deleted but still tracked is listed with size 0, not a crash', async () => {
        const d = repo(); rmSync(join(d, 'README.md'));
        const f = (await new NodeFsAdapter(d).agentListFiles()).find(x => x.name === 'README.md')!;
        expect(f.size).toBe(0);
    });
    it('the no-stat listing is the same set', async () => {
        const d = repo(); mkdirSync(join(d, 'bench')); writeFileSync(join(d, 'bench', 'x'), 'x');
        expect((await new NodeFsAdapter(d).agentListFilesNoStat()).map(f => f.name).sort()).toEqual(['.gitignore', 'README.md', 'src/a.ts']);
    });
});

describe('listing outside git', () => {
    it('is the walk it was: everything but the noise folders and dot-entries', async () => {
        const d = tmp(); mkdirSync(join(d, 'a')); writeFileSync(join(d, 'a', 'b.txt'), 'b'); mkdirSync(join(d, 'node_modules')); writeFileSync(join(d, 'node_modules', 'n'), 'n');
        writeFileSync(join(d, '.secret'), 's'); writeFileSync(join(d, 'top.txt'), 't');
        expect(await names(d)).toEqual(['a/b.txt', 'top.txt']);
    });
});

describe('a big ignored folder costs nothing', () => {
    it('100k files in an ignored folder: the listing is a few files and quick', async () => {
        const d = repo(); mkdirSync(join(d, 'bench'));
        for (let g = 0; g < 100; g++) { const sub = join(d, 'bench', `g${g}`); mkdirSync(sub); for (let i = 0; i < 1000; i++) writeFileSync(join(sub, `f${i}`), ''); }
        const t0 = Date.now();
        const a = new NodeFsAdapter(d);
        const [l, h] = await Promise.all([a.agentListFiles(), a.agentHiddenDirs()]);
        expect(l.map(f => f.name).sort()).toEqual(['.gitignore', 'README.md', 'src/a.ts']);
        expect(h).toEqual(['bench']);
        expect(Date.now() - t0).toBeLessThan(2_000);
    }, 120_000);
});

describe('hermes C16: bytes of a binary file survive a nested worker commit', () => {
    it('the adapter gives the bytes of a file that is not text', async () => {
        const d = tmp(); writeFileSync(join(d, 'a.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]));
        const b = await new NodeFsAdapter(d).agentReadFileBytes('a.bin');
        expect([...b]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
        await expect(new NodeFsAdapter(d).agentReadFileBytes('missing.bin')).rejects.toThrow();
    });
});
