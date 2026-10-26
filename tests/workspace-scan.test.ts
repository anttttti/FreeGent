// workspace-scan.ts: write detection and file lists that do not scale with the size of the tree (TUI freeze: 160k files in ignored folders).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { snapshotMarks, changedSince, listFiles } from '../workspace-scan.ts';
import { createNativeExec } from '../native-exec.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'fg-scan-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, stdio: 'pipe' });
function repo(): string {
    const d = tmp();
    git(d, 'init', '-q');
    writeFileSync(join(d, '.gitignore'), 'ignored-dir/\n*.log\n');
    mkdirSync(join(d, 'src')); writeFileSync(join(d, 'src', 'a.txt'), 'a'); writeFileSync(join(d, 'b.txt'), 'b');
    git(d, 'add', '-A'); git(d, 'commit', '-qm', 'init');
    return d;
}
const written = async (root: string, run: () => void | Promise<void>): Promise<string[] | null> => {
    const before = await snapshotMarks(root); await run(); const after = await snapshotMarks(root);
    return before && after ? (await changedSince(root, before, after)).sort() : null;
};

describe('write detection in a git repository', () => {
    it('reports edited tracked files and new files, and nothing for a clean tree', async () => {
        const d = repo();
        expect(await written(d, () => {})).toEqual([]);
        expect(await written(d, () => { appendFileSync(join(d, 'src', 'a.txt'), 'x'); writeFileSync(join(d, 'new.txt'), 'n'); mkdirSync(join(d, 'sub')); writeFileSync(join(d, 'sub', 'deep.txt'), 'd'); }))
            .toEqual(['new.txt', 'src/a.txt', 'sub/deep.txt']);
    });
    it('a second edit of a file that was already changed is still seen', async () => {
        const d = repo(); appendFileSync(join(d, 'b.txt'), '1');
        await new Promise(r => setTimeout(r, 15));
        expect(await written(d, () => { appendFileSync(join(d, 'b.txt'), '22'); })).toEqual(['b.txt']);
    });
    it('writes into ignored folders and ignored patterns are not edits of the project', async () => {
        const d = repo(); mkdirSync(join(d, 'ignored-dir'));
        expect(await written(d, () => { writeFileSync(join(d, 'ignored-dir', 'o.bin'), '1'); writeFileSync(join(d, 'run.log'), '2'); })).toEqual([]);
    });
    it('a commit or a revert is not the command writing the files it commits', async () => {
        const d = repo(); appendFileSync(join(d, 'src', 'a.txt'), 'x');
        expect(await written(d, () => { git(d, 'commit', '-qam', 'more'); })).toEqual([]);
    });
    it('works from a subfolder of the repository and names paths relative to it', async () => {
        const d = repo(); const sub = join(d, 'src');
        expect(await written(sub, () => { writeFileSync(join(sub, 'z.txt'), 'z'); writeFileSync(join(d, 'outside.txt'), 'o'); })).toEqual(['z.txt']);
    });
    it('does not take the index lock: the agent\'s own git add still works while a scan runs', async () => {
        const d = repo(); writeFileSync(join(d, 'c.txt'), 'c');
        const scans = Promise.all([snapshotMarks(d), snapshotMarks(d), snapshotMarks(d)]);
        git(d, 'add', 'c.txt');
        await scans;
    });
    it('is unknown (null), not slow, when the tree is too dirty to list', async () => {
        const d = repo(); mkdirSync(join(d, 'junk'));
        for (let i = 0; i < 5100; i++) writeFileSync(join(d, 'junk', `f${i}`), '');
        expect(await snapshotMarks(d)).toBeNull();
    });
});

describe('write detection outside git', () => {
    it('walks within a budget and reports changes', async () => {
        const d = tmp(); writeFileSync(join(d, 'a.txt'), 'a');
        expect(await written(d, () => { writeFileSync(join(d, 'n.txt'), 'n'); })).toEqual(['n.txt']);
    });
});

describe('execute_code through the scanner', () => {
    it('in a repo: files_written from git, a wildcard-ignored file is not reported', async () => {
        const d = repo(); const exec = createNativeExec({ workspaceRoot: d });
        const r = await exec('bash', 'echo x > src/new.txt; echo y > run.log');
        expect(r.files_written).toEqual(['src/new.txt']);
    });
    it('too dirty to list: no files_written (the loop then reads the command) and the command still runs', async () => {
        const d = repo(); mkdirSync(join(d, 'junk'));
        for (let i = 0; i < 5100; i++) writeFileSync(join(d, 'junk', `f${i}`), '');
        const r = await createNativeExec({ workspaceRoot: d })('bash', 'echo hi > out.txt; cat out.txt');
        expect(r.stdout.trim()).toBe('hi'); expect(r.exit_code).toBe(0); expect(r.files_written).toBeUndefined();
    });
});

describe('listFiles', () => {
    it('git: tracked and untracked files, not ignored ones, not the skipped folders', async () => {
        const d = repo(); mkdirSync(join(d, 'ignored-dir')); writeFileSync(join(d, 'ignored-dir', 'x'), '1'); writeFileSync(join(d, 'u.txt'), 'u');
        mkdirSync(join(d, 'build')); writeFileSync(join(d, 'build', 'o'), '1');
        const l = await listFiles(d, { maxEntries: 100, skipDirs: new Set(['build']) });
        expect(l.complete).toBe(true);
        expect(l.files.sort()).toEqual(['.gitignore', 'b.txt', 'src/a.txt', 'u.txt']);
    });
    it('a list over the limit says it is incomplete, in git and outside it', async () => {
        const d = repo(); for (let i = 0; i < 30; i++) writeFileSync(join(d, `n${i}`), '');
        expect((await listFiles(d, { maxEntries: 10 })).complete).toBe(false);
        const e = tmp(); for (let i = 0; i < 30; i++) writeFileSync(join(e, `n${i}`), '');
        expect((await listFiles(e, { maxEntries: 10 })).complete).toBe(false);
    });
});

describe('deleted files', () => {
    it('a file the command deleted is not reported as written, whether it was clean or already changed', async () => {
        const d = repo(); writeFileSync(join(d, 'scratch.txt'), 's'); appendFileSync(join(d, 'b.txt'), 'x');
        expect(await written(d, () => { rmSync(join(d, 'scratch.txt')); rmSync(join(d, 'b.txt')); rmSync(join(d, 'src', 'a.txt')); })).toEqual([]);
    });
});

describe('codex R14-001: a write that is committed inside the operation', () => {
    it('a file written and committed, and a file created and committed, are reported; a commit alone is not', async () => {
        const d = repo();
        expect(await written(d, () => { appendFileSync(join(d, 'src', 'a.txt'), 'x'); git(d, 'commit', '-qam', 'edit'); })).toEqual(['src/a.txt']);
        expect(await written(d, () => { writeFileSync(join(d, 'made.txt'), 'm'); git(d, 'add', 'made.txt'); git(d, 'commit', '-qm', 'create'); })).toEqual(['made.txt']);
        appendFileSync(join(d, 'b.txt'), 'dirty first');
        expect(await written(d, () => { git(d, 'commit', '-qam', 'record only'); })).toEqual([]);
    });
    it('a deletion that is committed is not a written file', async () => {
        const d = repo();
        expect(await written(d, () => { rmSync(join(d, 'b.txt')); git(d, 'commit', '-qam', 'rm'); })).toEqual([]);
    });
});

describe('codex R12-001: nesting deeper than the walk goes is an incomplete scan, not a complete one', () => {
    it('listFiles and snapshotMarks say so outside git', async () => {
        const d = tmp(); writeFileSync(join(d, 'shallow.txt'), 's');
        let p = d; for (let i = 0; i < 36; i++) { p = join(p, 'n'); mkdirSync(p); }
        writeFileSync(join(p, 'deep.txt'), 'd');
        const l = await listFiles(d, { maxEntries: 100 });
        expect(l.complete).toBe(false);
        expect(await snapshotMarks(d)).toBeNull();
        const ok = tmp(); let q = ok; for (let i = 0; i < 12; i++) { q = join(q, 'n'); mkdirSync(q); } writeFileSync(join(q, 'twelve.txt'), 't');
        expect((await listFiles(ok, { maxEntries: 100 })).complete).toBe(true);     // ordinary nesting is walked
    });
});

describe('a workspace folder that an enclosing repository ignores', () => {
    // The sim wrote workspaces under logs/ of the FreeGent repo, whose .gitignore ignores /logs/: ls-files and status said "nothing" for them.
    it('is listed by a walk, and its writes are seen', async () => {
        const d = repo(); mkdirSync(join(d, 'ignored-dir', 'ws'), { recursive: true });
        const ws = join(d, 'ignored-dir', 'ws');
        writeFileSync(join(ws, 'a.py'), '1'); mkdirSync(join(ws, 'fg-tasks')); writeFileSync(join(ws, 'fg-tasks', '001-t.md'), 't');
        const l = await listFiles(ws, { maxEntries: 1000 });
        expect(l.via).toBe('walk');
        expect(l.files.sort()).toEqual(['a.py', 'fg-tasks/001-t.md']);
        expect(await written(ws, () => { writeFileSync(join(ws, 'new.txt'), 'n'); })).toEqual(['new.txt']);
    });
    it('a folder the repository does not ignore still uses git', async () => {
        const d = repo();
        expect((await listFiles(d, { maxEntries: 1000 })).via).toBe('git');
    });
});
