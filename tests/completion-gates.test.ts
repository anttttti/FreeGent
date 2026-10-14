// The one-shot completion gates as a table (completion-gates.ts): each answers once, in a fixed order,
// from a plain context object.
import { describe, it, expect } from 'vitest';
import { runCompletionGates, COMPLETION_GATES, completionDeclared, type GateContext } from '../completion-gates.ts';

const ctx = (over: Partial<GateContext> = {}): GateContext => ({
    text: 'Done.\nCOMPLETED', step: 3, loopMax: 20, softStopPending: false, ps: {}, workflowMode: true,
    editedPaths: new Set(), shellWrites: new Set(), editsThisRun: false, editEvents: 0, verdict: 'no_change',
    reactiveFired: new Set(), firstUserText: '', task: 'Answer the question.', editRequired: false,
    gradedTestIds: () => [], isScratchPath: p => /(^|\/)(tmp|repro)/.test(p), envConfigEdits: async () => [], ...over,
});

describe('completion gates', () => {
    it('are tried in a fixed order', () => {
        expect(COMPLETION_GATES.map(g => g.name)).toEqual(
            ['scratch_only_edits', 'failed_check_complete', 'invented_data', 'env_config_edits', 'no_edit_complete']);
    });
    it('never fire for BLOCKED, on the last step, or in soft stop', async () => {
        const c = { verdict: 'failed_verification' as const, editsThisRun: true };
        expect(await runCompletionGates(ctx({ ...c, text: 'BLOCKED: cannot import' }))).toBeNull();
        expect(await runCompletionGates(ctx({ ...c, step: 19 }))).toBeNull();
        expect(await runCompletionGates(ctx({ ...c, softStopPending: true }))).toBeNull();
        expect(completionDeclared(ctx(c))).toBe(true);
    });
    it('scratch-only edits bounce once and do not force a tool call', async () => {
        const c = ctx({ editedPaths: new Set(['repro_a.py', 'tmp/x.py']), editsThisRun: true });
        const hit = await runCompletionGates(c);
        expect(hit?.name).toBe('scratch_only_edits');
        expect(hit?.force).toBe(false);
        expect(await runCompletionGates(c)).toBeNull();   // counter set: the second COMPLETED passes
    });
    it('a failing check bounces once, and not when the graded-test gate owns it', async () => {
        const c = ctx({ editsThisRun: true, verdict: 'failed_verification', editedPaths: new Set(['src/a.py']) });
        expect((await runCompletionGates(c))?.name).toBe('failed_check_complete');
        expect(await runCompletionGates(c)).toBeNull();
        const owned = ctx({ editsThisRun: true, verdict: 'failed_verification', reactiveFired: new Set(['graded_test']) });
        expect(await runCompletionGates(owned)).toBeNull();
    });
    it('invented data: an overwritten supplied file, not for an edit task', async () => {
        const prompt = 'Count lines.\n<workspace_files>\nfiles:\nfile1.log\n</workspace_files>';
        const hit = await runCompletionGates(ctx({ firstUserText: prompt, shellWrites: new Set(['file1.log']) }));
        expect(hit?.name).toBe('invented_data');
        expect(hit?.text).toContain('(supplied with the task)');
        const edit = await runCompletionGates(ctx({ firstUserText: prompt, shellWrites: new Set(['file1.log']), editRequired: true, editsThisRun: true, task: 'Fix the parser bug.' }));
        expect(edit).toBeNull();
    });
    it('test-environment edits: two bounces at most, the second only after new edits', async () => {
        const c = ctx({ editsThisRun: true, envConfigEdits: async () => ['conftest.py'], editEvents: 1 });
        expect((await runCompletionGates(c))?.name).toBe('env_config_edits');
        expect(await runCompletionGates(c)).toBeNull();          // repeated COMPLETED with no new edits passes
        c.editEvents = 2;
        expect((await runCompletionGates(c))?.name).toBe('env_config_edits');
        c.editEvents = 3;
        expect(await runCompletionGates(c)).toBeNull();          // cap of two
    });
    it('no edit on an edit task bounces once and forces a tool call', async () => {
        const c = ctx({ editRequired: true });
        const hit = await runCompletionGates(c);
        expect(hit?.name).toBe('no_edit_complete');
        expect(hit?.force).toBe(true);
        expect(await runCompletionGates(c)).toBeNull();
        expect(await runCompletionGates(ctx())).toBeNull();     // not an edit task
    });
});
