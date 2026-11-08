// The done gates run the project's own tests and load its page. Autopilot exploration 2026-10-27 (AE-01, AE-09): the test runner
// looked only for X.test.js beside files named in a "## Files" section, so it was skipped in 144 of 144 done transitions while
// tasks broke test_*.mjs files written by earlier tasks; and nothing loaded the page, so three of ten projects ended with a page
// that drew nothing and every task done.
const W = globalThis;
await import('../post-turn.ts');
await import('../tasks.ts');
const { findProjectTests } = await import('../qa.ts');

const STUBBED = ['agentListFiles', 'agentReadFile', 'agentWriteFile', 'agentDeleteFile', 'callLLMComplete', 'refreshTasks', 'executeToolAsync', '_hasBashOrCode', 'runPageCheck'];
let saved, files, runs;

const TASK = 'fg-tasks/005-high-score.md';
const task = (id) => `---\nid: ${id}\ntitle: High score\nstatus: in-progress\n---\n# High score\nKeep the best score.\n`;

beforeEach(() => {
    saved = Object.fromEntries(STUBBED.map(k => [k, W[k]]));
    files = { [TASK]: task('005') };
    runs = [];
    W.agentListFiles = async () => Object.keys(files).map(name => ({ name }));
    W.agentReadFile = async (p) => { if (!(p in files)) throw new Error(`File not found: ${p}`); return files[p]; };
    W.agentWriteFile = async (p, c) => { files[p] = c; };
    W.agentDeleteFile = async (p) => { delete files[p]; };
    W.refreshTasks = async () => {};
    W._hasBashOrCode = () => true;
    W.runPageCheck = undefined;
    W.executeToolAsync = async (_name, args) => { runs.push(args.code); return { stdout: '1 test file(s) passed', stderr: '', exit_code: 0 }; };
    localStorage.setItem('fg_qa_enabled', 'true');
    localStorage.setItem('fg_qa_acceptance_review', 'false');
    localStorage.setItem('fg_qa_test_runner', 'true');
});
afterEach(() => { for (const k of STUBBED) W[k] = saved[k]; localStorage.clear(); });

describe('findProjectTests', () => {
    it('finds tests by the usual conventions, shallow first, and skips dependencies, scratch and the task folders', async () => {
        for (const f of ['test_enemies.mjs', 'src/game.test.js', 'tests/test_cli.py', 'wordcount_test.py', 'lib/x.spec.mjs',
            'node_modules/pkg/test_x.js', 'fg-tasks/test_t.mjs', 'dist/test_d.js', 'src/game.js', 'testdata.json', 'run_tests.mjs'])
            files[f] = '';
        expect(await findProjectTests()).toEqual(['test_enemies.mjs', 'wordcount_test.py', 'lib/x.spec.mjs', 'src/game.test.js', 'tests/test_cli.py']);
    });
    it('keeps the old mapping for files a task names', async () => {
        files['src/a.test.js'] = '';
        expect(await findProjectTests(['src/a.js'])).toEqual(['src/a.test.js']);
    });
});

describe('test-runner gate', () => {
    it('runs every test file on its own (node or python3) for a task without a Files section', async () => {
        files['test_game.mjs'] = 'x'; files['test_wordcount.py'] = 'y';
        const r = await W.transitionTask(TASK, 'done');
        expect(r.transitioned).toBe(true);
        expect(runs).toHaveLength(1);
        expect(runs[0]).toContain("node 'test_game.mjs'");
        expect(runs[0]).toMatch(/python3 -c '[\s\S]*runpy[\s\S]*' 'test_wordcount\.py'/);
        expect(files['memory/log.md']).toMatch(/test-runner ✓/);
    });
    it('blocks done on a failing test, naming it; the same failure at the next done is accepted as unverified', async () => {
        files['test_game.mjs'] = 'x'; files['test_player.mjs'] = 'y';
        W.executeToolAsync = async () => ({ stdout: '== test_game.mjs (exit 1)\nReferenceError: localStorage is not defined\nFAILED: test_game.mjs\n', stderr: '', exit_code: 1 });
        const first = await W.transitionTask(TASK, 'done');
        expect(first.transitioned).toBe(false);
        expect(first.reason).toMatch(/Tests failed: test_game\.mjs\. ReferenceError: localStorage is not defined/);
        expect(files[TASK]).toMatch(/## QA: Test Failures/);
        expect(files[TASK]).toMatch(/status: in-progress/);
        const second = await W.transitionTask(TASK, 'done');
        expect(second.transitioned).toBe(true);
        expect(second.unverified.join(' ')).toMatch(/test_game\.mjs still fails \(accepted on the second attempt\)/);
        expect(files[TASK]).toMatch(/qa: unverified/);
    });
    it('a failure met again is accepted only when the task changed nothing in the project since it started (kanbanflow 2026-11-08)', async () => {
        const stamps = { 'test_game.mjs': 1, 'game.js': 1 };
        files['test_game.mjs'] = 'x'; files['game.js'] = 'y';
        W.agentListFiles = async () => Object.keys(files).map(name => ({ name, lastModified: stamps[name] ?? 0 }));
        W.executeToolAsync = async () => ({ stdout: '== test_game.mjs (exit 1)\nTypeError: countWords is not a function\nFAILED: test_game.mjs\n', stderr: '', exit_code: 1 });
        const untouched = 'fg-tasks/006-untouched.md', touched = 'fg-tasks/007-touched.md';
        files[untouched] = task('006'); files[touched] = task('007');
        await W.transitionTask(untouched, 'in-progress');
        expect((await W.transitionTask(untouched, 'done')).transitioned).toBe(false);
        expect((await W.transitionTask(untouched, 'done')).transitioned).toBe(true);   // nothing changed: the failure was there before the task
        await W.transitionTask(touched, 'in-progress');
        stamps['game.js'] = 2;   // the task edited the code
        expect((await W.transitionTask(touched, 'done')).transitioned).toBe(false);
        expect((await W.transitionTask(touched, 'done')).transitioned).toBe(false);   // a re-sent done does not pass while the test still fails
        W.executeToolAsync = async () => ({ stdout: '1 test file(s) passed', stderr: '', exit_code: 0 });
        expect((await W.transitionTask(touched, 'done')).transitioned).toBe(true);
    });
    it('a task set to failed right after a bounced done is challenged once; the second failed stands (kanbanflow 2026-11-08)', async () => {
        const t = 'fg-tasks/008-give-up.md';
        files[t] = task('008'); files['test_a.mjs'] = 'x';
        W.executeToolAsync = async () => ({ stdout: 'AssertionError: no\nFAILED: test_a.mjs\n', stderr: '', exit_code: 1 });
        expect((await W.transitionTask(t, 'done')).transitioned).toBe(false);
        const first = await W.transitionTask(t, 'failed');
        expect(first.transitioned).toBe(false);
        expect(first.reason).toMatch(/Not marked failed yet.*Tests failed: test_a\.mjs/);
        expect((await W.transitionTask(t, 'failed')).transitioned).toBe(true);
        expect(files[t]).toMatch(/status: failed/);
    });
    it('failed without an earlier bounce is not challenged', async () => {
        const t = 'fg-tasks/009-plain.md';
        files[t] = task('009');
        expect((await W.transitionTask(t, 'failed')).transitioned).toBe(true);
    });
    it('a different failure after a fix is bounced again', async () => {
        files['test_a.mjs'] = 'x'; files['test_b.mjs'] = 'y';
        let failing = 'test_a.mjs';
        W.executeToolAsync = async () => ({ stdout: `AssertionError: no\nFAILED: ${failing}\n`, stderr: '', exit_code: 1 });
        expect((await W.transitionTask(TASK, 'done')).transitioned).toBe(false);
        failing = 'test_b.mjs';
        expect((await W.transitionTask(TASK, 'done')).transitioned).toBe(false);
    });
    it('a test framework the sandbox lacks is not a failure of the code', async () => {
        files['src/x.test.js'] = "import test from 'node:test'";
        W.executeToolAsync = async () => ({ stdout: "Error: Cannot find module 'node:test'\nFAILED: src/x.test.js\n", stderr: '', exit_code: 1 });
        const r = await W.transitionTask(TASK, 'done');
        expect(r.transitioned).toBe(true);
        expect(r.unverified.join(' ')).toMatch(/lacks/);
    });
    it("npm init's placeholder test script is not run", async () => {
        files['package.json'] = JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } });
        files['test_m.mjs'] = 'x';
        await W.transitionTask(TASK, 'done');
        expect(runs[0]).toContain("node 'test_m.mjs'");
        expect(runs[0]).not.toContain('npm test');
    });
    it('no test files: skipped, as before', async () => {
        const r = await W.transitionTask(TASK, 'done');
        expect(r.transitioned).toBe(true);
        expect(runs).toHaveLength(0);
        expect(files['memory/log.md']).toMatch(/test-runner –/);
    });
});

describe('test-runner gate timeout', () => {
    it('gives up on a test run that never returns (AE-11) and accepts the task as unverified', async () => {
        vi.useFakeTimers();
        try {
            files['test_a.mjs'] = 'x';
            const seen = [];
            W.executeToolAsync = (_name, args) => { seen.push(args); return new Promise(() => {}); };
            const p = W.transitionTask(TASK, 'done');
            await vi.advanceTimersByTimeAsync(96_000);
            expect(seen[0].timeout_s).toBe(90);   // the run has its own limit; the race above is only a backstop
            const r = await p;
            expect(r.transitioned).toBe(true);
            expect(files['memory/log.md']).toMatch(/test-runner \?/);
        } finally { vi.useRealTimers(); }
    });
});

describe('page-check gate', () => {
    it('loads the root index.html and blocks done on a page error; the same errors next time are accepted as unverified', async () => {
        files['index.html'] = '<script type="module" src="src/main.js"></script>';
        const checked = [];
        W.runPageCheck = async (p) => { checked.push(p); return { path: p, loaded: true, summary: '1 error(s)', errors: [{ text: 'ReferenceError: update is not defined', count: 1 }] }; };
        const first = await W.transitionTask(TASK, 'done');
        expect(checked).toEqual(['index.html']);
        expect(first.transitioned).toBe(false);
        expect(first.reason).toMatch(/\[page-check\] index\.html reports an error when it loads: ReferenceError: update is not defined/);
        expect(files[TASK]).toMatch(/## QA: Page Errors/);
        const second = await W.transitionTask(TASK, 'done');
        expect(second.transitioned).toBe(true);
        expect(second.unverified.join(' ')).toMatch(/still reports errors/);
    });
    it('blocks done on a page that crashed the tab and is unchanged (it is refused, not passed), once', async () => {
        files['index.html'] = '<script>for(;;){}</script>';
        W.runPageCheck = async () => ({ error: 'check_page: The browser tab crashed or was killed while check_page ran "index.html" (…). Fix it before running check_page on this page again.', crashed: true });
        const first = await W.transitionTask(TASK, 'done');
        expect(first.transitioned).toBe(false);
        expect(first.reason).toMatch(/index\.html: The browser tab crashed or was killed[\s\S]*Then set the status again/);
        expect(files[TASK]).toMatch(/## QA: Page Crashed the Tab/);
        const second = await W.transitionTask(TASK, 'done');
        expect(second.transitioned).toBe(true);
        expect(second.unverified.join(' ')).toMatch(/crashed the browser tab and is unchanged/);
    });
    it('blocks a page that loads without an error but shows nothing (AE-18), once', async () => {
        files['index.html'] = '<canvas id="c"></canvas><script type="module" src="src/main.js"></script>';
        W.runPageCheck = async (p) => ({ path: p, loaded: true, blank: true, summary: 'Loaded fine; no errors.', errors: [] });
        const first = await W.transitionTask(TASK, 'done');
        expect(first.transitioned).toBe(false);
        expect(first.reason).toMatch(/index\.html reports an error when it loads: The page shows nothing/);
        expect((await W.transitionTask(TASK, 'done')).transitioned).toBe(true);
    });
    it('passes a page without errors, and skips a project with no page at the root', async () => {
        W.runPageCheck = async (p) => ({ path: p, loaded: true, summary: 'Loaded fine; no errors.', errors: [] });
        files['docs/index.html'] = '<p>';
        let r = await W.transitionTask(TASK, 'done');
        expect(files['memory/log.md']).toMatch(/page-check –/);
        files[TASK] = task('005');
        files['index.html'] = '<canvas>';
        r = await W.transitionTask(TASK, 'done');
        expect(r).toEqual({ transitioned: true });
        expect(files['memory/log.md'].trim().split('\n').pop()).toMatch(/page-check ✓/);
    });
    it('is off with the test runner', async () => {
        localStorage.setItem('fg_qa_test_runner', 'false');
        files['index.html'] = '<canvas>';
        W.runPageCheck = vi.fn();
        await W.transitionTask(TASK, 'done');
        expect(W.runPageCheck).not.toHaveBeenCalled();
    });
});

describe('the failure the reason quotes', () => {
    it("the first line a failing file printed, or a Python traceback's exception", async () => {
        files['test_a.mjs'] = 'x';
        W.executeToolAsync = async () => ({ stdout: '== test_a.mjs (exit 1)\nf is not a function\n== test_b.py (exit 1)\nTraceback (most recent call last):\n  File "t.py", line 1\nImportError: no f\nFAILED: test_a.mjs test_b.py\n', exit_code: 1 });
        expect((await W.transitionTask(TASK, 'done')).reason).toMatch(/Tests failed: test_a\.mjs, test_b\.py\. f is not a function\./);
        files['fg-tasks/006-other.md'] = task('006');
        W.executeToolAsync = async () => ({ stdout: '== test_b.py (exit 1)\nTraceback (most recent call last):\n  File "t.py", line 1\nImportError: no f\nFAILED: test_b.py\n', exit_code: 1 });
        expect((await W.transitionTask('fg-tasks/006-other.md', 'done')).reason).toMatch(/Tests failed: test_b\.py\. ImportError: no f\./);
    });
});

// Autopilot exploration 2026-10-28, AE-12: task 004 rewrote index.html from scratch and the search box of the done task 001 was gone;
// every gate passed. kept-features names what the task removed that an earlier done task mentions, once.
describe('kept-features gate', () => {
    const T1 = 'fg-tasks/001-search-box.md', T4 = 'fg-tasks/004-chart-small-screens.md';
    const done1 = `---\nid: 001\ntitle: Search box\nstatus: done\n---\n# Search box\nAdd a search input that filters the table.\n`;
    const t4 = (st) => `---\nid: 004\ntitle: Fix the chart on small screens\nstatus: ${st}\n---\n# Chart\nMake the chart fit.\n`;
    const page = (search) => `<html><body>${search ? '<input id="search">' : ''}<canvas id="chart"></canvas><script>function drawChart(){}${search ? 'function filterRows(){}' : ''}</script></body></html>`;
    beforeEach(() => { localStorage.setItem('fg_qa_test_runner', 'false'); });

    it('bounces a done that removed the earlier task\'s #search, then accepts it the second time', async () => {
        Object.assign(files, { [T1]: done1, [T4]: t4('todo'), 'index.html': page(true) });
        delete files[TASK];
        W.loadTaskFiles = async () => Object.keys(files).filter(f => /^fg-tasks\/\d+-/.test(f)).map(f => ({ path: f, fm: { id: f.slice(9, 12), title: /title: (.*)/.exec(files[f])[1], status: /status: (.*)/.exec(files[f])[1] } }));
        expect((await W.transitionTask(T4, 'in-progress')).transitioned).toBe(true);
        files['index.html'] = page(false);                       // the full rewrite
        const first = await W.transitionTask(T4, 'done');
        expect(first.transitioned).toBe(false);
        expect(first.reason).toMatch(/search \(index\.html; task #001 "Search box"\)/);
        expect(first.reason).not.toMatch(/filterRows/);          // not mentioned by any done task
        const second = await W.transitionTask(T4, 'done');
        expect(second.transitioned).toBe(true);
    });

    it('says nothing when the earlier work is still there or nothing mentions it', async () => {
        Object.assign(files, { [T1]: done1, [T4]: t4('todo'), 'index.html': page(true) });
        delete files[TASK];
        W.loadTaskFiles = async () => Object.keys(files).filter(f => /^fg-tasks\/\d+-/.test(f)).map(f => ({ path: f, fm: { id: f.slice(9, 12), title: /title: (.*)/.exec(files[f])[1], status: /status: (.*)/.exec(files[f])[1] } }));
        await W.transitionTask(T4, 'in-progress');
        files['index.html'] = page(true).replace('<canvas id="chart"></canvas>', '<canvas id="chart" width="320"></canvas>');
        expect((await W.transitionTask(T4, 'done')).transitioned).toBe(true);
    });
});
