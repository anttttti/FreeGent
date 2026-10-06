import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Run the real smoke CLI with a recorded fg-run response. No LLM/network calls.
function runFixture(checks: object, entries: object[], stdout: string, llm?: string, files: Record<string, string> = {}, caseOverrides: object = {}, extraArgs: string[] = []) {
    const root = mkdtempSync(join(tmpdir(), 'fg-smoke-test-'));
    try {
        const smoke = join(root, 'smoke');
        mkdirSync(smoke);
        copyFileSync(resolve('smoke/run.js'), join(smoke, 'run.mjs'));
        writeFileSync(join(smoke, 'cases.jsonl'), JSON.stringify({
            id: 'fixture', group: 'basic', desc: 'Recorded response', task: 'Answer the question.', checks, ...caseOverrides,
        }) + '\n');
        writeFileSync(join(root, 'fixture.json'), JSON.stringify({ entries, stdout, files }));
        writeFileSync(join(root, 'preload.cjs'), `
            const fs = require('node:fs');
            const path = require('node:path');
            const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'));
            require('node:child_process').spawnSync = (_command, args) => {
                fs.writeFileSync(path.join(__dirname, 'args.json'), JSON.stringify(args));
                fs.writeFileSync(args[args.indexOf('--log') + 1], fixture.entries.map(e => JSON.stringify(e)).join('\\n'));
                for (const [name, content] of Object.entries(fixture.files))
                    fs.writeFileSync(path.join(args[args.indexOf('--workspace') + 1], name), content);
                return { status: 0, stdout: fixture.stdout, stderr: '' };
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
});
