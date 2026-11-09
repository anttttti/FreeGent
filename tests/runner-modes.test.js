// runner-modes.test.js — the Tasks tab's two buttons share one engine (runner.ts):
//   Run       → complete the next task, then stop
//   Autopilot → keep completing tasks, one new chat per task, until none are left
const W = globalThis;
await import('../runner.ts');

const STUBBED = [
    'agentStreaming', 'activeChatId', 'refreshTasks', 'createNewChat', 'switchToChat', 'saveHistory',
    'setChatName', 'loadTaskFiles', 'agentReadFile', 'setTaskStatus', 'transitionTask', 'parseFrontmatter',
    'runAgentTurn', 'appendMessage', 'createResponsePlaceholder', 'getRunnerQa', 'getRunnerMaxConsecutiveFails',
    '_isRateLimit',
];
let saved, files, chats, names, turns;

function fm(c) {
    return Object.fromEntries((c.match(/^---\n([\s\S]*?)\n---/) ?? [, ''])[1].split('\n').filter(Boolean)
        .map(l => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}
const task = (id, title) => `---\nid: ${id}\ntitle: ${title}\nstatus: todo\n---\n\nBody.\n`;

beforeEach(() => {
    saved = Object.fromEntries(STUBBED.map(k => [k, W[k]]));
    document.body.innerHTML = '<div id="tab-bar"></div><button id="autopilot-btn"></button><button id="runner-run-btn"></button><span id="runner-status"></span><div id="runner-current-task"></div>';
    files = { 'fg-tasks/001-a.md': task('001', 'First'), 'fg-tasks/002-b.md': task('002', 'Second') };
    chats = 0; names = []; turns = [];
    W.agentStreaming = false;
    W.activeChatId = 'main';
    W.refreshTasks = async () => {};
    W.saveHistory = () => {};
    W.createNewChat = () => { W.activeChatId = `chat-${++chats}`; };
    W.switchToChat = async (id) => { W.activeChatId = id; };
    W.setChatName = (_id, n) => { names.push(n); };
    W.parseFrontmatter = fm;
    W.agentReadFile = async (p) => files[p];
    W.setTaskStatus = async (p, s) => { files[p] = files[p].replace(/^status: .*$/m, `status: ${s}`); };
    W.transitionTask = async (p, s) => { await W.setTaskStatus(p, s); return { transitioned: true }; };
    W.getRunnerQa = () => false;
    W.getRunnerMaxConsecutiveFails = () => 3;
    W._isRateLimit = () => false;
    W.appendMessage = () => {};
    W.createResponsePlaceholder = () => ({});
    W.loadTaskFiles = async () => Object.entries(files).map(([path, c]) => ({ path, fm: fm(c), lastLog: '' }));
    // The agent finishes whatever task its prompt names.
    W.runAgentTurn = async (prompt) => {
        const path = /File: (\S+)/.exec(prompt)?.[1];
        turns.push(path);
        await W.setTaskStatus(path, 'done');
        return { text: 'done', finishSignal: 'completed' };
    };
});
afterEach(async () => {
    if (W.isRunnerRunning()) W.runnerStop();
    await idle();
    for (const k of STUBBED) W[k] = saved[k];
});

async function idle() {
    for (let i = 0; i < 4000 && W.isRunnerRunning(); i++) await new Promise(r => setTimeout(r, 1));
    if (W.isRunnerRunning()) throw new Error('runner never went idle');
}

describe('Run', () => {
    it('completes only the next task', async () => {
        W.runnerStart();
        await idle();
        expect(turns).toEqual(['fg-tasks/001-a.md']);
        expect(files['fg-tasks/001-a.md']).toMatch(/^status: done$/m);
        expect(files['fg-tasks/002-b.md']).toMatch(/^status: todo$/m);
    });
});

describe('Autopilot', () => {
    it('keeps going until every task is done, one new named chat each', async () => {
        W.runnerAutopilot();
        await idle();
        expect(turns).toEqual(['fg-tasks/001-a.md', 'fg-tasks/002-b.md']);
        expect(Object.values(files).every(c => /^status: done$/m.test(c))).toBe(true);
        expect(chats).toBe(2);
        expect(names).toEqual(['#001 First', '#002 Second']);
    });

    it('adds nothing to the header tab bar', async () => {
        W.runnerAutopilot();
        await idle();
        expect(document.getElementById('tab-bar').children).toHaveLength(0);
    });

    it('hides the Autopilot button while running, and the one Stop button stops it', async () => {
        let release;
        W.runAgentTurn = (prompt) => new Promise(res => { release = () => res({ text: '', finishSignal: 'completed' }); turns.push(prompt); });
        document.body.insertAdjacentHTML('beforeend', '<button id="runner-stop-btn" style="display:none"></button>');
        W.runnerAutopilot();
        await new Promise(r => setTimeout(r, 10));
        const btn = document.getElementById('autopilot-btn');
        expect(btn.style.display).toBe('none');
        expect(btn.textContent).not.toMatch(/Stop/);
        expect(document.getElementById('runner-stop-btn').style.display).toBe('inline-block');   // the one Stop
        W.runnerStop();
        release?.();
        await idle();
        expect(btn.style.display).toBe('inline-block');
    });
});

describe('one job at a time', () => {
    it('Run refuses to start while another AI job is running', () => {
        W.setAiJob('init');
        try {
            W.runnerStart();
            expect(W.isRunnerRunning()).toBe(false);
            expect(document.getElementById('runner-status').textContent).toMatch(/Another AI task/);
        } finally { W.setAiJob(''); }
    });

    it('Autopilot waits for the busy job, says so, and cancels on a second press', () => {
        W.setAiJob('init');
        try {
            W.runnerAutopilot();
            expect(W.isRunnerRunning()).toBe(false);
            expect(document.getElementById('runner-status').textContent).toMatch(/start when the current chat finishes/);
            W.runnerAutopilot();
            expect(document.getElementById('runner-status').textContent).toMatch(/cancelled/);
        } finally { W.setAiJob(''); }
    });
});

describe('start gates and unblock (v0.62 review R14, R15)', () => {
    it('R14: a task the start gate refuses is not worked on and is skipped, not re-picked', async () => {
        W.getRunnerQa = () => true;
        const starts = [];
        W.transitionTask = async (p, s) => {
            if (s === 'in-progress') starts.push(p);
            if (p.includes('001') && s === 'in-progress') return { transitioned: false, reason: 'depends on 000' };
            await W.setTaskStatus(p, s);
            return { transitioned: true };
        };
        W.runnerAutopilot();
        await idle();
        expect(turns).toEqual(['fg-tasks/002-b.md']);
        expect(starts.filter(p => p.includes('001'))).toHaveLength(1);
        expect(files['fg-tasks/001-a.md']).toMatch(/^status: todo$/m);
    });

    // kanbanflow set 3: "BLOCKED: logtool.py is missing" for a task that says to write logtool.py stopped the board for the user in 5 of 8 runs.
    it('asks once whether a missing file is the task\'s to create before stopping for the user, and stops for any other question', async () => {
        const prompts = [];
        W.runAgentTurn = async (prompt) => {
            prompts.push(prompt);
            if (prompts.length === 1) return { text: 'BLOCKED: logtool.py is missing from the workspace.', finishSignal: 'blocked' };
            await W.setTaskStatus('fg-tasks/001-a.md', 'done');
            return { text: 'ok', finishSignal: 'completed' };
        };
        W.runnerStart();
        await idle();
        expect(prompts).toHaveLength(2);
        expect(prompts[1]).toMatch(/missing file.*yours to create/);
        expect(files['fg-tasks/001-a.md']).toMatch(/^status: done$/m);
        // the same question again, or a question that is not about a file, reaches the user
        prompts.length = 0; files['fg-tasks/001-a.md'] = files['fg-tasks/001-a.md'].replace('status: done', 'status: todo');
        W.runAgentTurn = async (prompt) => { prompts.push(prompt); return { text: prompts.length === 1 ? 'BLOCKED: file x is missing' : 'BLOCKED: file x is still missing', finishSignal: 'blocked' }; };
        W.runnerStart();
        await vi.waitFor(() => expect(prompts).toHaveLength(2));
        await new Promise(r => setTimeout(r, 30));
        expect(document.getElementById('runner-status').textContent).toMatch(/Paused/);
        W.runnerStop();
    });

    // kanbanflow set 3: 234 of 245 task chats were bounced once by the completeness check ("N unchecked steps") on their first done.
    it('tells the agent to tick the acceptance criteria before it sets done, only when the task has some', async () => {
        const prompts = [];
        W.runAgentTurn = async (prompt) => { prompts.push(prompt); const path = /File: (\S+)/.exec(prompt)[1]; await W.setTaskStatus(path, 'done'); return { text: 'done', finishSignal: 'completed' }; };
        files['fg-tasks/001-a.md'] = files['fg-tasks/001-a.md'].replace('Body.', '## Acceptance Criteria\n- [ ] it works\n');
        W.runnerAutopilot();
        await idle();
        expect(prompts[0]).toMatch(/Tick each acceptance criterion in the file/);
        expect(prompts[1]).not.toMatch(/Tick each acceptance criterion/);
    });

    it('R15: Run does not start a second task after a blocked task is resumed', async () => {
        let n = 0;
        W.runAgentTurn = async (prompt) => {
            turns.push(/File: (\S+)/.exec(prompt)?.[1] ?? 'follow-up');
            if (++n === 1) return { text: 'need input', finishSignal: 'blocked' };
            await W.setTaskStatus('fg-tasks/001-a.md', 'done');
            return { text: 'ok', finishSignal: 'completed' };
        };
        document.body.insertAdjacentHTML('beforeend', '<input id="runner-unblock-input">');
        W.runnerStart();
        await vi.waitFor(() => expect(turns).toHaveLength(1));
        await new Promise(r => setTimeout(r, 20));
        document.getElementById('runner-unblock-input').value = 'go ahead';
        W.runnerSendUnblock();
        await idle();
        expect(turns).toEqual(['fg-tasks/001-a.md', 'follow-up']);
        expect(files['fg-tasks/002-b.md']).toMatch(/^status: todo$/m);
    });
});

describe('a turn that stops at its step limit', () => {
    const limited = (reason = 'step budget exhausted') => ({
        text: `BLOCKED: ${reason}`, finishSignal: 'blocked', stop: { reason, edited: true },
    });

    it('is continued with a plain "Continue" turn until the task is done, not paused for the user', async () => {
        const prompts = [];
        W.runAgentTurn = async (prompt) => {
            prompts.push(prompt);
            if (prompts.length < 3) return limited();                       // two budgets spent
            await W.setTaskStatus('fg-tasks/001-a.md', 'done');            // the third finishes it
            return { text: 'done', finishSignal: 'completed' };
        };
        W.runnerStart();
        await idle();
        expect(prompts).toHaveLength(3);
        expect(prompts[0]).toMatch(/Process this task file completely/);
        expect(prompts.slice(1)).toEqual(['Continue', 'Continue']);
        expect(files['fg-tasks/001-a.md']).toMatch(/^status: done$/m);
    });

    it('does not use up the episode\'s five re-prompt turns', async () => {
        const prompts = [];
        W.runAgentTurn = async (prompt) => {
            prompts.push(prompt);
            if (prompts.length <= 8) return limited('role step cap (60 steps) reached');
            await W.setTaskStatus('fg-tasks/001-a.md', 'done');
            return { text: 'done', finishSignal: 'completed' };
        };
        W.runnerStart();
        await idle();
        expect(prompts).toHaveLength(9);
        expect(files['fg-tasks/001-a.md']).toMatch(/^status: done$/m);
    });

    it('still pauses for the user on a stop that is not the step limit', async () => {
        let n = 0;
        W.runAgentTurn = async () => { n++; return { text: 'BLOCKED: it kept repeating calls', finishSignal: 'blocked', stop: { reason: 'it kept repeating calls', edited: false } }; };
        W.runnerStart();
        await new Promise(r => setTimeout(r, 30));
        expect(n).toBe(1);                       // not continued
        W.runnerStop();
        await idle();
    });

    it('gives up after MAX_STEP_LIMIT_CONTINUES continuations and treats the stop as a block', async () => {
        const { MAX_STEP_LIMIT_CONTINUES } = await import('../runner.ts');
        let n = 0;
        W.runAgentTurn = async () => { n++; return limited(); };
        W.runnerStart();
        for (let i = 0; i < 3000 && n < MAX_STEP_LIMIT_CONTINUES + 1; i++) await new Promise(r => setTimeout(r, 1));
        await new Promise(r => setTimeout(r, 30));
        expect(n).toBe(MAX_STEP_LIMIT_CONTINUES + 1);
        W.runnerStop();
        await idle();
    });
});

// IndexedDB failing mid-run (live logs 2026-10-26, browser run 2026-10-27): the unreadable task list was read as empty and
// Autopilot ended with "All tasks complete" while tasks were still open; a one-second hiccup was enough.
describe('a steering message that finishes the task (codex R371)', () => {
    it('is not followed by another task prompt', async () => {
        const prompts = [];
        W.runAgentTurn = async (prompt) => {
            prompts.push(prompt);
            if (prompts.length === 1) {                                     // the task prompt: out of steps; the user steers meanwhile
                W.runnerSteer('just finish it');
                return { text: 'BLOCKED: step budget exhausted', finishSignal: 'blocked', stop: { reason: 'step budget exhausted', edited: true } };
            }
            await W.setTaskStatus('fg-tasks/001-a.md', 'done');            // the steering turn marks the task done
            return { text: 'done', finishSignal: 'completed' };
        };
        W.runnerStart();
        await idle();
        expect(prompts).toHaveLength(2);
        expect(prompts[1]).toBe('just finish it');
        expect(files['fg-tasks/001-a.md']).toMatch(/^status: done$/m);
    });
});

describe('task files that cannot be read', () => {
    const IDB = 'An internal error was encountered in the Indexed Database server';
    let retry, readable;
    beforeEach(async () => {
        readable = W.loadTaskFiles;
        ({ TASK_LOAD_RETRY_MS: retry } = await import('../runner.ts'));
        retry.splice(0, Infinity, 1, 1);
    });
    afterEach(() => { retry.splice(0, Infinity, 1000, 3000, 8000); });
    const failing = (times) => {
        let left = times; const calls = [];
        W.loadTaskFiles = async (opts) => { calls.push(opts); if (left-- > 0) throw new Error(IDB); return readable(opts); };
        return calls;
    };

    it('a short failure is retried and Autopilot goes on with the remaining tasks', async () => {
        let n = 0;
        const base = W.runAgentTurn;
        W.runAgentTurn = async (p) => { const r = await base(p); if (++n === 1) failing(2); return r; };   // storage fails after task 001
        W.runnerAutopilot();
        await idle();
        expect(turns).toEqual(['fg-tasks/001-a.md', 'fg-tasks/002-b.md']);
        expect(files['fg-tasks/002-b.md']).toMatch(/^status: done$/m);
    });

    it('reads the list strictly: a failure is not taken for "no tasks left"', async () => {
        const calls = failing(0);
        W.runnerStart();
        await idle();
        expect(calls[0]).toEqual({ strict: true });
    });

    it('a lasting failure pauses the run with the reason; Resume tries again and finishes the tasks', async () => {
        failing(Infinity);
        W.runnerAutopilot();
        const status = document.getElementById('runner-status');
        await vi.waitFor(() => expect(status.textContent).toMatch(/^Paused: Cannot read the task files \(.*Indexed Database server\)/));
        expect(W.isRunnerRunning()).toBe(true);
        expect(turns).toEqual([]);
        failing(0);                      // storage is back
        W.runnerResume();
        await idle();
        expect(turns).toEqual(['fg-tasks/001-a.md', 'fg-tasks/002-b.md']);
    });

    it('Stop while paused on the error ends the run', async () => {
        failing(Infinity);
        W.runnerAutopilot();
        await vi.waitFor(() => expect(document.getElementById('runner-status').textContent).toMatch(/Cannot read the task files/));
        W.runnerStop();
        await idle();
        expect(turns).toEqual([]);
    });
});

// Autopilot exploration 2026-10-27.
describe('what the run says when it ends or is interrupted', () => {
    const log = () => document.getElementById('runner-session-log').textContent;
    beforeEach(() => { document.body.insertAdjacentHTML('beforeend', '<div id="runner-session-log"></div>'); sessionStorage.clear(); });

    // AE-06: "All tasks complete ✓" with a task still waiting for the user.
    it('names the tasks it leaves blocked or failed instead of "All tasks complete"', async () => {
        files['fg-tasks/003-c.md'] = task('003', 'Needs a key').replace('status: todo', 'status: blocked');
        files['fg-tasks/004-d.md'] = task('004', 'Broken').replace('status: todo', 'status: failed');
        W.runnerAutopilot();
        await idle();
        expect(turns).toEqual(['fg-tasks/001-a.md', 'fg-tasks/002-b.md']);
        expect(log()).toMatch(/Finished: 1 blocked \(#003\): answer in the task's chat or edit it, then run it again; 1 failed \(#004\)/);
        expect(log()).not.toMatch(/All tasks complete/);
    });
    // kanbanflow set 2: task 003 needs 005 (a higher id). It was refused at its turn, deferred for the run, never retried, and the tasks behind it were
    // refused in turn until the run paused with "5 consecutive failures".
    it('starts a task only when its dependencies are done, whatever their ids, and finishes the whole chain', async () => {
        const dep = (id, title, d) => task(id, title).replace('status: todo', `status: todo\ndepends: ${d}`);
        files = { 'fg-tasks/001-a.md': task('001', 'A'), 'fg-tasks/002-b.md': dep('002', 'B', '005'), 'fg-tasks/003-c.md': dep('003', 'C', '002, 001'),
            'fg-tasks/004-d.md': task('004', 'D'), 'fg-tasks/005-e.md': dep('005', 'E', '004') };
        W.runnerAutopilot();
        await idle();
        expect(turns).toEqual(['fg-tasks/001-a.md', 'fg-tasks/004-d.md', 'fg-tasks/005-e.md', 'fg-tasks/002-b.md', 'fg-tasks/003-c.md']);
        expect(log()).toMatch(/All tasks complete/);
    });
    it('finds a dependency by its file number when its front matter lost the id line', async () => {
        const dep = (id, title, d) => task(id, title).replace('status: todo', `status: todo\ndepends: ${d}`);
        files = { 'fg-tasks/004-d.md': task('004', 'D').replace('status: todo', 'status: done').replace('id: 004\n', ''), 'fg-tasks/005-e.md': dep('005', 'E', '004') };
        W.runnerAutopilot();
        await idle();
        expect(turns).toEqual(['fg-tasks/005-e.md']);
    });
    it('names the tasks left waiting on a dependency that failed or does not exist', async () => {
        const dep = (id, title, d) => task(id, title).replace('status: todo', `status: todo\ndepends: ${d}`);
        files = { 'fg-tasks/001-a.md': task('001', 'A').replace('status: todo', 'status: failed'), 'fg-tasks/002-b.md': dep('002', 'B', '001'),
            'fg-tasks/003-c.md': dep('003', 'C', '099'), 'fg-tasks/004-d.md': task('004', 'D') };
        W.runnerAutopilot();
        await idle();
        expect(turns).toEqual(['fg-tasks/004-d.md']);
        expect(log()).toMatch(/2 waiting on a task that is not done \(#002 needs #001; #003 needs #099\)/);
        expect(log()).not.toMatch(/All tasks complete/);
    });
    it('does not call the run complete when a done task was accepted unverified', async () => {
        files['fg-tasks/003-c.md'] = task('003', 'Accepted').replace('status: todo', 'status: done\nqa: unverified');
        W.runnerAutopilot();
        await idle();
        expect(log()).toMatch(/All tasks done, 1 not verified \(#003\)/);
        expect(log()).not.toMatch(/All tasks complete/);
    });
    it('says there was nothing to run on an empty board instead of "All tasks complete"', async () => {
        for (const k of Object.keys(files)) delete files[k];
        W.runnerAutopilot();
        await idle();
        expect(log()).toMatch(/No tasks on the board to run/);
        expect(log()).not.toMatch(/All tasks complete/);
    });
    it('still says "All tasks complete" when nothing is left', async () => {
        W.runnerAutopilot();
        await idle();
        expect(log()).toMatch(/All tasks complete/);
    });

    // AE-03: a reload ended the run silently: Idle, the task in flight In Progress, the rest open.
    it('keeps what the run is doing in sessionStorage while it runs, and clears it when the run ends', async () => {
        let seen = null;
        const base = W.runAgentTurn;
        W.runAgentTurn = async (p) => { seen ??= JSON.parse(sessionStorage.getItem('fg_runner_active')); return base(p); };
        W.runnerAutopilot();
        await idle();
        expect(seen).toMatchObject({ all: true, task: '#001 First', paused: '' });
        expect(sessionStorage.getItem('fg_runner_active')).toBeNull();
    });
    // kanbanflow set 3 / uploaded sessions: the tab died inside a gate's test run three times in three sessions and the board stood still with tasks open.
    it('starts Autopilot again when the tab died inside a tool call, at most 3 times an hour, and not after a plain reload', async () => {
        const run = async () => {
            localStorage.removeItem('x');
            sessionStorage.setItem('fg_runner_active', JSON.stringify({ all: true, task: '#001 First', paused: '', t: Date.now() }));
            sessionStorage.setItem('fg_tools_running', JSON.stringify({ calls: [{ name: 'exec', label: 'exec(bash): node test_x.mjs', t: Date.now() }], chatId: null, runner: true, beat: Date.now() }));
            W.checkInterruptedRun();
            await new Promise(r => setTimeout(r, 1700));
            const started = turns.length > 0;
            if (W.isRunnerRunning()) W.runnerStop();
            await idle();
            return started;
        };
        localStorage.removeItem('fg_runner_autoresume');
        const prevTab = W.activateTab; W.activateTab = () => W.initRunner();   // the Tasks tab opening runs initRunner
        document.body.insertAdjacentHTML('beforeend', '<div id="runner-session-log"></div>');
        files['fg-tasks/001-a.md'] = files['fg-tasks/001-a.md'].replace('status: todo', 'status: in-progress');
        expect(await run()).toBe(true);
        expect(log()).toMatch(/the browser tab crashed in a tool call/);
        files['fg-tasks/001-a.md'] = files['fg-tasks/001-a.md'].replace('status: done', 'status: in-progress'); files['fg-tasks/002-b.md'] = files['fg-tasks/002-b.md'].replace('status: done', 'status: todo');
        turns.length = 0; expect(await run()).toBe(true);
        files['fg-tasks/001-a.md'] = files['fg-tasks/001-a.md'].replace('status: done', 'status: in-progress'); files['fg-tasks/002-b.md'] = files['fg-tasks/002-b.md'].replace('status: done', 'status: todo');
        turns.length = 0; expect(await run()).toBe(true);
        files['fg-tasks/001-a.md'] = files['fg-tasks/001-a.md'].replace('status: done', 'status: in-progress');
        turns.length = 0; expect(await run()).toBe(false);          // the fourth within the hour waits for the button
        // a user's reload: no tool call was running
        localStorage.removeItem('fg_runner_autoresume'); sessionStorage.removeItem('fg_tools_running'); turns.length = 0;
        sessionStorage.setItem('fg_runner_active', JSON.stringify({ all: true, task: '#001 First', paused: '', t: Date.now() }));
        W.checkInterruptedRun();
        await new Promise(r => setTimeout(r, 1700));
        expect(turns).toEqual([]);
        W.activateTab = prevTab;
    }, 20000);
    it('after a reload, the Tasks tab says the run was interrupted and how many tasks are open, and starts nothing', async () => {
        files['fg-tasks/001-a.md'] = files['fg-tasks/001-a.md'].replace('status: todo', 'status: in-progress');
        sessionStorage.setItem('fg_runner_active', JSON.stringify({ all: true, task: '#001 First', paused: '', t: Date.now() }));
        W.initRunner();
        const status = document.getElementById('runner-status');
        await vi.waitFor(() => expect(status.textContent).toBe('Interrupted by a reload: 2 tasks open. Press Autopilot to continue'));
        expect(log()).toMatch(/Autopilot was interrupted by a page reload while on #001 First/);
        expect(W.isRunnerRunning()).toBe(false);
        expect(turns).toEqual([]);
        expect(sessionStorage.getItem('fg_runner_active')).toBeNull();
        W.runnerAutopilot();                 // pressing Autopilot continues with the task left in progress
        await idle();
        expect(turns[0]).toBe('fg-tasks/001-a.md');
        expect(status.textContent).toBe('Idle');
    });

    // AE-02: started in Chat mode, the task chats had no file tools and the run paused on "write_file is disabled".
    it('switches to Cowork mode when started in Chat mode, and says so', async () => {
        W.setMode('chat');
        W.runnerAutopilot();
        await idle();
        expect(W.getMode()).toBe('cowork');
        expect(log()).toMatch(/Switched to Cowork mode/);
        W.setMode('chat');
    });
});
