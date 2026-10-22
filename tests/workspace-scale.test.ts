// Scaling: a command's overhead and the event-loop stall it causes must not grow with the number of files in the workspace.
// (TUI freeze: 160k files, two synchronous walks per bash call, 8 parallel workers — 20 s for 8 commands, 10 s stalls.)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createNativeExec } from '../native-exec.ts';
import { takeSnapshot, dropSnapshot } from '../tui-checkpoint.ts';
import { startLoopWatch, type Stall } from '../loop-watch.ts';

const BIG = 100_000;
let git: string, plain: string;
function fill(root: string, sub: string, n: number) {
    // 1000 files per folder, like a vendored tree or a benchmark's logs
    for (let d = 0; d < n / 1000; d++) {
        const dir = join(root, sub, `d${d}`); mkdirSync(dir, { recursive: true });
        for (let i = 0; i < 1000; i++) writeFileSync(join(dir, `f${i}.txt`), '');
    }
}
beforeAll(() => {
    // A repository whose ignored folder holds 100k files, and a plain folder (no git) with the same ignored folder named in .gitignore.
    git = mkdtempSync(join(tmpdir(), 'fg-scale-git-')); plain = mkdtempSync(join(tmpdir(), 'fg-scale-plain-'));
    for (const root of [git, plain]) {
        writeFileSync(join(root, '.gitignore'), '/huge/\n'); writeFileSync(join(root, 'a.txt'), 'a');
    }
    execFileSync('git', ['init', '-q'], { cwd: git });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: git });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i'], { cwd: git });
    fill(git, 'huge', BIG); fill(plain, 'huge', BIG);
}, 120_000);
afterAll(() => { rmSync(git, { recursive: true, force: true }); rmSync(plain, { recursive: true, force: true }); });

async function eightCommands(root: string): Promise<{ ms: number; worstStall: number; written: number }> {
    const stalls: Stall[] = [];
    const stop = startLoopWatch(s => stalls.push(s), { intervalMs: 10, thresholdMs: 30 });
    const exec = createNativeExec({ workspaceRoot: root });
    const t0 = Date.now();
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => exec('bash', `echo ${i} > out${i}.txt; grep -c x a.txt || true`)));
    const ms = Date.now() - t0;
    stop();
    return { ms, worstStall: Math.max(0, ...stalls.map(s => s.ms)), written: rs.reduce((n, r) => n + (r.files_written?.length ?? 0), 0) };
}

describe(`a workspace with ${BIG} files in an ignored folder`, () => {
    it('git repo: 8 parallel commands finish quickly and never hold the event loop', async () => {
        const r = await eightCommands(git);
        expect(r.written).toBeGreaterThanOrEqual(8);          // still detects the writes
        expect(r.ms).toBeLessThan(5_000);
        expect(r.worstStall).toBeLessThan(250);
    }, 60_000);
    it('not a repo, folder named in .gitignore: the same', async () => {
        const r = await eightCommands(plain);
        expect(r.written).toBeGreaterThanOrEqual(8);
        expect(r.ms).toBeLessThan(5_000);
        expect(r.worstStall).toBeLessThan(250);
    }, 60_000);
    it('not a repo, nothing ignored: the walk gives up within its budget and the command still returns', async () => {
        const open = mkdtempSync(join(tmpdir(), 'fg-scale-open-'));
        try {
            fill(open, 'data', BIG);
            const t0 = Date.now();
            const r = await createNativeExec({ workspaceRoot: open })('bash', 'echo ok > mark.txt; echo done');
            expect(r.stdout.trim()).toBe('done');
            expect(r.files_written).toBeUndefined();            // unknown, not a late answer
            expect(Date.now() - t0).toBeLessThan(4_000);
        } finally { rmSync(open, { recursive: true, force: true }); }
    }, 90_000);
    it('a checkpoint of the repo copies its few files and does not walk the ignored folder', async () => {
        const store = mkdtempSync(join(tmpdir(), 'fg-scale-ck-'));
        try {
            const t0 = Date.now();
            const snap = await takeSnapshot(git, store, '1');
            expect(snap.tooBig).toBe(false);
            expect(snap.files.every(f => !f.startsWith('huge/'))).toBe(true);   // the ignored folder is not in it
            expect(snap.files).toContain('a.txt');
            expect(Date.now() - t0).toBeLessThan(2_000);
            await dropSnapshot(snap);
        } finally { rmSync(store, { recursive: true, force: true }); }
    }, 30_000);
    it('a checkpoint of a plain folder this big is refused (too large), quickly', async () => {
        const open = mkdtempSync(join(tmpdir(), 'fg-scale-open-')), store = mkdtempSync(join(tmpdir(), 'fg-scale-ck-'));
        try {
            fill(open, 'data', 10_000);
            const t0 = Date.now();
            const snap = await takeSnapshot(open, store, '1');
            expect(snap.tooBig).toBe(true);
            expect(Date.now() - t0).toBeLessThan(4_000);
        } finally { rmSync(open, { recursive: true, force: true }); rmSync(store, { recursive: true, force: true }); }
    }, 60_000);
});
