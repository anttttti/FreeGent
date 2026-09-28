// worker-step-cap.test.ts — a worker that reaches its step limit reports what it found instead of
// returning the bare "*(max steps reached)*" sentinel (v0.56: 134 of 362 workers, whose findings
// the director never saw). The report ends with a "STATUS: partial" footer. Also: quoted role
// names in run_workers resolve to the registered role.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { makeReplayFetch } from './replay-harness.ts';
import { NULL_TASK_HANDLE } from '../render-adapter.ts';
import { KEYS } from '../storage-keys.ts';

const W = window as any;

beforeAll(async () => {
    await import('../llm-loops.ts');
    await import('../workers.ts');
    await import('../step-validator.ts');
});

beforeEach(() => {
    localStorage.clear();
    W.mainAgentRole = null;
    localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify(['openrouter|test-model']));
    localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
    let n = 0;
    W.nativeExec = vi.fn(async () => ({ stdout: `match ${n++}\n`, stderr: '', exit_code: 0 }));
});

const grep = (i: number) => ({ tool_calls: [{ id: `g${i}`, type: 'function', function: { name: 'execute_code', arguments: JSON.stringify({ language: 'bash', code: `grep -n pattern${i} src/*.py` }) } }] });

async function runCapped(finalStep: any): Promise<string> {
    const bodies: any[] = [];
    W.fetch = makeReplayFetch([...Array.from({ length: 30 }, (_, i) => grep(i)), finalStep], { onRequest: b => bodies.push(b) });
    const ctx = { snapshot: new Map(), staging: new Map(), depth: 0 };
    const { output } = await W.runWorkerTurn('Find where pattern is parsed.', ctx, NULL_TASK_HANDLE, 'openrouter|test-model', W.rolesRegistry.get('researcher'), null);
    expect(bodies.length).toBe(31);
    expect(JSON.stringify(bodies[30].messages.at(-1))).toContain('step limit');
    return output;
}

describe('worker step limit', () => {
    it('returns the worker\'s own report with a partial-status footer', async () => {
        const out = await runCapped({ content: 'pattern is parsed in src/parse.py:42 (parse_pattern). Not fixed yet.' });
        expect(out).toContain('src/parse.py:42');
        expect(out).toMatch(/STATUS: partial — stopped at the 30-step worker limit/);
        expect(out).not.toContain('max steps reached');
    });

    it('falls back to the recent tool calls when the report is empty', async () => {
        const out = await runCapped({ content: '' });
        expect(out).toContain('Last tool calls:');
        expect(out).toContain('pattern29');
        expect(out).toMatch(/STATUS: partial/);
    });
});

describe('worker role names', () => {
    it('strips quotes and fixes case for registered roles, keeps custom names', async () => {
        const { _normWorkerRole } = await import('../workers.ts');
        const reg = new Map([['researcher', {}], ['coder', {}], ['MyRole', {}]]);
        expect(_normWorkerRole('"researcher"', reg)).toBe('researcher');
        expect(_normWorkerRole("'Coder'", reg)).toBe('coder');
        expect(_normWorkerRole('`MyRole`', reg)).toBe('MyRole');
        expect(_normWorkerRole('Unknown', reg)).toBe('Unknown');
        expect(_normWorkerRole('  ""  ', reg)).toBeUndefined();
    });
});
