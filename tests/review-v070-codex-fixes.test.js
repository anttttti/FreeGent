// Fixes from the v0.70 last-20-commits review, one block per finding.
import { setWorkflowMode } from '../state.ts';
import { setReplyChannelHint } from '../reply-channel.ts';
import { _handleTurnState } from '../turn-protocol.ts';
import { truncateResultForHistory } from '../history.ts';
import { formatThrown } from '../exec-sandbox/js-run.ts';
import { _waitUntilQuiet } from '../runner.ts';
import { gatherReviewCode } from '../qa.ts';

const W = globalThis;
await import('../post-turn.ts');
await import('../tasks.ts');

const STUBBED = ['agentListFiles', 'agentReadFile', 'agentWriteFile', 'agentDeleteFile', 'callLLMComplete', 'refreshTasks'];
let saved, files, mtimes;
beforeEach(() => {
    saved = Object.fromEntries(STUBBED.map(k => [k, W[k]]));
    files = {}; mtimes = {};
    W.agentListFiles = async () => Object.entries(files).map(([name]) => ({ name, lastModified: mtimes[name] ?? 0, isLocal: name.startsWith('local/') }));
    W.agentReadFile = async (p) => { if (!(p in files)) throw new Error(`nf ${p}`); return files[p]; };
    W.agentWriteFile = async (p, c) => { files[p] = c; };
    W.agentDeleteFile = async (p) => { delete files[p]; };
    W.refreshTasks = async () => {};
    localStorage.setItem('fg_qa_enabled', 'true');
    localStorage.setItem('fg_qa_test_runner', 'false');
    localStorage.setItem('fg_qa_acceptance_review', 'true');
});
afterEach(() => { for (const k of STUBBED) W[k] = saved[k]; localStorage.clear(); });

describe('1. a task marked done in the file is not trusted without the completion gates', () => {
    const path = 'fg-tasks/001-a.md';
    const task = '---\nid: 001\ntitle: A\nstatus: in-progress\n---\n# A\n## Acceptance Criteria\n- [ ] works\n';
    it('records the gate pass only when update_task_status / transitionTask reached done', async () => {
        files[path] = task.replace('- [ ] works', '- [x] works'); files['app.js'] = 'x';
        W.callLLMComplete = vi.fn().mockResolvedValue('NO');
        W.forgetGatePass(path);
        expect(W.gatesPassedDone(path)).toBe(false);
        const tr = await W.transitionTask(path, 'done'); expect(tr).toEqual({ transitioned: true });
        expect(W.gatesPassedDone(path)).toBe(true);
        W.forgetGatePass(path);
        expect(W.gatesPassedDone(path)).toBe(false);
    });
    it('a refused transition leaves no evidence, and an edited status line is not evidence', async () => {
        files[path] = task; files['app.js'] = 'x';
        W.callLLMComplete = vi.fn().mockResolvedValue('YES\npayload: works — no');
        W.forgetGatePass(path);
        expect((await W.transitionTask(path, 'done')).transitioned).toBe(false);
        expect(W.gatesPassedDone(path)).toBe(false);
        files[path] = files[path].replace('status: in-progress', 'status: done');   // what write_file / the shell can do
        expect(W.gatesPassedDone(path)).toBe(false);
    });
});

describe('2. the runner waits for a turn that is still preparing', () => {
    afterEach(() => { delete W.turnsInFlight; });
    it('is not quiet while a turn is in flight before agentStreaming is set, and is once it ends', async () => {
        let inFlight = 1;
        W.turnsInFlight = () => inFlight;
        setTimeout(() => { inFlight = 0; }, 300);
        const t0 = Date.now();
        expect(await _waitUntilQuiet(0, 5_000)).toBe(true);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
    });
    it('reports "still busy" (false) when the turn outlasts the wait', async () => {
        W.turnsInFlight = () => 1;
        expect(await _waitUntilQuiet(0, 300)).toBe(false);
    });
});

describe('3/4. acceptance review input', () => {
    it('includes source files of a project kept in the Local Folder', async () => {
        files['local/index.html'] = '<canvas></canvas>'; files['local/js/game.js'] = 'function jump(){}';
        files['local/node_modules/lib/x.js'] = 'noise';
        const r = await gatherReviewCode([]);
        expect(r.shown.sort()).toEqual(['local/index.html', 'local/js/game.js']);
    });
    it('lists omitted files as a sample and a count, not all of them', async () => {
        for (let i = 0; i < 5000; i++) files[`src/module-${i}-with-a-rather-long-file-name.js`] = 'x';
        const r = await gatherReviewCode([]);
        expect(r.shown).toHaveLength(12);
        expect(r.omitted).toHaveLength(20);
        expect(r.omittedCount).toBe(4988);
        files['fg-tasks/003-x.md'] = '---\nid: 003\ntitle: X\nstatus: in-review\n---\n## Acceptance Criteria\n- [ ] ok\n';
        W.callLLMComplete = vi.fn().mockResolvedValue('NO');
        await W.transitionTask('fg-tasks/003-x.md', 'done');
        const prompt = W.callLLMComplete.mock.calls[0][0];
        expect(prompt).toContain('(and 4968 more)');
        expect(prompt.length).toBeLessThan(160_000);
    });
});

describe('5. run_workers results stay inside the limit and count against the step budget', () => {
    const paths = (n, tag) => Array.from({ length: n }, (_, i) => `src/components/${tag}/module-number-${i}/index.ts`);
    const result = () => ({ ok: true, agents: [{ id: 'a', status: 'done', wrote: paths(30, 'a') }, { id: 'b', status: 'done', wrote: paths(30, 'b') }], applied: [...paths(30, 'a'), ...paths(30, 'b')] });
    it('fits a 1,000-character allowance and debits what it kept', () => {
        const budget = { remaining: 1000 };
        const out = truncateResultForHistory('run_workers', result(), { stepBudget: budget });
        const size = JSON.stringify(out).length;
        expect(size).toBeLessThanOrEqual(1000);
        expect(budget.remaining).toBe(1000 - size);
    });
    it('shows a note when no budget is left', () => {
        const out = truncateResultForHistory('run_workers', result(), { stepBudget: { remaining: 0 } });
        expect(JSON.stringify(out).length).toBeLessThan(200);
        expect(out.truncated).toBe(true);
    });
});

describe('6. a request without a question mark is routed through the reply channel', () => {
    const pushed = [];
    const adapter = () => ({ pushNudge: (t) => { pushed.push(t); }, spliceFromSecondLast: () => {}, histLen: () => 2 });
    const ps = () => ({ finalCheck: 0, cont: 0, saved: null, substCheck: 0, checkFires: {} });
    const HINT = 'Send it with POST /message.';
    beforeEach(() => { pushed.length = 0; setWorkflowMode(true); setReplyChannelHint(HINT); });
    afterEach(() => { setReplyChannelHint(''); setWorkflowMode(false); });
    it('sends the hint, not the "cannot ask the user" redirection (and asks the judge once)', async () => {
        W.callLLMComplete = vi.fn().mockResolvedValue('YES');   // the judge: this reply asks the counterpart for information
        const r = await _handleTurnState('Please provide your order number.\nCOMPLETED', 3, ps(), adapter());
        expect(r.kind).toBe('continue');
        expect(pushed).toEqual([HINT]);
        expect(W.callLLMComplete).toHaveBeenCalledTimes(1);
    });
    it('still lets a finished task through', async () => {
        expect((await _handleTurnState('I have cancelled the order and refunded it.\nCOMPLETED', 3, ps(), adapter())).kind).toBe('return');
        expect(pushed).toEqual([]);
    });
});

describe('8. formatThrown keeps the head when a WebKit frame contains the message', () => {
    it('prepends it', () => {
        const e = { name: 'Error', message: 'draw', stack: 'draw@https://example.test/index.html:10:3\nasyncFunctionResume@[native code]' };
        expect(formatThrown(e)).toBe('Error: draw\ndraw@https://example.test/index.html:10:3');
    });
    it('does not repeat it for a V8 stack with an empty message', () => {
        const e = { name: 'Error', message: '', stack: 'Error\n    at <anonymous>:1:7' };
        expect(formatThrown(e)).toBe('Error\n    at <anonymous>:1:7');
    });
});
