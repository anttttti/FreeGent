// v066-fixes.test.ts — fixes from the v0.66 benchmark reports: the graded-test gate bounces only
// for a test that ran and failed, a run_workers result is bounded in history, and one tool result
// cannot fill the compaction tail.
import { describe, it, expect, beforeAll } from 'vitest';
import { _gradedTestIds, _gradedTestFailed } from '../llm-loops.ts';
import { truncateResultForHistory } from '../history.ts';
import { _capTailToolResults } from '../llm-shared.ts';

beforeAll(async () => { await import('../llm-loops.ts'); });

describe('graded-test gate: what counts as a failed graded test', () => {
    const TASK = 'Fix it.\n\nGraded tests (run these to verify your fix before declaring done):\npytest sympy/solvers/tests/test_diophantine.py::test_diophantine\n\nDone.';
    const ids = _gradedTestIds(TASK);
    const tool = (stdout: string, exit_code = 1) => JSON.stringify({ stdout, stderr: '', exit_code });

    it('reads the graded test IDs from the task', () => {
        expect(ids).toEqual(['sympy/solvers/tests/test_diophantine.py::test_diophantine']);
    });
    it('a graded test that ran and failed is a failure', () => {
        expect(_gradedTestFailed(tool('FAILED sympy/solvers/tests/test_diophantine.py::test_diophantine - AssertionError\n=== 1 failed, 44 passed in 18.3s ==='), ids)).toBe(true);
        expect(_gradedTestFailed(tool('=== 16 failed, 18 passed, 14 warnings in 3.25s ==='), ids)).toBe(true);   // no FAILED lines to check
    });
    // v0.66 sympy-18189: the only failures were two tests that are not graded.
    it('failures only in other tests are not', () => {
        expect(_gradedTestFailed(tool('FAILED sympy/solvers/tests/test_diophantine.py::test_fail_holzer - sympy.util...\nFAILED sympy/solvers/tests/test_diophantine.py::test_not_implemented - sympy....\n=== 2 failed, 44 passed, 1 warning in 18.34s ==='), ids)).toBe(false);
    });
    // v0.66: 28 of 32 "still failed" bounces were for output like this.
    it('collection errors, missing tests and listings are not', () => {
        expect(_gradedTestFailed(tool('ERROR tests/test_cli.py\n!!!!! Interrupted: 1 error during collection !!!!!\n=== 1 error in 0.11s ===', 2), ids)).toBe(false);
        expect(_gradedTestFailed(tool('ERROR: not found: /workspace/t.py::test_x\n(no name in any of [<Module t.py>])\n=== no tests ran in 0.01s ===', 4), ids)).toBe(false);
        expect(_gradedTestFailed(tool("ImportError: cannot import name '_c_internal_utils' from 'matplotlib'"), ids)).toBe(false);
        expect(_gradedTestFailed(tool('<Function test_get_namespace>\n=== 18 tests collected in 0.02s ===', 0), ids)).toBe(false);
    });
    it('source that does not parse is', () => {
        expect(_gradedTestFailed(tool('E   SyntaxError: invalid syntax\n=== 1 error in 0.11s ===', 2), ids)).toBe(true);
    });
});

describe('run_workers result in history', () => {
    const paths = Array.from({ length: 462 }, (_, i) => `/app/dclm/baselines/some/long/directory/name/file_${i}.py`);
    const big = {
        agents: [{ id: 'w1', wrote: paths, status: 'complete', note: 'scanned the tree', toolCalls: paths.slice(0, 40).map(p => ({ name: 'read_file', path: p })) },
                 { id: 'w2', wrote: [], status: 'complete', note: 'nothing to change' }],
        applied: paths, conflictsFound: [], conflictsResolved: [], blocked: [],
    };
    it('keeps the first paths and a count, and leaves the raw result alone', () => {
        const before = JSON.stringify(big);
        const out = truncateResultForHistory('run_workers', big, { isDirector: true });
        expect(JSON.stringify(big)).toBe(before);
        expect(out.applied).toHaveLength(31);
        expect(out.applied[30]).toBe('… and 432 more (462 in total)');
        expect(out.agents[0].wrote).toHaveLength(31);
        expect(out.agents[1]).toEqual(big.agents[1]);
        expect(JSON.stringify(out).length).toBeLessThan(8000);
    });
    it('returns a small result unchanged', () => {
        const small = { agents: [{ id: 'w1', wrote: ['a.py'], status: 'complete', note: 'ok' }], applied: ['a.py'], conflictsFound: [], conflictsResolved: [], blocked: [] };
        expect(truncateResultForHistory('run_workers', small, { isDirector: true })).toBe(small);
    });
    it('cuts long texts when the lists were not the problem', () => {
        const wordy = { agents: [{ id: 'w1', wrote: ['a.py'], status: 'partial', note: 'x'.repeat(400_000) }], applied: ['a.py'], conflictsFound: [], conflictsResolved: [], blocked: [] };
        const out = truncateResultForHistory('run_workers', wordy, { isDirector: true });
        expect(JSON.stringify(out).length).toBeLessThanOrEqual(100_000);
        expect(out.agents[0].note).toMatch(/chars not shown\]$/);
        expect(wordy.agents[0].note).toHaveLength(400_000);
    });
});

describe('compaction tail', () => {
    it('cuts one oversized tool result from the middle and keeps the rest', () => {
        const tail = [
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
            { role: 'tool', tool_call_id: 'c1', content: 'A'.repeat(100) + 'x'.repeat(130_000) + 'Z'.repeat(100) },
            { role: 'tool', tool_call_id: 'c2', content: 'short' },
            { role: 'user', content: 'u'.repeat(130_000) },
        ];
        const out = _capTailToolResults(tail, 20_000);   // budget in tokens
        expect(out[0]).toBe(tail[0]);
        expect(out[2]).toBe(tail[2]);
        expect(out[3]).toBe(tail[3]);                    // only tool results are cut
        expect(out[1].tool_call_id).toBe('c1');
        expect(out[1].content.length).toBeLessThan(30_000);
        expect(out[1].content.startsWith('A'.repeat(100))).toBe(true);
        expect(out[1].content.endsWith('Z'.repeat(100))).toBe(true);
        expect(out[1].content).toMatch(/chars removed when the conversation was compacted/);
        expect(tail[1].content).toHaveLength(130_200);
    });
});
