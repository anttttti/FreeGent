import { describe, it, expect, afterEach } from 'vitest';
import { taskPolicy } from '../task-policy.ts';
import { COMPLETION_GATES, runCompletionGates } from '../completion-gates.ts';
import { installBenchPolicy, uninstallBenchPolicy, benchPolicyRequested } from '../bench-policy.ts';
import { isTestEditProtected } from '../tools.ts';

// A product run (browser, TUI, a user's CLI call) loads no benchmark policy: the FG_* switches change nothing there.
// tests/setup.js installs it for the other test files; here we take it out and put it back.
const names = () => COMPLETION_GATES.map(g => g.name);
afterEach(() => { delete process.env.FG_EDIT_REQUIRED; delete process.env.FG_CHANGE_REQUIRED; delete process.env.FG_PROTECT_TESTS; installBenchPolicy(); });

const ctx = (over: any = {}) => ({
    text: 'Done.\nCOMPLETED', step: 3, loopMax: 40, softStopPending: false, ps: {}, workflowMode: false,
    editedPaths: new Set<string>(), shellWrites: new Set<string>(), editsThisRun: false, editEvents: 0,
    verdict: 'none', stateChanged: false, reactiveFired: new Set<string>(), firstUserText: '', task: 'fix the bug in app.py',
    editRequired: taskPolicy.editRequired(), changeRequired: taskPolicy.changeRequired(), gradedTestIds: () => taskPolicy.gradedTestIds('fix it'),
    isScratchPath: () => false, envConfigEdits: async () => [], brokenFiles: async () => [], ...over,
});

describe('task policy', () => {
    it('with nothing installed the benchmark switches do nothing', async () => {
        uninstallBenchPolicy();
        process.env.FG_EDIT_REQUIRED = '1'; process.env.FG_CHANGE_REQUIRED = '1'; process.env.FG_PROTECT_TESTS = '1';
        expect(taskPolicy.editRequired()).toBe(false);
        expect(taskPolicy.changeRequired()).toBe(false);
        expect(taskPolicy.gradedTestIds('Graded tests:\ntests/test_a.py::test_x\n\n')).toEqual([]);
        expect(taskPolicy.changesState('chmod 600 /etc/sudoers')).toBe(false);
        expect(isTestEditProtected('tests/test_a.py')).toBe(false);
        expect(taskPolicy.completionDirective('`pytest tests/test_a.py::test_x`', new Set())).toBeNull();
        expect(names()).toEqual(['scratch_only_edits', 'broken_syntax', 'failed_check_complete', 'invented_data', 'env_config_edits']);
        // a COMPLETED with no edit on an "edit required" task passes the gates
        expect(await runCompletionGates(ctx())).toBeNull();
    });

    it('installing it adds the gates after the product ones and turns the switches on', async () => {
        uninstallBenchPolicy();
        installBenchPolicy();
        installBenchPolicy();   // idempotent
        expect(names()).toEqual(['scratch_only_edits', 'broken_syntax', 'failed_check_complete', 'invented_data', 'env_config_edits', 'no_edit_complete', 'no_change_fix', 'blocked_untried_fix']);
        process.env.FG_EDIT_REQUIRED = '1';
        expect(taskPolicy.editRequired()).toBe(true);
        const hit = await runCompletionGates(ctx({ editRequired: true }));
        expect(hit?.name).toBe('no_edit_complete');
        process.env.FG_PROTECT_TESTS = '1';
        expect(benchPolicyRequested()).toBe(true);
    });

    it('uninstalling restores the product state', () => {
        installBenchPolicy();
        uninstallBenchPolicy();
        expect(names()).toHaveLength(5);
        expect(taskPolicy.gradedTestIds('`pytest tests/test_a.py::test_x`')).toEqual([]);
    });
});
