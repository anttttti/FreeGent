import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Run the real smoke CLI with a recorded fg-run response. No LLM/network calls.
function runFixture(checks: object, entries: object[], stdout: string, llm?: string, files: Record<string, string> = {}, caseOverrides: object = {}, extraArgs: string[] = [], childResult: object = {}) {
    const root = mkdtempSync(join(tmpdir(), 'fg-smoke-test-'));
    try {
        const smoke = join(root, 'smoke');
        mkdirSync(smoke);
        copyFileSync(resolve('smoke/run.js'), join(smoke, 'run.mjs'));
        writeFileSync(join(smoke, 'cases.jsonl'), JSON.stringify({
            id: 'fixture', group: 'basic', desc: 'Recorded response', task: 'Answer the question.', checks, ...caseOverrides,
        }) + '\n');
        writeFileSync(join(root, 'fixture.json'), JSON.stringify({ entries, stdout, files, childResult }));
        writeFileSync(join(root, 'preload.cjs'), `
            const fs = require('node:fs');
            const path = require('node:path');
            const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'));
            // Record console output independently of platform pipe flushing at process.exit().
            process.stdout.write = chunk => {
                fs.appendFileSync(path.join(__dirname, 'stdout.txt'), chunk);
                return true;
            };
            require('node:child_process').spawnSync = (_command, args) => {
                if (args.includes('--print-model')) {
                    const model = args.includes('--llm') ? args[args.indexOf('--llm') + 1] : 'test|primary-model';
                    return { status: 0, stdout: model + '\\n', stderr: '' };
                }
                fs.writeFileSync(path.join(__dirname, 'args.json'), JSON.stringify(args));
                fs.writeFileSync(args[args.indexOf('--log') + 1], fixture.entries.map(e => JSON.stringify(e)).join('\\n'));
                for (const [name, content] of Object.entries(fixture.files))
                    fs.writeFileSync(path.join(args[args.indexOf('--workspace') + 1], name), content);
                return { status: 0, stdout: fixture.stdout, stderr: '', ...fixture.childResult };
            };
            require('node:module').syncBuiltinESMExports();
        `);
        const result = spawnSync(process.execPath, [
            '--require', join(root, 'preload.cjs'), join(smoke, 'run.mjs'),
            ...(llm ? ['--llm', llm] : []),
            ...extraArgs,
        ], { encoding: 'utf8', env: { ...process.env, FREEGENT_LLM: '', NODE_OPTIONS: '' } });
        const logDir = join(smoke, 'logs');
        const logName = readdirSync(logDir).find(name => name.startsWith('smoke-'))!;
        return {
            exit: result.status,
            stdout: readFileSync(join(root, 'stdout.txt'), 'utf8'),
            row: JSON.parse(readFileSync(join(logDir, logName), 'utf8')),
            args: JSON.parse(readFileSync(join(root, 'args.json'), 'utf8')) as string[],
        };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

describe('smoke runner', () => {
    it('counts LLM responses without startup records, nudges or history snapshots', () => {
        const result = runFixture({ contains: ['Helsinki'], max_steps: 1 }, [
            { timing: { step: 'setup:start', ms: 0 } },
            { step: 0, model: 'test', response: 'Helsinki.', toolCalls: [] },
            { type: 'nudge', role: 'user', text: 'Check your work.' },
            { type: 'history_snapshot', history: [] },
            { type: 'history_final', history: [] },
        ], '__FG_METRICS__:{"steps":1}\nHelsinki.\n');
        expect(result.exit).toBe(0);
        expect(result.row.status).toBe('pass');
        expect(result.row.info).toContain('steps: 1');
        expect(result.row.output).toBe('Helsinki.');
        expect(result.args).not.toContain('--llm');
        expect(result.stdout).toContain('Primary model: test|primary-model');
        expect(result.stdout.indexOf('Primary model:')).toBeLessThan(result.stdout.indexOf('Recorded response'));
    });

    it('still fails when actual LLM responses exceed the step budget', () => {
        const result = runFixture({ max_steps: 1 }, [
            { step: 0, response: 'Working.' }, { step: 1, response: 'Done.' },
        ], 'Done.');
        expect(result.exit).toBe(1);
        expect(result.row.failures).toContain('used 2 steps, limit is 1');
    });

    it('does not treat metrics-only stdout as a nonempty answer', () => {
        const result = runFixture({ output_nonempty: true }, [], '__FG_METRICS__:{"steps":0}\n');
        expect(result.exit).toBe(1);
        expect(result.row.failures).toContain('output is empty');
    });

    it('preserves required tool checks and explicit model overrides', () => {
        const result = runFixture({ tool_called: ['write_file'] }, [
            { step: 0, response: '', toolCalls: [{ name: 'execute_code', args: {} }] },
        ], 'Done.', 'google|test-model');
        expect(result.exit).toBe(1);
        expect(result.row.failures).toContain('tool "write_file" was not called');
        expect(result.args[result.args.indexOf('--llm') + 1]).toBe('google|test-model');
        expect(result.stdout).toContain('Primary model: google|test-model');
    });

    it('accepts the basic file-write case through bash and rejects a missing or incorrect file', () => {
        const cases = readFileSync(resolve('smoke/cases.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const checks = cases.find(c => c.id === 's03-write').checks;
        const entries = [{ step: 0, response: '', toolCalls: [{ name: 'execute_code', args: {} }] }];
        const good = runFixture(checks, entries, 'Created smoke-out.txt.', undefined, { 'smoke-out.txt': 'smoke test ok' });
        expect(good.exit).toBe(0);
        expect(good.row.status).toBe('pass');
        expect(good.args).not.toContain('--enable-tools');
        const missing = runFixture(checks, entries, 'Created smoke-out.txt.');
        expect(missing.exit).toBe(1);
        expect(missing.row.failures).toContain('file "smoke-out.txt" not found');
        const wrong = runFixture(checks, entries, 'Created smoke-out.txt.', undefined, { 'smoke-out.txt': 'wrong content' });
        expect(wrong.exit).toBe(1);
        expect(wrong.row.failures).toContain('file "smoke-out.txt" does not contain "smoke test ok"');
    });

    it('opts the replace tool-coverage case into its required tool without overriding the model', () => {
        const cases = readFileSync(resolve('smoke/cases.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const replaceCase = cases.find(c => c.id === 's17-replace-file');
        const content = 'name=app\nversion=2\nenv=prod';
        const entries = [{ step: 0, response: '', toolCalls: [{ name: 'replace_in_file', args: {} }] }];
        const good = runFixture(replaceCase.checks, entries, 'Updated config.txt.', undefined, { 'config.txt': content }, replaceCase);
        expect(good.exit).toBe(0);
        expect(good.args[good.args.indexOf('--enable-tools') + 1]).toBe('replace_in_file');
        expect(good.args[good.args.indexOf('--task') + 1]).toContain('Use replace_in_file');
        expect(good.args).not.toContain('--llm');
        const alternative = runFixture(replaceCase.checks, [
            { step: 0, response: '', toolCalls: [{ name: 'write_file', args: {} }] },
        ], 'Updated config.txt.', undefined, { 'config.txt': content }, replaceCase);
        expect(alternative.exit).toBe(1);
        expect(alternative.row.failures).toContain('tool "replace_in_file" was not called');
        const damaged = runFixture(replaceCase.checks, entries, 'Updated config.txt.', undefined, { 'config.txt': 'version=2' }, replaceCase);
        expect(damaged.exit).toBe(1);
        expect(damaged.row.failures).toContain('file "config.txt" does not contain "name=app"');
    });

    it('forwards a CLI tool override when the case has no override', () => {
        const result = runFixture({}, [], 'Done.', undefined, {}, {}, ['--enable-tools', 'replace_in_file,append_file']);
        expect(result.args[result.args.indexOf('--enable-tools') + 1]).toBe('replace_in_file,append_file');
    });

    it('enables every checked tool while retaining explicit additions and disable flags', () => {
        const result = runFixture({ tool_called: ['replace_in_file', 'read_file'] }, [
            { step: 0, toolCalls: [{ name: 'replace_in_file' }, { name: 'read_file' }] },
        ], 'Done.', undefined, {}, { enable_tools: 'append_file,replace_in_file' }, ['--disable-tools', 'web_search']);
        expect(result.exit).toBe(0);
        expect(result.args[result.args.indexOf('--enable-tools') + 1]).toBe('append_file,replace_in_file,read_file');
        expect(result.args[result.args.indexOf('--disable-tools') + 1]).toBe('web_search');
        expect(result.args).toContain('--experimental-strip-types');
        expect(result.args).not.toContain('--env-file-if-exists=.env');
    });

    it('accepts an empty-input bug explanation through either prose or the exact reproducer', () => {
        const cases = readFileSync(resolve('smoke/cases.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const bugCase = cases.find(c => c.id === 's41-proactive-bugfind');
        const entries = [{ step: 0, toolCalls: [{ name: 'read_file' }] }];
        for (const answer of ['Empty input causes division by zero.', 'average([]) raises ZeroDivisionError.']) {
            expect(runFixture(bugCase.checks, entries, answer).row.status).toBe('pass');
        }
        expect(runFixture(bugCase.checks, entries, 'No bugs found.').row.status).toBe('fail');
        expect(runFixture(bugCase.checks, entries, 'average(5) raises TypeError.').row.status).toBe('fail');
    });

    it('validates JSON syntax, exact keys, count and filenames rather than key substrings', () => {
        const caseOverrides = { workspace_files: { 'alpha.txt': 'a', 'beta.txt': 'b', 'gamma.txt': 'c' } };
        const checks = { json_workspace_listing: true };
        const valid = '{"count":3,"files":["gamma.txt","alpha.txt","beta.txt"]}';
        expect(runFixture(checks, [], valid, undefined, {}, caseOverrides).row.status).toBe('pass');
        for (const answer of [
            'Here is the result: ' + valid, valid + '\nCOMPLETED',
            '{"count":"3","files":["alpha.txt","beta.txt","gamma.txt"]}',
            '{"count":3,"files":["alpha.txt","beta.txt","wrong.txt"]}',
            '{"count":3,"files":["alpha.txt","alpha.txt","gamma.txt"]}',
            '{"count":2,"files":["alpha.txt","beta.txt","gamma.txt"]}',
            '{"count":3,"files":["alpha.txt","beta.txt","gamma.txt"],"extra":true}',
        ]) expect(runFixture(checks, [], answer, undefined, {}, caseOverrides).row.status).toBe('fail');
    });

    it('reports failed processes even when their partial output satisfies the checks', () => {
        const stderr = '.env not found. Continuing without it.\nsource.ts:1\nReferenceError: esc is not defined\n    at source.ts:1\n';
        const result = runFixture({ contains: ['Helsinki'] }, [], 'Helsinki.', undefined, {}, {}, [], { status: 1, stderr });
        expect(result.exit).toBe(1);
        expect(result.row.status).toBe('error');
        expect(result.row.error).toBe('ReferenceError: esc is not defined');
        expect(result.row.stderr).toBe(stderr);
        expect(result.row.output).toBe('Helsinki.');
        expect(result.row.exitCode).toBe(1);
    });

    it('reports subprocess deadlines and signals as errors with partial output retained', () => {
        const timeout = runFixture({}, [], 'Reasoning...', undefined, {}, {}, [],
            { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT', message: 'spawn ETIMEDOUT' } });
        expect(timeout.row.status).toBe('error');
        expect(timeout.row.error).toContain('timed out');
        expect(timeout.row.output).toBe('Reasoning...');
        const killed = runFixture({}, [], 'Done.', undefined, {}, {}, [], { status: null, signal: 'SIGKILL' });
        expect(killed.row.status).toBe('error');
        expect(killed.row.error).toContain('SIGKILL');
    });

    it('summarises actual primary and fallback steps while excluding non-step records', () => {
        const result = runFixture({ max_steps: 3 }, [
            { timing: { step: 'setup:start', ms: 0 } },
            { step: 0, provider: 'nous', model: 'primary', response: 'Working.' },
            { type: 'nudge', provider: 'nous', model: 'primary', step: 0 },
            { step: 1, provider: 'google', model: 'fallback', response: 'Working.' },
            { type: 'history_snapshot', provider: 'google', model: 'fallback', step: 1 },
            { step: 2, provider: 'google', model: 'fallback', response: 'Done.' },
            { type: 'history_final', history: [] },
        ], 'Done.');
        expect(result.exit).toBe(0);
        expect(result.stdout).toContain('Models used (LLM steps):');
        expect(result.stdout).toMatch(/google\|fallback\s+2/);
        expect(result.stdout).toMatch(/nous\|primary\s+1/);
    });
});
