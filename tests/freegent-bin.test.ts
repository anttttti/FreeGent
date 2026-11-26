import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
// @ts-ignore — plain ESM launcher helper
import { route, HELP } from '../bin/route.mjs';

const tty = { stdinTTY: true, stdoutTTY: true };
describe('freegent command routing', () => {
    it('no arguments at a terminal opens the terminal UI, and its own options pass through', () => {
        expect(route([], tty)).toEqual({ program: 'tui', args: [] });
        expect(route(['--resume', '--model', 'm'], tty).program).toBe('tui');
        expect(route(['--prompt', 'hello'], tty).program).toBe('tui');          // the UI's "send this at start", not the plain model call
    });
    it('-p / --print selects the pipeline program, with or without text', () => {
        expect(route(['-p', 'do it'], tty)).toEqual({ program: 'cli', args: ['-p', 'do it'] });
        expect(route(['--print', '--no-tools'], tty).program).toBe('cli');
        expect(route(['-p'], { stdinTTY: false, stdoutTTY: true }).program).toBe('cli');
    });
    it('the older fg-run options still select the command-line program', () => {
        for (const f of ['--workflow', '--task', '--task-file', '--print-model']) expect(route([f, 'x'], tty).program).toBe('cli');
    });
    it('without a terminal on either side the UI cannot run: the piped form is used', () => {
        expect(route([], { stdinTTY: false, stdoutTTY: true })).toEqual({ program: 'cli', args: ['-p'] });
        expect(route(['--model', 'm'], { stdinTTY: true, stdoutTTY: false })).toEqual({ program: 'cli', args: ['-p', '--model', 'm'] });
        // The UI's message-at-start becomes the request (codex R312).
        expect(route(['--model', 'm', '--prompt', 'hi there'], { stdinTTY: false, stdoutTTY: true })).toEqual({ program: 'cli', args: ['-p', 'hi there', '--model', 'm'] });
    });
    it('--prompt with no message is an error, not a request made of the next option', () => {
        for (const a of [['--prompt', '--model', 'm'], ['--model', 'm', '--prompt']])
            expect(route(a, { stdinTTY: false, stdoutTTY: true })).toEqual({ program: 'error', message: 'freegent: --prompt needs a message' });
    });
    it('--help and --version are answered by the launcher', () => {
        expect(route(['--help'], tty).program).toBe('help');
        expect(route(['-v'], tty).program).toBe('version');
        expect(HELP).toContain('freegent -p');
    });
});

describe('fg-run -p', () => {
    it('the package exposes the command', () => {
        const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
        expect(pkg.bin.freegent).toBe('bin/freegent.mjs');
    });
});

describe('codex R8-001 and R9-001', () => {
    it('-p together with --task, --prompt or --task-file is refused before anything runs', async () => {
        const { spawnSync } = await import('node:child_process');
        const run = (...a: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'fg-run.ts', ...a], { cwd: process.cwd(), encoding: 'utf8', input: '', timeout: 60_000 });
        for (const extra of [['--task', 'OWN_TASK'], ['--prompt', 'OWN_PROMPT'], ['--task-file', 'own-task.txt']]) {
            const r = run('-p', 'OWN_PRINT', ...extra);
            expect(r.status, extra.join(' ')).not.toBe(0);
            expect(r.stderr).toMatch(/exactly one of/);
        }
    }, 120_000);
    it('tsx, which the command needs to start either program, is a runtime dependency', async () => {
        const pkg = JSON.parse((await import('node:fs')).readFileSync('package.json', 'utf8'));
        expect(pkg.dependencies.tsx).toBeTruthy();
        expect(pkg.devDependencies?.tsx).toBeUndefined();
    });
});

// 79c4173#2/#3: the version comes from this package's own repository, and only from deployment tags.
describe('fgVersion from git', () => {
    const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'ignore' });
    const load = async (root: string) => execFileSync('node', ['--input-type=module', '-e', `import('${pathToFileURL(join(root, 'bin', 'version.mjs')).href}').then(m => console.log(m.fgVersion({})))`], { encoding: 'utf8' }).trim();
    const setup = (root: string) => { mkdirSync(join(root, 'bin'), { recursive: true }); copyFileSync(join(__dirname, '..', 'bin', 'version.mjs'), join(root, 'bin', 'version.mjs')); };
    it('a copy inside another checkout is dev, and a pre-release tag is not a version', async () => {
        const outer = mkdtempSync(join(tmpdir(), 'fg-ver-'));
        try {
            git(outer, 'init', '-q'); writeFileSync(join(outer, 'a'), '1'); git(outer, 'add', '.'); git(outer, 'commit', '-q', '-m', 'x'); git(outer, 'tag', 'v1.0.1');
            const inner = join(outer, 'node_modules', 'freegent'); setup(inner);
            expect(await load(inner)).toBe('dev');
            setup(outer); writeFileSync(join(outer, 'b'), '2'); git(outer, 'add', '.'); git(outer, 'commit', '-q', '-m', 'y'); git(outer, 'tag', 'v1.0.2-rc.1');
            expect(await load(outer)).toMatch(/^v1\.0\.1-1-g[0-9a-f]+/);
        } finally { rmSync(outer, { recursive: true, force: true }); }
    });
});
