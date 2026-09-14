// autopilot.test.js — covers the autopilot task runner (autopilot.ts).
//
// Autopilot had no UI entry point for a long stretch and no test coverage at all, so it
// went dormant without anyone noticing (docs/dead-code-audit-2026-07-25.md §2.1). These
// tests exercise both execution modes end to end with the agent stubbed out, so a repeat
// regression fails here instead of silently.

const W = globalThis;

// autopilot.ts and runner.ts are browser-only UI modules and are deliberately not in
// tests/setup.js — import them here so only this file pays for their window bridges.
await import('../autopilot.ts');
await import('../runner.ts');

// Snapshot every global these tests stub so each test starts from the real implementation.
const STUBBED = [
    'agentStreaming', 'activeChatId', 'syncLedgerWithTaskFiles', 'refreshTasks',
    'createNewChat', 'switchToChat', 'activateTab', 'getAgentPlanMode', 'getAgentLedger',
    'getAgentMaxReplans', 'autoResizeTextarea', '_setInputText', '_isRateLimit',
    'getMessagesEl', 'agentReadFile', 'agentWriteFile', 'parseFrontmatter',
    'setTaskStatus', 'transitionTask', 'agentSend', 'loadTaskFiles', 'listWorkspaceFiles',
];
let saved;

beforeEach(() => {
    saved = Object.fromEntries(STUBBED.map(k => [k, W[k]]));
    document.body.innerHTML = '<div id="tab-bar"></div><div id="agent-input"></div>';
    W.agentStreaming = false;
    W.activeChatId = null;
});

afterEach(() => {
    if (W.isAutopilotRunning?.()) W.stopAutopilot();
    for (const k of STUBBED) W[k] = saved[k];
});

// toggleAutopilot() is an onclick handler: it fires startAutopilot() without returning
// the promise, so poll for idle rather than awaiting.
async function runToIdle() {
    W.toggleAutopilot();
    for (let i = 0; i < 4000 && W.isAutopilotRunning(); i++)
        await new Promise(r => setTimeout(r, 1));
    if (W.isAutopilotRunning()) throw new Error('autopilot loop never went idle');
}

function parseFm(c) {
    return Object.fromEntries(
        (c.match(/^---\n([\s\S]*?)\n---/) ?? [, ''])[1]
            .split('\n').filter(Boolean).map(l => {
                const i = l.indexOf(':');
                return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
            }));
}

describe('autopilot — wiring', () => {
    it('exposes the bridges the Tasks tab and agent-loop depend on', () => {
        expect(typeof W.toggleAutopilot).toBe('function');
        expect(typeof W.stopAutopilot).toBe('function');
        expect(typeof W.isAutopilotRunning).toBe('function');
        // _clearHistory moved to state.ts in audit §4.2 (autopilot.ts used to own it while
        // the live agent-loop depended on it). Still bridged for autopilot's free-variable use.
        expect(typeof W._clearHistory).toBe('function');
        expect(W.isAutopilotRunning()).toBe(false);
    });

    it('refuses to start while the Agent-tab loop owns the task files', () => {
        const real = W.isRunnerRunning;
        W.isRunnerRunning = () => true;
        try {
            W.toggleAutopilot();
            expect(W.isAutopilotRunning()).toBe(false);
        } finally { W.isRunnerRunning = real; }
    });

    it('blocks the Agent-tab loop while autopilot is running, and says why', () => {
        const real = W.isAutopilotRunning;
        W.isAutopilotRunning = () => true;
        document.body.insertAdjacentHTML('beforeend', '<div id="runner-status"></div>');
        try {
            W.runnerStart();
            expect(W.isRunnerRunning()).toBe(false);
            expect(document.getElementById('runner-status').textContent)
                .toMatch(/Autopilot is running/);
        } finally { W.isAutopilotRunning = real; }
    });
});

describe('autopilot — direct execution', () => {
    let taskFile, prompts, transitions, served;

    beforeEach(() => {
        taskFile = '---\nid: 001\nstatus: todo\ntitle: Demo task\n---\n\nDo the thing.\n';
        prompts = [];
        transitions = [];
        served = false;

        W.syncLedgerWithTaskFiles = async () => {};
        W.refreshTasks = async () => {};
        W.createNewChat = () => { W.activeChatId = 'chat-1'; };
        W.switchToChat = async () => {};
        W.activateTab = () => {};
        W.getAgentPlanMode = () => false;
        W.autoResizeTextarea = () => {};
        W._setInputText = (el, t) => { el.innerText = t; };
        W._isRateLimit = () => false;
        W.getMessagesEl = () => document.body;
        W.parseFrontmatter = parseFm;
        W.agentReadFile = async () => taskFile;
        W.agentWriteFile = async (_p, c) => { taskFile = c; };
        W.setTaskStatus = async (_p, s) => {
            taskFile = taskFile.replace(/^status: .*$/m, `status: ${s}`);
        };
        W.transitionTask = async (p, s) => {
            transitions.push(s); await W.setTaskStatus(p, s); return { transitioned: true };
        };
        W.agentSend = async () => {
            prompts.push(document.getElementById('agent-input').innerText);
            await W.setTaskStatus('tasks/001.md', 'done');
        };
        W.loadTaskFiles = async () => {
            if (served) return [];
            served = true;
            return [{ path: 'tasks/001.md', fm: parseFm(taskFile) }];
        };
    });

    it('takes a todo task through the QA gates to done', async () => {
        await runToIdle();
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain('tasks/001.md');
        expect(transitions).toEqual(['in-progress', 'in-review', 'done']);
        expect(taskFile).toMatch(/^status: done$/m);
    });

    it('marks the task tab done and does not accumulate tabs across runs', async () => {
        const bar = document.getElementById('tab-bar');
        await runToIdle();
        expect(bar.querySelectorAll('.task-auto-tab')).toHaveLength(1);
        expect(bar.querySelector('.task-auto-done')).toBeTruthy();

        // Rerun: stale tabs from the previous run must be cleared, not appended to.
        served = false;
        taskFile = taskFile.replace(/^status: done$/m, 'status: todo');
        await runToIdle();
        expect(bar.querySelectorAll('.task-auto-tab')).toHaveLength(1);
    });

    it('holds the task at in-review when the QA gate refuses', async () => {
        W.transitionTask = async (p, s) => {
            transitions.push(s);
            if (s === 'done') return { transitioned: false, reason: 'gate refused' };
            await W.setTaskStatus(p, s);
            return { transitioned: true };
        };
        await runToIdle();
        expect(transitions).toContain('in-review');
        expect(taskFile).toMatch(/^status: failed$/m);
        expect(taskFile).toMatch(/autopilot gave up/);
    });
});

describe('autopilot — plan-then-execute', () => {
    // The distinguishing feature vs runner.ts: a checkbox plan file plus a history
    // reset between steps, so each step runs on a minimal focused context.
    let files, prompts, historyAtStep, served, step;

    beforeEach(() => {
        files = new Map([
            ['tasks/002.md', '---\nid: 002\nstatus: todo\ntitle: Planned task\n---\n\nBuild it.\n'],
        ]);
        prompts = [];
        historyAtStep = [];
        served = false;
        step = 0;

        const msgs = document.createElement('div');
        document.body.appendChild(msgs);

        W.syncLedgerWithTaskFiles = async () => {};
        W.refreshTasks = async () => {};
        W.createNewChat = () => { W.activeChatId = 'chat-2'; };
        W.switchToChat = async () => {};
        W.activateTab = () => {};
        W.getAgentPlanMode = () => true;
        W.getAgentLedger = () => true;
        W.getAgentMaxReplans = () => 2;
        W.autoResizeTextarea = () => {};
        W._setInputText = (el, t) => { el.innerText = t; };
        W._isRateLimit = () => false;
        W.getMessagesEl = () => msgs;
        W.parseFrontmatter = parseFm;
        W.listWorkspaceFiles = async () => [...files.keys()].map(name => ({ name }));
        W.agentReadFile = async (p) => {
            if (!files.has(p)) throw new Error(`not found: ${p}`);
            return files.get(p);
        };
        W.agentWriteFile = async (p, c) => { files.set(p, c); };
        W.setTaskStatus = async (p, s) => {
            files.set(p, files.get(p).replace(/^status: .*$/m, `status: ${s}`));
        };
        W.transitionTask = async (p, s) => { await W.setTaskStatus(p, s); return { transitioned: true }; };


        W.agentSend = async () => {
            const p = document.getElementById('agent-input').innerText;
            prompts.push(p);
            if (p.includes('write a concise step-by-step plan')) {
                files.set('tasks/002.plan.md', '- [ ] first step\n- [ ] second step\n');
            } else if (p.startsWith('Execute step')) {
                // Record whether the previous step's marker survived into this step. If
                // history was cleared between steps it is gone. This asserts the observable
                // effect rather than hooking setOpenaiHistory — which stopped working when
                // _clearHistory moved into state.ts and began calling it module-locally.
                historyAtStep.push(W.openaiHistory.some(m => m?.content === '__marker__'));
                W.openaiHistory.push({ role: 'assistant', content: '__marker__' });
                step++;
                files.set('tasks/002.plan.md', step === 1
                    ? '- [x] first step\n- [ ] second step\n'
                    : '- [x] first step\n- [x] second step\n');
                // Substantive output so _shouldReplan() does not fire on "no output".
                msgs.innerHTML = '<div class="agent-msg-model">Wrote the code and called write_file.</div>';
            } else if (p.includes('Update `tasks/002.md` frontmatter status')) {
                await W.setTaskStatus('tasks/002.md', 'done');
            }
        };
        W.loadTaskFiles = async () => {
            if (served) return [];
            served = true;
            return [{ path: 'tasks/002.md', fm: parseFm(files.get('tasks/002.md')) }];
        };
    });

    it('plans first without executing, then runs each step', async () => {
        await runToIdle();
        expect(files.has('tasks/002.plan.md')).toBe(true);
        expect(prompts[0]).toContain('Do NOT execute anything yet');
        const steps = prompts.filter(p => p.startsWith('Execute step'));
        expect(steps).toHaveLength(2);
        expect(steps[0]).toContain('step 1 of 2');
        expect(steps[1]).toContain('step 2 of 2');
        expect(files.get('tasks/002.md')).toMatch(/^status: done$/m);
    });

    it('clears history between steps — the point of plan mode', async () => {
        await runToIdle();
        expect(historyAtStep.length).toBe(2);
        // No step ever sees the previous step's leftover history.
        expect(historyAtStep).toEqual([false, false]);
    });

    it('writes a ledger and references it from each step prompt', async () => {
        await runToIdle();
        const ledger = [...files.keys()].find(k => k.startsWith('tasks/ledger-'));
        expect(ledger).toBeTruthy();
        expect(files.get(ledger)).toMatch(/### Step 1/);
        expect(files.get(ledger)).toMatch(/### Step 2/);
        expect(prompts.filter(p => p.startsWith('Execute step'))[1]).toContain('tasks/ledger-');
    });

    it('resumes from the first unchecked box instead of replanning', async () => {
        files.set('tasks/002.plan.md', '- [x] first step\n- [ ] second step\n');
        await runToIdle();
        expect(prompts.some(p => p.includes('write a concise step-by-step plan'))).toBe(false);
        const steps = prompts.filter(p => p.startsWith('Execute step'));
        expect(steps).toHaveLength(1);
        expect(steps[0]).toContain('step 2 of 2');
    });
});
