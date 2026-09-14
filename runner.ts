// runner.ts — FreeGent: task runner — autonomous task loop
// Depends on: config.js, qa.js, tasks.js, chat-state.js, agent-core.js, state.js
import { setWorkflowMode, _clearHistory } from './state.js';
import { enabledTools } from './config.js';

interface Task {
    path: string;
    fm: Record<string, string>;
    lastLog: string;
}

interface EpisodeResult {
    success: boolean;
    blocked: boolean;
    blockedReason: string;
    failReason: string;
}

let _runnerRunning: boolean  = false;
let _runnerPaused: boolean   = false;
let _runnerAbort: boolean    = false;
let _runnerPauseReason: string    = '';
let _runnerUnblockResolve: ((value: string) => void) | null = null;
let _runnerSessionLog: { time: string; taskId: string; title: string; outcome: string; reason: string }[]     = [];
let _runnerConsecutiveFails: number = 0;
let _runnerPriorChatId: string | null    = null;

// ── Public API ─────────────────────────────────────────────────────────────

// Exposed so autopilot can refuse to start while this runner owns the task files.
// Both loops mutate the same fg-tasks/*.md frontmatter and ledger; running them
// concurrently interleaves status transitions and corrupts task state.
function isRunnerRunning(): boolean { return _runnerRunning; }

function runnerStart() {
    if (_runnerRunning || agentStreaming) return;
    if (typeof isAutopilotRunning === 'function' && isAutopilotRunning()) {
        const statusEl = document.getElementById('runner-status');
        if (statusEl) statusEl.textContent = 'Autopilot is running — stop it first (Tasks tab)';
        return;
    }
    _runnerPriorChatId = activeChatId;
    _runnerSessionLog  = [];
    _renderRunnerLog();
    _runLoop().catch(console.error);
}

function runnerPause() {
    if (!_runnerRunning || _runnerPaused) return;
    _runnerPaused      = true;
    _runnerPauseReason = 'User paused';
    _updateRunnerUI();
}

function runnerResume() {
    if (!_runnerPaused) return;
    _runnerPaused      = false;
    _runnerPauseReason = '';
    if (_runnerUnblockResolve) {
        _runnerUnblockResolve('');
        _runnerUnblockResolve = null;
    }
    _updateRunnerUI();
}

function _clearRunnerProcess(showEmpty: boolean = true): void {
    const el = document.getElementById('runner-process');
    if (el) el.innerHTML = showEmpty ? '<div class="runner-process-empty">No active process.</div>' : '';
}

function runnerStop() {
    _runnerAbort  = true;
    _runnerPaused = false;
    if (_runnerUnblockResolve) {
        _runnerUnblockResolve('');
        _runnerUnblockResolve = null;
    }
}

// Toggle: stop if running, start if idle.
function runnerToggle() {
    if (_runnerRunning) {
        runnerStop();
        if (typeof agentStreaming !== 'undefined' && agentStreaming) stopNow?.();
    } else {
        runnerStart();
    }
}

function runnerRestart() {
    if (_runnerRunning) {
        runnerStop();
        const poll = setInterval(() => {
            if (!_runnerRunning) { clearInterval(poll); runnerStart(); }
        }, 100);
    } else {
        runnerStart();
    }
}

// ── Loop core ──────────────────────────────────────────────────────────────

async function _runLoop() {
    _runnerRunning       = true;
    _runnerPaused        = false;
    _runnerAbort         = false;
    _runnerConsecutiveFails = 0;
    _updateRunnerUI();

    try {
        while (!_runnerAbort) {
            await _waitWhilePaused();
            if (_runnerAbort) break;

            const tasks = await loadTaskFiles();
            refreshTasks?.();   // keep kanban in sync with task-file state

            const task = _selectNextTask(tasks);
            if (!task) {
                _appendRunnerLog(null, 'All tasks complete', 'info', '');
                break;
            }

            _updateRunnerCurrentTask(task);
            const result = await _runEpisode(task);
            if (_runnerAbort) break;

            _runnerSessionLog.push({
                time:    new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
                taskId:  task.fm.id    || '',
                title:   task.fm.title || task.path,
                outcome: result.success ? 'done' : 'failed',
                reason:  result.blockedReason || result.failReason || '',
            });
            _renderRunnerLog();

            if (result.blocked) {
                _runnerPaused      = true;
                _runnerPauseReason = result.blockedReason || 'Worker blocked — needs input';
                const userReply = await _waitForUnblock();
                if (_runnerAbort) break;
                if (userReply) {
                    await runAgentTurn(userReply, document.getElementById('runner-process'));
                }
                _runnerConsecutiveFails = 0;
                continue;
            }

            if (result.success) {
                _runnerConsecutiveFails = 0;
            } else {
                _runnerConsecutiveFails++;
                const maxFails = getRunnerMaxConsecutiveFails();
                if (_runnerConsecutiveFails >= maxFails) {
                    _runnerPaused      = true;
                    _runnerPauseReason = `${maxFails} consecutive failures — review tasks before continuing`;
                    await _waitForUnblock();
                    _runnerConsecutiveFails = 0;
                    if (_runnerAbort) break;
                }
            }

            await refreshTasks();
        }
    } finally {
        _runnerRunning = false;
        _runnerPaused  = false;
        _runnerAbort   = false;
        _clearRunnerProcess();
        _updateRunnerCurrentTask(null);
        _updateRunnerUI();
        if (_runnerPriorChatId) switchToChat(_runnerPriorChatId).catch(() => {});
    }
}

function _selectNextTask(tasks: Task[]): Task | null {
    const groups = [
        ['in-review', 'review'],
        ['in-progress'],
        ['todo', 'open'],
    ];
    for (const group of groups) {
        const matched = tasks.filter(t => group.includes((t.fm.status || 'todo').toLowerCase()));
        if (matched.length) {
            matched.sort((a, b) => parseInt(a.fm.id || '9999', 10) - parseInt(b.fm.id || '9999', 10));
            return matched[0];
        }
    }
    return null;
}

// ── Task execution ─────────────────────────────────────────────────────────

const _MAX_TURNS_PER_EPISODE = 5;

async function _runEpisode(task: Task): Promise<EpisodeResult> {
    if (agentStreaming) return { success: false, blocked: false, blockedReason: '', failReason: 'Already streaming' };

    createNewChat();
    _clearRunnerProcess(false);
    _clearHistory();

    // Activate the director role for the main agent — injects Kanban instructions into the
    // system prompt without polluting general chat sessions.
    if (typeof setMainAgentRole === 'function') setMainAgentRole('director');
    if (typeof setWorkflowMode === 'function') setWorkflowMode(true);

    // update_task_status is opt-in (off by default) but the runner always needs it.
    // Temporarily add it to enabledTools so it appears in the LLM's tool spec; restore on exit.
    const _addedTaskTool = !enabledTools.has('update_task_status');
    if (_addedTaskTool) enabledTools.add('update_task_status');

    // Read task content before mutating the status field so the agent sees the original status.
    let _initialTaskContent: string = '';
    try { _initialTaskContent = await agentReadFile(task.path); } catch {}

    // Mark in-progress so the board shows the task is running.
    // If the runner crashes before the cleanup block runs, the task stays in-progress
    // and will be retried on the next runner start — preferable to a silent stuck state.
    await setTaskStatus(task.path, 'in-progress');
    await refreshTasks();

    let success: boolean       = false;
    let blocked: boolean       = false;
    let blockedReason: string = '';
    let failReason: string    = '';
    let turn: number          = 0;

    while (_runnerRunning && !_runnerAbort && !blocked && turn < _MAX_TURNS_PER_EPISODE) {
        turn++;
        await _waitWhilePaused();
        if (_runnerAbort) break;

        // Turn 1: use the pre-read content (original status, before we set in-progress).
        // Subsequent turns: re-read so the agent sees what it wrote in the previous turn.
        const taskContent = turn === 1 ? _initialTaskContent
            : await agentReadFile(task.path).catch(() => _initialTaskContent);

        const taskName = task.fm.title || task.path;
        const prompt = turn === 1
            ? `Process this task file completely.\n\nFile: ${task.path}\n\n${taskContent}\n\nWhen done, call update_task_status("${task.path}", "done", "<one-line summary>").\nIf impossible, call update_task_status("${task.path}", "failed", "<reason>").`
            : `The task "${taskName}" (${task.path}) is not yet marked as done. Do NOT describe what needs to be done — call the tool now. Call update_task_status("${task.path}", "done", "<summary>") immediately, or update_task_status("${task.path}", "failed", "<reason>") if it cannot be done. No text response — tool call only.`;

        const _lastResult: any = await runAgentTurn(prompt, document.getElementById('runner-process'));
        const lastMsg: string = typeof _lastResult === 'string' ? _lastResult : (_lastResult?.text ?? '');

        if (!_runnerRunning || _runnerAbort) break;

        if (/STATUS:\s*blocked/i.test(lastMsg)) {
            const m = lastMsg.match(/STATUS:\s*blocked[:\s-]+([^\n]+)/i);
            blocked       = true;
            blockedReason = m ? m[1].trim().slice(0, 200) : 'Task blocked — needs user input';
            break;
        }

        if (_isRateLimit(lastMsg) && _switchToFreeModel()) {
            _clearHistory();
            continue;
        }

        try {
            const content = await agentReadFile(task.path);
            const fm = parseFrontmatter(content);
            const s  = (fm.status || '').toLowerCase();
            if (s === 'done' || s === 'completed')    { success    = true;                          break; }
            if (s === 'failed' || s === 'impossible') { failReason = 'Task marked failed/impossible'; break; }
        } catch {}
    }

    if (!success && !blocked && !failReason && turn >= _MAX_TURNS_PER_EPISODE) {
        // One replan attempt before giving up
        let taskContent: string = '';
        try { taskContent = await agentReadFile(task.path); } catch {}
        const replanPrompt =
            `You have used ${turn} turns on "${task.fm.title || task.path}" without marking it done. ` +
            `Briefly assess what is blocking completion, then complete the remaining work in a single focused action. ` +
            `Call update_task_status("${task.path}", "done", "<summary>") when finished, or ` +
            `update_task_status("${task.path}", "failed", "<reason>") if it cannot be done.\n\n` +
            `Current task file:\n${taskContent.slice(0, 1200)}`;
        await runAgentTurn(replanPrompt, document.getElementById('runner-process'));
        try {
            const content = await agentReadFile(task.path);
            const fm = parseFrontmatter(content);
            const s  = (fm.status || '').toLowerCase();
            if (s === 'done' || s === 'completed')    success    = true;
            else if (s === 'failed' || s === 'impossible') failReason = 'Task marked failed/impossible after replan';
            else failReason = 'Max turns reached without completion';
        } catch { failReason = 'Max turns reached without completion'; }
    }

    if (success && !_runnerAbort && getRunnerQa()) {
        await setTaskStatus(task.path, 'in-progress');
        const r1 = await transitionTask(task.path, 'in-review');
        if (r1.transitioned) {
            const r2 = await transitionTask(task.path, 'done');
            success    = r2.transitioned;
            if (!success) {
                failReason = r2.reason || 'QA blocked at done gate';
            }
        } else {
            success    = false;
            failReason = r1.reason || 'QA blocked at in-review gate';
        }
    }

    // Ensure task file always ends in a terminal status — catches all exit paths
    // (max turns, STATUS:blocked text signal, QA gate, narration-without-action).
    if (!_runnerAbort) {
        try {
            const content = await agentReadFile(task.path);
            const fm = parseFrontmatter(content);
            const s  = (fm.status || '').toLowerCase();
            const terminal = ['done', 'completed', 'failed', 'impossible', 'blocked'];
            if (!terminal.includes(s)) {
                // Agent didn't reach a terminal status — set one now.
                await setTaskStatus(task.path, success ? 'done' : 'blocked');
            }
            // Always append a runner note when the task ends non-successfully so there
            // is always an audit trail — even when the agent already called
            // update_task_status('blocked') and the status was already terminal above.
            if (!success) {
                const updated = await agentReadFile(task.path);
                const date    = new Date().toISOString().slice(0, 10);
                const note    = failReason || blockedReason || 'runner ended without completion';
                await agentWriteFile(task.path, updated.trimEnd() + `\n### ${date} — runner: ${note}\n`);
            }
        } catch {}
    }

    // Restore Director role for any follow-up (e.g. post-task chat).
    if (typeof clearMainAgentRole === 'function') clearMainAgentRole();

    // Restore update_task_status to its prior state.
    if (_addedTaskTool) enabledTools.delete('update_task_status');

    return { success, blocked, blockedReason, failReason };
}

// ── Pause helpers ──────────────────────────────────────────────────────────

async function _waitWhilePaused(): Promise<void> {
    while (_runnerPaused && !_runnerAbort) {
        await new Promise(r => setTimeout(r, 300));
    }
}

function _waitForUnblock(): Promise<string> {
    _updateRunnerUI();
    return new Promise<string>(resolve => { _runnerUnblockResolve = resolve; });
}

function runnerSendUnblock() {
    const inp = document.getElementById('runner-unblock-input') as HTMLInputElement | null;
    const val = inp ? inp.value.trim() : '';
    if (inp) inp.value = '';
    _runnerPaused      = false;
    _runnerPauseReason = '';
    if (_runnerUnblockResolve) {
        _runnerUnblockResolve(val);
        _runnerUnblockResolve = null;
    }
    _updateRunnerUI();
}

async function runnerInterrupt() {
    const inp = document.getElementById('runner-interrupt-input') as HTMLInputElement | null;
    const val = inp ? inp.value.trim() : '';
    if (inp) inp.value = '';
    if (!val) return;

    setSoftStopPending(true);
    activeAbortController?.abort();
    await runAgentTurn(val, document.getElementById('runner-process'));
}

// ── UI ─────────────────────────────────────────────────────────────────────

function _updateRunnerUI() {
    const runBtn      = document.getElementById('runner-run-btn');
    const pauseBtn    = document.getElementById('runner-pause-btn');
    const resumeBtn   = document.getElementById('runner-resume-btn');
    const restartBtn  = document.getElementById('runner-restart-btn');
    const stopBtn     = document.getElementById('runner-stop-btn');
    const statusEl    = document.getElementById('runner-status');
    const inputBar    = document.getElementById('runner-input-bar');
    const interruptBar = document.getElementById('runner-interrupt-bar');
    const chatSend    = document.getElementById('agent-action-btn') as HTMLButtonElement | null;

    const idle    = !_runnerRunning;
    const running = _runnerRunning && !_runnerPaused;
    const paused  = _runnerRunning && _runnerPaused;

    if (runBtn)      runBtn.style.display      = idle    ? 'inline-block' : 'none';
    if (pauseBtn)    pauseBtn.style.display    = running  ? 'inline-block' : 'none';
    if (resumeBtn)   resumeBtn.style.display   = paused   ? 'inline-block' : 'none';
    if (restartBtn)  restartBtn.style.display  = _runnerRunning ? 'inline-block' : 'none';
    if (stopBtn)     stopBtn.style.display     = _runnerRunning ? 'inline-block' : 'none';
    if (inputBar)    inputBar.style.display    = paused   ? 'flex' : 'none';
    if (interruptBar) interruptBar.style.display = running ? 'flex' : 'none';
    if (chatSend)    chatSend.disabled         = _runnerRunning;

    if (statusEl) {
        if (idle)         statusEl.textContent = 'Idle';
        else if (paused)  statusEl.textContent = `Paused: ${_runnerPauseReason}`;
        else              statusEl.textContent = 'Running…';
    }

    // Auto-expand runner zone when loop becomes active; don't auto-collapse on idle
    // so the session log stays visible after a run.
    if (_runnerRunning) toggleRunnerZone(true);
}

function _updateRunnerCurrentTask(task: Task | null): void {
    const el = document.getElementById('runner-current-task');
    if (!el) return;
    if (!task) { el.textContent = '—'; return; }
    const id = task.fm.id ? `#${task.fm.id} ` : '';
    el.textContent = `${id}${task.fm.title || task.path}`;
}

function _renderRunnerLog() {
    const el = document.getElementById('runner-session-log');
    if (!el) return;
    if (!_runnerSessionLog.length) {
        el.innerHTML = '<span class="runner-log-empty">No tasks completed this session.</span>';
        return;
    }
    el.innerHTML = _runnerSessionLog.slice().reverse().map(e => {
        const icon = e.outcome === 'done' ? '&#10003;' : e.outcome === 'info' ? '&#9679;' : '&#10007;';
        const cls  = e.outcome === 'done' ? 'runner-log-done' : e.outcome === 'info' ? 'runner-log-info' : 'runner-log-fail';
        const id   = e.taskId ? `#${e.taskId} ` : '';
        const rsn  = e.reason ? ` <span class="runner-log-reason">— ${e.reason}</span>` : '';
        return `<div class="runner-log-entry ${cls}"><span class="runner-log-icon">${icon}</span> <span class="runner-log-time">${e.time}</span> <span class="runner-log-title">${id}${e.title}</span>${rsn}</div>`;
    }).join('');
}

function _appendRunnerLog(taskId: string | null, title: string, outcome: string, reason: string): void {
    _runnerSessionLog.push({
        time:    new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        taskId:  taskId || '',
        title:   title  || '',
        outcome,
        reason:  reason || '',
    });
    _renderRunnerLog();
}

function toggleRunnerZone(forceExpand?: boolean): void {
    const zone = document.getElementById('runner-zone');
    const btn  = document.getElementById('runner-zone-toggle');
    if (!zone) return;
    const collapsed = forceExpand === true ? false
                    : forceExpand === false ? true
                    : zone.classList.contains('collapsed');
    zone.classList.toggle('collapsed', !collapsed);
    if (btn) btn.innerHTML = collapsed ? '&#9650;' : '&#9660;';
}

function initRunner() {
    _updateRunnerUI();
    _renderRunnerLog();
}

// Window bridge for classic scripts and inline handlers (ESM migration).
Object.assign(window, { runnerStart, runnerPause, runnerResume, runnerStop, runnerToggle, runnerRestart, runnerSendUnblock, runnerInterrupt, initRunner, isRunnerRunning, toggleRunnerZone });
