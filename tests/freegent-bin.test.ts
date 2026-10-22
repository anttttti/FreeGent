import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
    });
    it('--help and --version are answered by the launcher', () => {
        expect(route(['--help'], tty).program).toBe('help');
        expect(route(['-v'], tty).program).toBe('version');
        expect(HELP).toContain('freegent -p');
    });
});

describe('fg-run -p', () => {
    const src = readFileSync('fg-run.ts', 'utf8');
    it('takes an optional text, adds piped input, and prints only the answer', () => {
        expect(src).toContain("args[i] !== '-p' && args[i] !== '--print'");
        expect(src).toContain('const printRequest = [printText, stdinText]');
        expect(src).toContain('if (!printMode) process.stdout.write(`__FG_METRICS__');
        expect(src).toContain('process.stdout.isTTY || printMode ? undefined');
        expect(src).toContain('const _note = (m: string) => { if (!printMode) console.error(m); };');
    });
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
            expect(r.stderr).toMatch(/exactly one input/);
        }
    }, 120_000);
    it('tsx, which the command needs to start either program, is a runtime dependency', async () => {
        const pkg = JSON.parse((await import('node:fs')).readFileSync('package.json', 'utf8'));
        expect(pkg.dependencies.tsx).toBeTruthy();
        expect(pkg.devDependencies?.tsx).toBeUndefined();
    });
});
