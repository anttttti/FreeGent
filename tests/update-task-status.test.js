// update-task-status.test.js — covers the update_task_status tool end to end.
//
// Regression guard for docs/dead-code-audit-2026-07-25.md §4.1: qa.ts was loaded by
// index.html but NOT by headless-runner.ts, so `transitionTask`/`setTaskStatus`/
// `_updateLedgerRow` were all undefined headless and the handler's `typeof` ladder fell
// through to `Promise.resolve({ transitioned: true })` — returning `{ ok: true }` without
// ever writing the file. 19 calls in the v0.26 benchmark suite got a fabricated success.
//
// The fix loads qa.ts in every entry point and drops the guard ladder. These tests assert
// the observable contract: the file is actually written, and a blocked gate is reported as
// blocked rather than as success.

const W = globalThis;

let files, origRead, origWrite, origRefresh, origRole;

beforeEach(() => {
    files = new Map();
    // update_task_status is filtered at dispatch by the active role's tool set. The default
    // main role is 'agent', which does not have it; 'director' does. Without this the tool
    // is rejected before the handler runs and every assertion below tests nothing.
    origRole = W.mainAgentRole;
    W.setMainAgentRole('director');
    origRead = W.agentReadFile;
    origWrite = W.agentWriteFile;
    origRefresh = W.refreshTasks;
    W.agentReadFile = async (p) => {
        if (!files.has(p)) throw new Error(`File not found: ${p}`);
        return files.get(p);
    };
    W.agentWriteFile = async (p, c) => { files.set(p, c); };
    W.refreshTasks = () => {};
    localStorage.setItem('fg_qa_enabled', 'false'); // gates off: the headless default
});

afterEach(() => {
    if (origRole?.name) W.setMainAgentRole(origRole.name); else W.clearMainAgentRole();
    W.agentReadFile = origRead;
    W.agentWriteFile = origWrite;
    W.refreshTasks = origRefresh;
    localStorage.removeItem('fg_qa_enabled');
});

const TASK = '---\nid: 007\nstatus: todo\ntitle: Demo\n---\n\nBody.\n';

describe('update_task_status', () => {
    it('is wired: qa.ts is loaded in this entry point', () => {
        // The original bug was these being undefined. Assert the wiring directly so a
        // future removal from tests/setup.js or headless-runner.ts fails loudly here.
        expect(typeof W.transitionTask).toBe('function');
        expect(typeof W.setTaskStatus).toBe('function');
        expect(typeof W._updateLedgerRow).toBe('function');
    });

    it('actually writes the new status to the task file', async () => {
        files.set('fg-tasks/007.md', TASK);
        const res = await W.executeToolAsync('update_task_status',
            { path: 'fg-tasks/007.md', status: 'in-progress' }, null);

        expect(res.ok).toBe(true);
        // The assertion that would have failed before the fix:
        expect(files.get('fg-tasks/007.md')).toMatch(/^status: in-progress$/m);
    });

    it('refuses a file that is not a task and leaves it untouched', async () => {
        files.set('config.json', '{"port": 1}\n');
        const res = await W.executeToolAsync('update_task_status',
            { path: 'config.json', status: 'done', log_entry: 'x' }, null);
        expect(res.error).toMatch(/not a task file/);
        expect(files.get('config.json')).toBe('{"port": 1}\n');
    });

    it('appends a log entry when one is supplied', async () => {
        files.set('fg-tasks/007.md', TASK);
        await W.executeToolAsync('update_task_status',
            { path: 'fg-tasks/007.md', status: 'done', log_entry: 'finished the thing' }, null);

        expect(files.get('fg-tasks/007.md')).toMatch(/^status: done$/m);
        expect(files.get('fg-tasks/007.md')).toContain('finished the thing');
    });

    it('reports a blocked gate as blocked, not as success', async () => {
        files.set('fg-tasks/007.md', TASK);
        const real = W.transitionTask;
        W.transitionTask = async () => ({ transitioned: false, reason: 'test gate refused' });
        try {
            const res = await W.executeToolAsync('update_task_status',
                { path: 'fg-tasks/007.md', status: 'done' }, null);
            expect(res.ok).toBe(false);
            expect(res.blocked).toBe(true);
            expect(res.reason).toBe('test gate refused');
        } finally { W.transitionTask = real; }
    });

    it('creates the task file when it does not exist yet', async () => {
        // setTaskStatus deliberately synthesises a stub for a missing path rather than
        // failing — so ok:true is correct here, but only because a file really is written.
        const res = await W.executeToolAsync('update_task_status',
            { path: 'fg-tasks/new-042.md', status: 'done' }, null);
        expect(res.ok).toBe(true);
        expect(files.has('fg-tasks/new-042.md')).toBe(true);
        expect(files.get('fg-tasks/new-042.md')).toMatch(/^status: done$/m);
    });

    // Autopilot exploration 2026-10-28, AE-15: the user deleted the card of the task the runner was on; the agent set its status and the
    // deleted task came back as Done. A task the runner started that is now gone is refused, and nothing is written.
    it('refuses a status for a task the runner started and the user then deleted', async () => {
        const saved = W.runnerStartedTask;
        W.runnerStartedTask = (p) => p === 'fg-tasks/204-delete-me.md';
        try {
            const res = await W.executeToolAsync('update_task_status', { path: 'fg-tasks/204-delete-me.md', status: 'done' }, null);
            expect(res.error).toMatch(/no longer exists: the task was deleted/);
            expect(files.has('fg-tasks/204-delete-me.md')).toBe(false);
        } finally { W.runnerStartedTask = saved; }
    });

    // Audit §4.3 — setTaskStatus used to swallow write failures, so an unwritable
    // workspace produced ok:true (and, since the status never changed on disk, made the
    // autopilot/agent-loop task selectors re-pick the same task forever).
    it('reports an error when the underlying write fails', async () => {
        files.set('fg-tasks/007.md', TASK);
        W.agentWriteFile = async () => { throw new Error('disk full'); };

        const res = await W.executeToolAsync('update_task_status',
            { path: 'fg-tasks/007.md', status: 'done' }, null);

        expect(res.ok).not.toBe(true);
        expect(res.error).toMatch(/could not write/);
        expect(res.error).toMatch(/disk full/);
        // and the file is genuinely unchanged
        expect(files.get('fg-tasks/007.md')).toMatch(/^status: todo$/m);
    });

    it('does not advance the ledger when the task write failed', async () => {
        files.set('fg-tasks/007.md', TASK);
        let ledgerWrites = 0;
        const realLedger = W._updateLedgerRow;
        W._updateLedgerRow = async () => { ledgerWrites++; };
        W.agentWriteFile = async () => { throw new Error('read-only fs'); };
        try {
            await W.executeToolAsync('update_task_status',
                { path: 'fg-tasks/007.md', status: 'done' }, null);
            expect(ledgerWrites).toBe(0);
        } finally { W._updateLedgerRow = realLedger; }
    });

    it('still validates its arguments', async () => {
        expect((await W.executeToolAsync('update_task_status', { path: 'fg-tasks/007.md' }, null)).error)
            .toMatch(/required/);
        expect((await W.executeToolAsync('update_task_status', { status: 'done' }, null)).error)
            .toMatch(/required/);
    });
});
