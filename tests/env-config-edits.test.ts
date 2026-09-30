// Test-environment workarounds in the change set (v0.58 fixes §5): v0.58 xarray-5131 shipped a
// root conftest.py that monkeypatched pandas so tests ran locally; the grader's collection then
// failed on all 34 graded tests. One bounce at COMPLETED, unless the task names the file.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { makeReplayFetch, FAKE_EP } from './replay-harness.ts';
import { NULL_RENDER_ADAPTER } from '../render-adapter.ts';
import { KEYS } from '../storage-keys.ts';

const W = window as any;
let origNative: any;
beforeAll(async () => {
    await import('../llm-loops.ts');
    await import('../step-validator.ts');
});
beforeEach(() => {
    localStorage.clear();
    W.mainAgentRole = null;
    localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify(['openrouter|qwen/qwen3-30b-a3b']));
    localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
    W._sessionToolFilter = new Set(['execute_code']);
    origNative = W.nativeExec;
    (globalThis as any).nativeExec = W.nativeExec = async () => ({ stdout: '', stderr: '', exit_code: 0, files_written: ['xarray/core/groupby.py', 'conftest.py'] });
});
afterEach(() => { (globalThis as any).nativeExec = W.nativeExec = origNative; });

async function run(task: string) {
    const s = W.createSession({ workflowMode: true });
    s.history.push({ role: 'user', content: task });
    const bodies: any[] = [];
    W.fetch = makeReplayFetch([
        { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'execute_code', arguments: JSON.stringify({ language: 'bash', code: 'cat > conftest.py <<EOF\nimport pandas\nEOF' }) } }] },
        { content: 'Fixed.\nCOMPLETED' },
        { content: 'Fixed.\nCOMPLETED' },
    ], { onRequest: b => bodies.push(b) });
    await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER, { session: s });
    return bodies.map(b => JSON.stringify(b.messages));
}

describe('env_config_edits', () => {
    it('bounces the first COMPLETED once, naming the file; the second is accepted', async () => {
        const reqs = await run('Fix the trailing whitespace in DatasetGroupBy repr.');
        expect(reqs).toHaveLength(3);
        expect(reqs[2]).toContain('You changed test or packaging configuration: conftest.py');
        expect(reqs[2]).not.toContain('xarray/core/groupby.py,');
    });
    it('does not fire when the task names the file', async () => {
        const reqs = await run('Update conftest.py so the doctest fixture is registered.');
        expect(reqs).toHaveLength(2);
        expect(reqs.join('')).not.toContain('You changed test or packaging configuration');
    });
});
