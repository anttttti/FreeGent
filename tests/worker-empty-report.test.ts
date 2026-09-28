// worker-empty-report.test.ts — a worker that finishes its tool calls with an empty message is
// asked once for a plain-text report, then falls back to its reasoning / recent tool calls
// instead of returning an empty output (which the director saw as a "stall").
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
    W.nativeExec = vi.fn(async () => ({ stdout: 'match\n', stderr: '', exit_code: 0 }));
});

const grep = { tool_calls: [{ id: 'g1', type: 'function', function: { name: 'execute_code', arguments: JSON.stringify({ language: 'bash', code: 'grep -n needle src/*.py' }) } }] };

async function run(steps: any[]) {
    const bodies: any[] = [];
    W.fetch = makeReplayFetch(steps, { onRequest: b => bodies.push(b) });
    const ctx = { snapshot: new Map(), staging: new Map(), depth: 0 };
    const { output } = await W.runWorkerTurn('Find needle.', ctx, NULL_TASK_HANDLE, 'openrouter|test-model', W.rolesRegistry.get('researcher'), null);
    return { output: output as string, bodies };
}

describe('worker empty final message', () => {
    it('asks once for a report and returns it', async () => {
        const { output, bodies } = await run([grep, { content: '' }, { content: 'needle is in src/a.py:7' }]);
        expect(output).toContain('src/a.py:7');
        expect(JSON.stringify(bodies[2].messages.at(-1))).toContain('Your last message was empty');
    });

    it('falls back to the recent tool calls when the report stays empty', async () => {
        const { output } = await run([grep, { content: '' }, { content: '' }]);
        expect(output).toContain('Last tool calls:');
        expect(output).toContain('needle');
        expect(output).toMatch(/STATUS: partial/);
    });
});
