import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Boot the actual Node/JSDOM chain in its own realm. All fetches are intercepted;
// neither provider credentials nor a live LLM are needed for these checks.
function runFixture(mode: 'tools' | 'timeout') {
    const root = mkdtempSync(join(tmpdir(), 'fg-headless-smoke-'));
    try {
        const fixture = join(root, 'fixture.mjs');
        const resultPath = join(root, 'result.json');
        writeFileSync(fixture, `
            import { writeFileSync } from 'node:fs';
            let requests = 0;
            globalThis.fetch = async (_url, opts = {}) => {
                requests++;
                return new Promise((_resolve, reject) => {
                    const abort = () => reject(new DOMException('aborted', 'AbortError'));
                    if (opts.signal?.aborted) abort();
                    else opts.signal?.addEventListener('abort', abort, { once: true });
                });
            };
            const { setup, run } = await import(${JSON.stringify(pathToFileURL(resolve('headless-runner.ts')).href)});
            const opts = {
                workspaceRoot: ${JSON.stringify(root)}, sessionDbPath: ${JSON.stringify(join(root, 'session.db'))},
                provider: 'openai', model: 'smoke-test', apiUrl: 'http://offline.invalid/v1', apiKey: 'fixture',
                contextWindow: 16000, logFile: ${JSON.stringify(join(root, 'turns.jsonl'))},
                enableTools: 'replace_in_file,append_file', timeoutMs: 100,
            };
            let result;
            if (${JSON.stringify(mode)} === 'tools') {
                await setup(opts);
                const ceiling = globalThis.rolesRegistry.get('director').tools;
                const tools = globalThis.activeTools().map(t => t.name);
                result = { tools, ceiling: [...ceiling] };
            } else {
                const r = await run('List workspace files using list_files.', opts);
                result = { error: String(r.error || ''), requests, elapsed: r.metrics.elapsed_s };
            }
            writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
            process.exit(0);
        `);
        const child = spawnSync(process.execPath, [
            '--experimental-strip-types', '--loader', resolve('js-to-ts-loader.mjs'), fixture,
        ], { cwd: resolve('.'), timeout: 15_000, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
        if (child.error || child.status !== 0) throw new Error(child.error?.message || child.stderr || `exit ${child.status}`);
        return JSON.parse(readFileSync(resultPath, 'utf8'));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

describe('headless smoke execution', () => {
    it('advertises explicitly enabled edit tools in both the real schema and Director ceiling', () => {
        const result = runFixture('tools');
        expect(result.ceiling).toContain('replace_in_file');
        expect(result.ceiling).toContain('append_file');
        expect(result.tools).toContain('replace_in_file');
        expect(result.tools).toContain('append_file');
    });

    it('aborts a pending provider request and returns a timeout error instead of success', () => {
        const result = runFixture('timeout');
        expect(result.requests).toBeGreaterThan(0);
        expect(result.error).toContain('Task timed out after 100 ms');
        expect(result.elapsed).toBeLessThan(5);
    });
});
