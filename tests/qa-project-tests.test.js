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
    it('a test importing an npm package the browser sandbox does not have (jsdom) cannot be passed, so it is not a failure; a missing relative module still is (kanbanflow set 2)', async () => {
        files['test_dark.js'] = "const { JSDOM } = require('jsdom');";
        W.executeToolAsync = async () => ({ stdout: "== test_dark.js (exit 1)\nError: Cannot find module 'jsdom'\nFAILED: test_dark.js\n", stderr: '', exit_code: 1 });
        const r = await W.transitionTask(TASK, 'done');
        expect(r.transitioned).toBe(true);
        expect(r.unverified.join(' ')).toMatch(/lacks.*jsdom/);
        const t2 = 'fg-tasks/010-rel.md'; files[t2] = task('010');
        W.executeToolAsync = async () => ({ stdout: "== test_dark.js (exit 1)\nError: Cannot find module './helpers.js'\nFAILED: test_dark.js\n", stderr: '', exit_code: 1 });
        expect((await W.transitionTask(t2, 'done')).transitioned).toBe(false);
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
    it('an error the page already reported when the task started is not the task\'s, even though the task edited the page; a new error still is (kanbanflow set 2, failchain)', async () => {
        const stamps = { 'index.html': 1 };
        files['index.html'] = '<p>x</p>';
        W.agentListFiles = async () => Object.keys(files).map(name => ({ name, lastModified: stamps[name] ?? 0 }));
        let errs = [{ text: 'TypeError: Failed to fetch https://api.example.invalid/v1 (line 12:3 of the inlined page)', count: 1 }];
        W.runPageCheck = async (p) => ({ path: p, loaded: true, summary: 'err', errors: errs });
        const t = 'fg-tasks/011-footer.md', u = 'fg-tasks/012-other.md'; files[t] = task('011'); files[u] = task('012');
        await W.transitionTask(t, 'in-progress');
        stamps['index.html'] = 2;   // the task added a footer to the page
        expect((await W.transitionTask(t, 'done')).transitioned).toBe(false);   // still told once
        const second = await W.transitionTask(t, 'done');
        expect(second.transitioned).toBe(true);
        expect(second.unverified.join(' ')).toMatch(/already there when the task started/);
        await W.transitionTask(u, 'in-progress');
        stamps['index.html'] = 3;
        errs = [{ text: 'ReferenceError: render is not defined (line 30:1 of the inlined page)', count: 1 }];   // an error the task caused
        expect((await W.transitionTask(u, 'done')).transitioned).toBe(false);
        expect((await W.transitionTask(u, 'done')).transitioned).toBe(false);
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

    it('names a command of a command-line tool that the task dropped', async () => {
        const T2 = 'fg-tasks/002-json-report.md', T3 = 'fg-tasks/003-argument-errors.md';
        const tool = (cmds) => cmds.map((c, i) => `    ${i ? 'elif' : 'if'} ${['command', 'mode', 'sys.argv[1]'][i % 3]} == "${c}":\n        pass`).join('\n') + (cmds.length ? '\nsub.add_parser("' + cmds[0] + '")' : '');
        Object.assign(files, { [T2]: done1.replace('Search box', 'JSON report').replace('Add a search input that filters the table.', 'The report command writes the summary as JSON.'), [T3]: t4('todo').replace('004', '003'), 'logtool.py': tool(['report', 'errors']) });
        delete files[TASK];
        W.loadTaskFiles = async () => Object.keys(files).filter(f => /^fg-tasks\/\d+-/.test(f)).map(f => ({ path: f, fm: { id: f.slice(9, 12), title: /title: (.*)/.exec(files[f])[1], status: /status: (.*)/.exec(files[f])[1] } }));
        await W.transitionTask(T3, 'in-progress');
        files['logtool.py'] = tool(['errors']);
        const r = await W.transitionTask(T3, 'done');
        expect(r.transitioned).toBe(false);
        expect(r.reason).toMatch(/report \(logtool\.py; task #002/);
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


// kanbanflow set 3 (datapipe, 2 of 2 runs): a task tested its code by writing sample rows to data/app.log, the input the tool is meant to process.
// 3 of 3 uploaded sessions: "task → done [gate test-runner] — running for 76.7 s when the app last responded": 12 heavy test files in one shell call took the tab down.
describe('test-runner gate scope', () => {
    const T = 'fg-tasks/007-physics.md';
    it('runs at most 6 tests, the ones that mention the changed file first, three to a shell call', async () => {
        let clock = 1;
        const stamp = {};
        W.agentListFiles = async () => Object.keys(files).map(name => ({ name, lastModified: stamp[name] ?? 0 }));
        files[T] = `---\nid: 007\ntitle: Physics\nstatus: todo\n---\n# Physics\n## Acceptance Criteria\n- [x] ok\n`;
        files['physics.js'] = 'export const g = 1;';
        for (const c of 'abcdefghij') files[`test_${c}.mjs`] = 'console.log(1)';
        files['test_z_physics.mjs'] = "import { g } from './physics.js'; console.log(g)";
        delete files[TASK];
        await W.transitionTask(T, 'in-progress');
        files['physics.js'] = 'export const g = 2;'; stamp['physics.js'] = ++clock;
        runs.length = 0;
        const r = await W.transitionTask(T, 'done');
        expect(r.transitioned).toBe(true);
        const cmds = runs.filter(c => /node '/.test(c));
        expect(cmds).toHaveLength(2);                                   // 6 files, three to a call
        expect(cmds[0]).toContain("node 'test_z_physics.mjs'");         // the related test first
        expect(cmds.join('\n').match(/node '/g)).toHaveLength(6);
    });
});

describe('the done gate after a gate crash', () => {
    const T = 'fg-tasks/150-x.md';
    it('does not run the tests again once the gate took the tab down in the last day; the task is accepted unverified', async () => {
        const now = Date.now();
        localStorage.setItem('fg_tool_crashes', JSON.stringify([{ calls: [{ name: 'task', label: 'task:149-y.md → done [gate test-runner]', t: now - 5000 }], beat: now }]));
        files['test_a.mjs'] = 'x'; delete files[TASK];
        files[T] = `---\nid: 150\ntitle: X\nstatus: todo\n---\n# X\n## Acceptance Criteria\n- [x] ok\n`;
        await W.transitionTask(T, 'in-progress');
        runs.length = 0;
        const r = await W.transitionTask(T, 'done');
        expect(r.transitioned).toBe(true);
        expect(runs.filter(c => /node '/.test(c))).toHaveLength(0);
        expect(r.unverified.join(' ')).toMatch(/test-runner/);
    });
    it('gives each test file 20 s, and a file that only timed out says nothing against the task', async () => {
        files['test_a.mjs'] = 'x'; delete files[TASK];
        files[T] = `---\nid: 150\ntitle: X\nstatus: todo\n---\n# X\n## Acceptance Criteria\n- [x] ok\n`;
        await W.transitionTask(T, 'in-progress');
        W.executeToolAsync = async (_n, a) => { runs.push(a.code); return { stdout: "== test_a.mjs (exit 124)\n\nFAILED: test_a.mjs", stderr: '', exit_code: 1 }; };
        runs.length = 0;
        const r = await W.transitionTask(T, 'done');
        expect(runs.join('\n')).toMatch(/timeout 20 node 'test_a\.mjs'/);
        expect(r.transitioned).toBe(true);
        expect(r.unverified.join(' ')).toMatch(/did not finish in 20 s/);
    });
});

describe('a done refused again and again', () => {
    const T = 'fg-tasks/120-ramp.md';
    const task = (n) => `---\nid: 120\ntitle: Ramp\nstatus: todo\nrework_count: ${n}\n---\n# Ramp\n## Acceptance Criteria\n- [x] ok\n`;
    it('is accepted as unverified for the sandbox-dependent checks once the rework limit is reached, never for the boxes', async () => {
        files['test_imports.mjs'] = 'x'; delete files[TASK];
        W.executeToolAsync = async () => ({ stdout: "== test_imports.mjs (exit 1)\nIMPORT FAILED: Error loading module '/workspace/src/main.js'\nFAILED: test_imports.mjs", stderr: '', exit_code: 1 });
        files[T] = task(0);
        await W.transitionTask(T, 'in-progress');
        files[T] = files[T].replace('status: in-progress', 'status: in-progress').replace(/rework_count: \d+/, 'rework_count: 3');
        files['src.js'] = 'changed';   // the project moved on since the first refusal, so the usual second-attempt acceptance does not apply
        const r = await W.transitionTask(T, 'done');
        expect(r.transitioned).toBe(true);
        expect(r.unverified.join(' ')).toMatch(/test-runner/);
        expect(files[T]).toMatch(/qa: unverified/);
        // an unticked box is still refused at the limit
        files[T] = task(3).replace('- [x] ok', '- [ ] ok').replace('status: todo', 'status: in-progress');
        const r2 = await W.transitionTask(T, 'done');
        expect(r2.transitioned).toBe(false);
        expect(r2.reason).toMatch(/completeness-check/);
    });
});

describe('completeness gate', () => {
    // kanbanflow set 3: one chat sent `done` 21 times with a box unticked; the message named the box but never the call that ticks it.
    it('names the call that ticks the first unticked box', async () => {
        const T = 'fg-tasks/014-readme.md';
        files[T] = `---\nid: 014\ntitle: README\nstatus: todo\n---\n# README\n## Acceptance Criteria\n- [x] done one\n- [ ] every function name appears in README.md\n`;
        delete files[TASK];
        await W.transitionTask(T, 'in-progress');
        const r = await W.transitionTask(T, 'done');
        expect(r.transitioned).toBe(false);
        expect(r.reason).toContain(JSON.stringify({ path: T, old_string: '- [ ] every function name appears in README.md', new_string: '- [x] every function name appears in README.md' }));
    });
});

describe('kept-data gate', () => {
    const T = 'fg-tasks/003-json-report.md';
    const task3 = (st) => `---\nid: 003\ntitle: JSON report\nstatus: ${st}\n---\n# JSON report\nWrite the report.\n`;
    beforeEach(() => { localStorage.setItem('fg_qa_test_runner', 'false'); });

    it('bounces a done that replaced an input data file, names what it held, and accepts the second attempt', async () => {
        Object.assign(files, { [T]: task3('todo'), 'data/app.log': 'real line 1\nreal line 2\n', 'package.json': '{"a":1}' });
        delete files[TASK];
        await W.transitionTask(T, 'in-progress');
        files['data/app.log'] = 'invented\n'; files['package.json'] = '{"a":2}'; files['out/report.json'] = '{}';
        const first = await W.transitionTask(T, 'done');
        expect(first.transitioned).toBe(false);
        expect(first.reason).toMatch(/changed data\/app\.log/);
        expect(first.reason).toMatch(/real line 1/);
        expect(first.reason).not.toMatch(/package\.json/);
        expect((await W.transitionTask(T, 'done')).transitioned).toBe(true);
    });

    it('says nothing when the data files are as they were or only new ones appeared', async () => {
        Object.assign(files, { [T]: task3('todo'), 'data/app.log': 'real\n' });
        delete files[TASK];
        await W.transitionTask(T, 'in-progress');
        files['out/report.json'] = '{}';
        expect((await W.transitionTask(T, 'done')).transitioned).toBe(true);
    });
});
