import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Boot the actual Node/JSDOM chain in its own realm. All fetches are intercepted;
// neither provider credentials nor a live LLM are needed for these checks.
function runFixture(mode: 'tools' | 'timeout' | 'json') {
    const root = mkdtempSync(join(tmpdir(), 'fg-headless-smoke-'));
    try {
        const fixture = join(root, 'fixture.mjs');
        const resultPath = join(root, 'result.json');
        const workspace = join(root, 'workspace');
        mkdirSync(workspace);
        for (const name of ['alpha.txt', 'beta.txt', 'gamma.txt']) writeFileSync(join(workspace, name), name);
        writeFileSync(fixture, `
            import { writeFileSync } from 'node:fs';
            let requests = 0;
            let streamRequests = 0;
            const requestStats = [];
            globalThis.fetch = async (_url, opts = {}) => {
                requests++;
                const body = JSON.parse(opts.body || '{}');
                requestStats.push({ url: String(_url), stream: body.stream, toolChoice: body.tool_choice, tools: body.tools?.map(t => t.function?.name) });
                writeFileSync(${JSON.stringify(join(root, 'requests.json'))}, JSON.stringify(requestStats));
                if (!body.stream) return new Response('{"data":[]}', { headers: { 'Content-Type': 'application/json' } });
                streamRequests++;
                if (${JSON.stringify(mode)} === 'json') {
                    const delta = streamRequests === 1
                        ? { tool_calls: [{ index: 0, id: 'call-list', type: 'function', function: { name: 'list_files', arguments: '{}' } }] }
                        : { content: '{"count":3,"files":["alpha.txt","beta.txt","gamma.txt"]}\\nCOMPLETED' };
                    return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta }] })
                        + '\\n\\ndata: [DONE]\\n\\n', { headers: { 'Content-Type': 'text/event-stream' } });
                }
                return new Promise((_resolve, reject) => {
                    const abort = () => reject(new DOMException('aborted', 'AbortError'));
                    if (opts.signal?.aborted) abort();
                    else opts.signal?.addEventListener('abort', abort, { once: true });
                });
            };
            const { setup, run } = await import(${JSON.stringify(pathToFileURL(resolve('headless-runner.ts')).href)});
            const opts = {
                workspaceRoot: ${JSON.stringify(workspace)}, sessionDbPath: ${JSON.stringify(join(root, 'session.db'))},
                provider: 'openai', model: 'smoke-test', apiUrl: 'http://offline.invalid/v1', apiKey: 'fixture',
                contextWindow: 16000, logFile: ${JSON.stringify(join(root, 'turns.jsonl'))},
                enableTools: 'replace_in_file,append_file', timeoutMs: 100, workflowMode: true,
            };
            let result;
            if (${JSON.stringify(mode)} === 'json') {
                process.env.FREEGENT_SESSION_DB = ${JSON.stringify(join(root, 'session.db'))};
                process.argv = [process.execPath, 'fg-run.ts', '--task', 'List files using list_files and return only JSON.',
                    '--llm', 'openai|smoke-test', '--api-url', opts.apiUrl, '--api-key', 'fixture',
                    '--workspace', opts.workspaceRoot, '--context-window', '16000', '--timeout', '5000', '--log', opts.logFile];
                await import(${JSON.stringify(pathToFileURL(resolve('fg-run.ts')).href)});
            } else if (${JSON.stringify(mode)} === 'tools') {
                await setup(opts);
                const ceiling = globalThis.rolesRegistry.get('director').tools;
                const tools = globalThis.activeTools().map(t => t.name);
                result = { tools, ceiling: [...ceiling] };
            } else {
                const r = await run('List workspace files using list_files.', opts);
                result = { error: String(r.error || ''), requests, requestStats, elapsed: r.metrics.elapsed_s };
            }
            writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
            process.exit(0);
        `);
        const stdoutPath = join(root, 'stdout.txt'), stderrPath = join(root, 'stderr.txt');
        const stdoutFd = openSync(stdoutPath, 'w'), stderrFd = openSync(stderrPath, 'w');
        let child;
        try {
            // File descriptors avoid restricted subprocess-pipe capture in some CI sandboxes.
            child = spawnSync(process.execPath, [
                '--experimental-strip-types', '--loader', resolve('js-to-ts-loader.mjs'), fixture,
            ], { cwd: resolve('.'), timeout: 15_000, stdio: ['ignore', stdoutFd, stderrFd], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
        } finally {
            closeSync(stdoutFd); closeSync(stderrFd);
        }
        if (child.error || child.status !== 0) throw new Error(child.error?.message || readFileSync(stderrPath, 'utf8') || `exit ${child.status}`);
        if (mode === 'json') return { stdout: readFileSync(stdoutPath, 'utf8'), requestStats: JSON.parse(readFileSync(join(root, 'requests.json'), 'utf8')), turns: readFileSync(join(root, 'turns.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) };
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
        expect(result.requestStats.filter((r: any) => r.stream).length).toBe(1);
        expect(result.error).toContain('Task timed out after 100 ms');
        expect(result.elapsed).toBeLessThan(5);
    });

    it('executes a real list tool and returns flushed JSON-only CLI output with the marker removed', () => {
        const result = runFixture('json');
        const output = result.stdout.split('\n').filter((line: string) => !line.startsWith('__FG_METRICS__:')).join('\n').trim();
        expect(JSON.parse(output)).toEqual({ count: 3, files: ['alpha.txt', 'beta.txt', 'gamma.txt'] });
        expect(result.turns.some((r: any) => r.toolCalls?.some((t: any) => (t.name || t.function?.name) === 'list_files')),
            JSON.stringify({ requests: result.requestStats, turns: result.turns.map((r: any) => ({ type: r.type, step: r.step, tools: r.toolCalls })) })).toBe(true);
    });
});
