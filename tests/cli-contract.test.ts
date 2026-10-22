// fg-run.ts as a command: argument errors, mutually exclusive inputs, the temperature range, a pure stdout for --prompt, --no-log and
// --timeout for a direct prompt (TUI/CLI report cases 006, 014, 025, 027, 031, 086). Real subprocesses against a fake local endpoint.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '..');
const RUN = [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), join(ROOT, 'fg-run.ts')];
let server: http.Server, base = '', delayMs = 0;
const posts: any[] = [];

beforeAll(async () => {
    server = http.createServer((req, res) => {
        if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ object: 'list', data: [{ id: 'm', max_model_len: 131072 }] })); return; }
        let body = ''; req.on('data', c => body += c); req.on('end', () => setTimeout(() => {
            const j = JSON.parse(body || '{}'); posts.push(j);
            const msg = { role: 'assistant', content: '{"answer":42}' };
            if (j.stream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: msg, finish_reason: null }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
                res.end();
            } else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: 'm', choices: [{ index: 0, message: msg, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })); }
        }, delayMs));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as any).port}/v1`;
});
afterAll(() => server.close());

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
    const cwd = mkdtempSync(join(tmpdir(), 'fg-cli-'));
    return new Promise(resolve => {
        const p = spawn(process.execPath, [...RUN, ...args], { cwd, env: { PATH: process.env.PATH!, HOME: cwd, XDG_CONFIG_HOME: cwd, NODE_NO_WARNINGS: '1', ...env } });
        let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
        const t = setTimeout(() => p.kill('SIGKILL'), 40_000);
        p.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
    });
}
const std = () => ['--provider', 'custom', '--model', 'm', '--api-url', base, '--api-key', 'k'];

describe('fg-run argument contract', () => {
    it('a value-taking option followed by another option, or nothing, is an error before any request', async () => {
        const before = posts.length;
        for (const a of [['--prompt', '--temperature', '0.3'], ['--prompt', 'hi', '--temperature'], ['--prompt', 'hi', '--context-window']]) {
            const r = await run([...std(), ...a]);
            expect(r.code, a.join(' ')).toBe(2);
            expect(r.err).toMatch(/needs a value/);
        }
        expect(posts.length).toBe(before);
    }, 60_000);
    it('--task with --prompt (or --task-file) is refused, not silently reduced to one', async () => {
        for (const a of [['--task', 't', '--prompt', 'p'], ['--prompt', 'p', '--task-file', 'x.txt']]) {
            const r = await run([...std(), ...a]);
            expect(r.code).toBe(2);
            expect(r.err).toMatch(/exactly one of .*--prompt/);
        }
    }, 60_000);
    it('--temperature outside 0–2, or not a number, is refused with the range', async () => {
        for (const t of ['3.5', '-0.1', 'abc']) {
            const r = await run([...std(), '--prompt', 'hi', '--temperature', t]);
            expect(r.code).toBe(2);
            expect(r.err).toMatch(/range 0–2/);
        }
        const ok = await run([...std(), '--prompt', 'hi', '--temperature', '0.4']);
        expect(ok.code).toBe(0);
    }, 90_000);
    it('--prompt writes only the answer to stdout, even when the endpoint probe reports a window', async () => {
        delayMs = 500;   // the probe prints a moment after the request; a fast reply used to exit first and hide it
        try {
            const r = await run([...std(), '--prompt', 'Return JSON.', '--no-log']);
            expect(r.code).toBe(0);
            expect(JSON.parse(r.out.trim())).toEqual({ answer: 42 });
        } finally { delayMs = 0; }
    }, 40_000);
    it('--no-log creates no log file even when FREEGENT_LOG_FILE is set', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'fg-nolog-')); const log = join(dir, 'turns.jsonl');
        const r = await run([...std(), '--prompt', 'hi', '--no-log'], { FREEGENT_LOG_FILE: log });
        expect(r.code).toBe(0);
        expect(existsSync(log)).toBe(false);
        const withLog = await run([...std(), '--prompt', 'hi', '--log', log]);
        expect(withLog.code).toBe(0);
        expect(existsSync(log)).toBe(true);
        rmSync(dir, { recursive: true, force: true });
    }, 60_000);
    it('--timeout applies to a direct prompt: a reply held longer fails with a nonzero exit', async () => {
        delayMs = 4000;
        try {
            const r = await run([...std(), '--prompt', 'hi', '--timeout', '800', '--no-log']);
            expect(r.code).toBe(1);
            expect(r.err).toMatch(/timed out/);
            expect(r.out.trim()).not.toContain('answer');
        } finally { delayMs = 0; }
    }, 40_000);
});
