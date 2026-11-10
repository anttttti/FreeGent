// The one-shot completion gates as a table (completion-gates.ts): each answers once, in a fixed order,
// from a plain context object.
import { describe, it, expect } from 'vitest';
import { runCompletionGates, COMPLETION_GATES, completionDeclared, type GateContext } from '../completion-gates.ts';

const ctx = (over: Partial<GateContext> = {}): GateContext => ({
    text: 'Done.\nCOMPLETED', step: 3, loopMax: 20, softStopPending: false, ps: {},
    editedPaths: new Set(), shellWrites: new Set(), editsThisRun: false, editEvents: 0, stateChanged: false, changeRequired: false,
    reactiveFired: new Set(), firstUserText: '', task: 'Answer the question.', editRequired: false,
    gradedTestIds: () => [], isScratchPath: p => /(^|\/)(tmp|repro)/.test(p), brokenFiles: async () => [], ...over,
});

describe('completion gates', () => {
    it('are tried in a fixed order', () => {
        expect(COMPLETION_GATES.map(g => g.name)).toEqual(
            ['broken_syntax', 'test_fixtures_left', 'invented_data', 'planned_tasks_missing', 'no_edit_complete',
             'no_change_fix', 'blocked_untried_fix']);
    });
    it('never fire for BLOCKED, on the last step, or in soft stop', async () => {
        const c = { editsThisRun: true };
        expect(await runCompletionGates(ctx({ ...c, text: 'BLOCKED: cannot import' }))).toBeNull();
        expect(await runCompletionGates(ctx({ ...c, step: 19 }))).toBeNull();
        expect(await runCompletionGates(ctx({ ...c, softStopPending: true }))).toBeNull();
        expect(completionDeclared(ctx(c))).toBe(true);
    });
    it('invented data: an overwritten supplied file, not for an edit task', async () => {
        const prompt = 'Count lines.\n<workspace_files>\nfiles:\nfile1.log\n</workspace_files>';
        const hit = await runCompletionGates(ctx({ firstUserText: prompt, shellWrites: new Set(['file1.log']) }));
        expect(hit?.name).toBe('invented_data');
        expect(hit?.text).toContain('(supplied with the task)');
        const edit = await runCompletionGates(ctx({ firstUserText: prompt, shellWrites: new Set(['file1.log']), editRequired: true, editsThisRun: true, task: 'Fix the parser bug.' }));
        expect(edit).toBeNull();
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

describe('gates added after the v0.72 review', () => {
    // changeRequired is the runner's word (FG_CHANGE_REQUIRED, from the grader); the task wording is never read.
    const fix = { changeRequired: true, task: "Why can't I use sudo?? fix it." };
    it('a change-required task completed with nothing changed bounces once', async () => {
        const c = ctx(fix);
        expect((await runCompletionGates(c))?.name).toBe('no_change_fix');
        expect(await runCompletionGates(c)).toBeNull();
    });
    it('a file edit, a shell write or a state change (apt install, chmod) counts as a change', async () => {
        expect(await runCompletionGates(ctx({ ...fix, editsThisRun: true }))).toBeNull();
        expect(await runCompletionGates(ctx({ ...fix, shellWrites: new Set(['/etc/sudoers']) }))).toBeNull();
        expect((await runCompletionGates(ctx({ ...fix, stateChanged: true })))?.name).not.toBe('no_change_fix');
    });
    it('without the runner flag the wording is not read, and code tasks stay with the no-edit gate', async () => {
        expect(await runCompletionGates(ctx({ task: "Why can't I use sudo?? fix it." }))).toBeNull();
        expect(await runCompletionGates(ctx({ ...fix, editRequired: true }))).toMatchObject({ name: 'no_edit_complete' });
        expect(await runCompletionGates(ctx({ ...fix, gradedTestIds: () => ['t.py::a'] }))).toMatchObject({ name: 'no_edit_complete' });
    });
    it('BLOCKED on a change-required task with nothing tried bounces once; BLOCKED elsewhere is left alone', async () => {
        const text = 'BLOCKED: What is the exact error message you receive?';
        const c = ctx({ ...fix, text });
        expect((await runCompletionGates(c))?.name).toBe('blocked_untried_fix');
        expect(await runCompletionGates(c)).toBeNull();
        expect(await runCompletionGates(ctx({ ...fix, text, stateChanged: true }))).toBeNull();
        expect(await runCompletionGates(ctx({ text }))).toBeNull();
        expect(await runCompletionGates(ctx({ ...fix, text, step: 19 }))).toBeNull();
        expect(await runCompletionGates(ctx({ ...fix, text: 'BLOCKED: x\nCOMPLETED' }))).toBeNull();
    });
});

// Chat log 45cdc500 (task 107): an edit broke render.js, the page's load error was called "pre-existing", the task was marked done.
describe('broken_syntax', () => {
    const report = 'src/render.js:1290:5: SyntaxError: Unexpected token';
    it('bounces once, forced, when a changed file no longer parses, naming the error', async () => {
        let asked: string[] = [];
        const c = ctx({ editsThisRun: true, editedPaths: new Set(['src/render.js', 'tmp/probe.js']), brokenFiles: async (p) => { asked = [...p]; return [report]; } });
        const hit = await runCompletionGates(c);
        expect(hit?.name).toBe('broken_syntax');
        expect(hit?.force).toBe(true);
        expect(hit?.text).toContain(report);
        expect(hit?.text).toMatch(/do not call the error pre-existing/);
        expect(asked).toEqual(['src/render.js']);   // scratch files are not checked
        expect(await runCompletionGates(c)).toBeNull();
    });
    it('says nothing when the changed files parse, or nothing was changed', async () => {
        expect(await runCompletionGates(ctx({ editsThisRun: true, editedPaths: new Set(['src/a.js']) }))).toBeNull();
        let called = false;
        expect(await runCompletionGates(ctx({ brokenFiles: async () => { called = true; return [report]; } }))).toBeNull();
        expect(called).toBe(false);
    });
});

describe('test fixtures left in the system', () => {
    const cmds = ['useradd -m testuser', 'echo "testuser ALL=(ALL) ALL" >> /etc/sudoers.d/testuser'];
    it('names the users and sudoers files it created when the task did not ask for any, once', async () => {
        const c = ctx({ task: "Why can't I use sudo?? fix it.", shellCommands: cmds });
        const hit = await runCompletionGates(c);
        expect(hit?.name).toBe('test_fixtures_left');
        expect(hit?.text).toMatch(/user testuser, \/etc\/sudoers\.d\/testuser/);
        expect(await runCompletionGates(c)).toBeNull();
    });
    it('a sudoers.d file for no created user is the fix, not a fixture (OS 40)', async () => {
        expect(await runCompletionGates(ctx({ task: "Why can't I use sudo?? fix it.", shellCommands: ['echo "root ALL=(ALL:ALL) ALL" > /etc/sudoers.d/90-root-access'] }))).toBeNull();
    });
    it('is silent when the task is about users', async () => {
        expect(await runCompletionGates(ctx({ task: 'Create a user alice and let her use sudo.', shellCommands: ['useradd alice'] }))).toBeNull();
    });
});

describe('planned_tasks_missing: a reply that lists tasks the board does not have', () => {
    const planned = (over: Partial<GateContext> = {}) => ctx({
        text: 'Plan:\n1. **Task 001: Setup**\n2. **Task 002: Logic**\n3. **Task 003: UI**\nCOMPLETED', taskIds: async () => new Set(['1']), ...over });
    it('asks once for the missing task files, forcing a tool call; the second COMPLETED passes', async () => {
        const c = planned();
        const hit = await runCompletionGates(c);
        expect(hit?.name).toBe('planned_tasks_missing');
        expect(hit?.force).toBe(true);
        expect(hit?.text).toMatch(/#002, #003/);
        expect(await runCompletionGates(c)).toBeNull();
    });
    it('asks twice when the board is still empty (the plan came as text), then lets it pass', async () => {
        const c = planned({ taskIds: async () => new Set() });
        expect((await runCompletionGates(c))?.name).toBe('planned_tasks_missing');
        expect((await runCompletionGates(c))?.name).toBe('planned_tasks_missing');
        expect(await runCompletionGates(c)).toBeNull();
    });
    it('names files by path too, and is silent when every named task exists, there is no board, or the reply names none', async () => {
        expect((await runCompletionGates(planned({ text: 'Created fg-tasks/001-a.md and fg-tasks/004-d.md\nCOMPLETED' })))?.text).toMatch(/#004/);
        expect((await runCompletionGates(planned({ text: 'Plan: 1. `002`: logic 2. `003`: ui\nCOMPLETED' })))?.text).toMatch(/#002, #003/);
        expect(await runCompletionGates(planned({ taskIds: async () => new Set(['1', '2', '3']) }))).toBeNull();
        expect(await runCompletionGates(planned({ taskIds: async () => null }))).toBeNull();
        expect((await runCompletionGates(planned({ taskIds: async () => new Set() })))?.text).toMatch(/the board has none/);   // Cowork, nothing written yet
        expect(await runCompletionGates(planned({ taskIds: undefined }))).toBeNull();
        expect(await runCompletionGates(planned({ text: 'Made the change.\nCOMPLETED' }))).toBeNull();
    });
});

describe('planned_tasks_missing: files the request names that no task covers', () => {
    const planning = (over: Partial<GateContext> = {}) => ctx({
        text: 'Planned.\nCOMPLETED', task: 'Create a tip page: write calc.js with test_calc.mjs, and index.html. Plan it as Kanban tasks.', planning: true,
        taskIds: async () => new Set(['1']), taskText: async () => '# set up calc.js and test_calc.mjs', ...over });
    it('asks once for the task that covers the left-out file', async () => {
        const c = planning();
        const hit = await runCompletionGates(c);
        expect(hit?.name).toBe('planned_tasks_missing');
        expect(hit?.text).toMatch(/index\.html/);
        expect(hit?.text).not.toMatch(/calc\.js,/);
        expect(await runCompletionGates(c)).toBeNull();
    });
    it('also asks for acceptance criteria on the task files written without them, in the same single bounce', async () => {
        const c = planning({ taskText: async () => 'calc.js test_calc.mjs index.html', noCriteria: async () => ['fg-tasks/001-a.md'] });
        const hit = await runCompletionGates(c);
        expect(hit?.text).toMatch(/fg-tasks\/001-a\.md has no "## Acceptance Criteria"/);
        expect(hit?.text).not.toMatch(/no task covers/);
        expect(await runCompletionGates(c)).toBeNull();
    });
    it('is silent when every file is covered, outside the planning turn, or without a board', async () => {
        expect(await runCompletionGates(planning({ taskText: async () => 'calc.js test_calc.mjs index.html' }))).toBeNull();
        expect(await runCompletionGates(planning({ planning: false }))).toBeNull();
        expect(await runCompletionGates(planning({ taskText: undefined }))).toBeNull();
    });
});
