// worker-fork.test.ts — run_workers context: a "director" worker forks the main agent's last
// request verbatim (system prompt, tools, messages) plus its subtask, so the request shares the
// main agent's prefix; coder/researcher specialists get their own prompt and only the task.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeReplayFetch, FAKE_EP } from './replay-harness.ts';
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
});

// Make one main-agent request so getLastMainRequest() holds a fork base.
async function mainRequest(history: any[]): Promise<any> {
    let body: any = null;
    W.fetch = makeReplayFetch([{ content: 'ok' }], { onRequest: b => { body = b; } });
    await W.callOAI(() => {}, null, { localHistory: history, endpointOverride: FAKE_EP });
    return body;
}

async function workerRequests(task: string, roleName: string, forkBase: any): Promise<any[]> {
    const bodies: any[] = [];
    W.fetch = makeReplayFetch([{ content: 'PELICAN-7731\nSTATUS: complete' }], { onRequest: b => bodies.push(b) });
    const ctx = { snapshot: new Map(), staging: new Map(), depth: 0 };
    await W.runWorkerTurn(task, ctx, NULL_TASK_HANDLE, 'openrouter|test-model', W.rolesRegistry.get(roleName), forkBase);
    return bodies;
}

const HISTORY = [
    { role: 'user', content: 'The secret word is PELICAN-7731.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'list_files', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', name: 'list_files', content: '{"files":[]}' },
];

describe('run_workers fork (role "director")', () => {
    it('resends the main request verbatim, then the subtask', async () => {
        const main = await mainRequest(HISTORY);
        const base = W.getLastMainRequest();
        expect(base.messages).toEqual(main.messages.slice(1));

        const [fork] = await workerRequests('Report the secret word.', 'director', base);
        // Identical prefix: system prompt, tools, and every inherited message.
        expect(fork.messages[0]).toEqual(main.messages[0]);
        expect(fork.tools).toEqual(main.tools);
        expect(fork.messages.slice(0, main.messages.length)).toEqual(main.messages);
        // Then exactly one new message: the fork instructions + subtask.
        expect(fork.messages).toHaveLength(main.messages.length + 1);
        const last = fork.messages.at(-1);
        expect(last.role).toBe('user');
        expect(last.content).toContain('<fork>');
        expect(last.content).toContain('Subtask: Report the secret word.');
    });

    it('falls back to task-only when the worker-history setting is off', async () => {
        await mainRequest(HISTORY);
        localStorage.setItem('fg_agent_worker_history', 'false');
        const [req] = await workerRequests('Report the secret word.', 'director', W.getLastMainRequest());
        expect(req.messages.slice(1)).toEqual([{ role: 'user', content: 'Report the secret word.' }]);
    });
});

describe('run_workers specialists', () => {
    it.each(['coder', 'researcher'])('%s sees only the task, under its own prompt', async (role) => {
        const main = await mainRequest(HISTORY);
        const [req] = await workerRequests('Report the secret word.', role, W.getLastMainRequest());
        expect(req.messages.slice(1)).toEqual([{ role: 'user', content: 'Report the secret word.' }]);
        expect(req.messages[0].content).not.toEqual(main.messages[0].content);
        expect(JSON.stringify(req)).not.toContain('PELICAN');
    });
});
