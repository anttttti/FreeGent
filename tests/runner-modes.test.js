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
    it('refuses to start while another AI job is running', () => {
        W.setAiJob('init');
        try {
            W.runnerAutopilot();
            expect(W.isRunnerRunning()).toBe(false);
            expect(document.getElementById('runner-status').textContent).toMatch(/Another AI task/);
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
