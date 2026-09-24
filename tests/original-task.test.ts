// original-task.test.ts — the task text used for the validator goal, garbled-output recovery and
// graded-test detection excludes the injected guidance prelude (whose pytest examples were read
// as graded tests in v0.54) and the post-compaction [TASK …] pin.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeReplayFetch, FAKE_EP } from './replay-harness.ts';
import { NULL_RENDER_ADAPTER } from '../render-adapter.ts';
import { KEYS } from '../storage-keys.ts';

const W = window as any;
const GUIDANCE = '~~~guidance\nThe following capabilities and rules apply to the request below.\n\n### verify-with-tests\nRun the full test file, e.g. `python -m pytest tests/test_foo.py`.\n~~~\n\n';
const TASK = 'Fix the empty-array bug in wcs.py.\n\nGraded tests:\nastropy/wcs/tests/test_wcs.py::test_zero_size_input\n\nDone.';

beforeAll(async () => {
    await import('../llm-loops.ts');
    await import('../chat-state.ts');
    await import('../step-validator.ts');
});

describe('_originalTask', () => {
    it('drops the guidance prelude, project instructions and the [TASK] pin', async () => {
        const { _originalTask } = await import('../llm-loops.ts');
        expect(_originalTask([{ role: 'user', content: GUIDANCE + TASK }])).toBe(TASK);
        expect(_originalTask([{ role: 'user', content: '<project_instructions>\nUse tabs.\n</project_instructions>\n\n' + TASK }])).toBe(TASK);
        expect(_originalTask([{ role: 'user', content: '[TASK — do not lose track of this]\n' + GUIDANCE + TASK }])).toBe(TASK);
        expect(_originalTask([])).toBe('');
    });
});

describe('graded-test gate', () => {
    beforeEach(() => {
        localStorage.clear();
        W.mainAgentRole = null;
        localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify(['openrouter|qwen/qwen3-30b-a3b']));
        localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
        W._sessionToolFilter = new Set(['execute_code']);
        // An edit happened: execute_code reports a written file.
        W.nativeExec = async () => ({ stdout: 'ok', stderr: '', exit_code: 0, files_written: ['astropy/wcs/wcs.py'] });
    });

    it('asks for the task\'s graded test, not the guidance example', async () => {
        W.setOpenaiHistory([{ role: 'user', content: GUIDANCE + TASK }]);
        W.fetch = makeReplayFetch([
            { tool_calls: [{ id: 'e1', type: 'function', function: { name: 'execute_code', arguments: '{"language":"bash","code":"patch"}' } }] },
            { content: 'Fixed.\nCOMPLETED' },
        ]);
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        const gate = W.openaiHistory.map((m: any) => m.content).find((c: any) => typeof c === 'string' && c.includes('Run the graded test now'));
        expect(gate).toBeDefined();
        expect(gate).toContain('astropy/wcs/tests/test_wcs.py::test_zero_size_input');
        expect(gate).not.toContain('test_foo.py');
    });
});
