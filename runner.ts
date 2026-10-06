// runner.ts — FreeGent: task runner — autonomous task loop
// Depends on: config.js, qa.js, tasks.js, chat-state.js, agent-core.js, state.js
import { setWorkflowMode, _clearHistory, aiJob, setAiJob, aiBusy } from './state.js';
import { enabledTools, coworkEnabledTools } from './config.js';
import { canonTaskStatus } from './task-status.js';

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
// true = Autopilot (keep taking the next task until none are left); false = Run (one task).
let _runnerAll: boolean      = false;
let _runnerPaused: boolean   = false;
let _runnerAbort: boolean    = false;
let _runnerPauseReason: string    = '';
let _runnerUnblockResolve: ((value: string) => void) | null = null;
let _runnerSessionLog: { time: string; taskId: string; title: string; outcome: string; reason: string }[]     = [];
let _runnerConsecutiveFails: number = 0;
let _runnerPriorChatId: string | null    = null;
let _runnerChatId: string | null         = null;
// Set by a card's play button: the loop works on this one task only.
let _runnerOnlyPath: string | null       = null;
const _runnerPendingSteer: string[]      = [];

// ── Public API ─────────────────────────────────────────────────────────────

function isRunnerRunning(): boolean { return _runnerRunning; }
function getRunnerChatId(): string | null { return _runnerChatId; }
export function _setRunnerChatIdForTest(id: string | null): void { _runnerChatId = id; }

// One agent turn in the runner's chat, rendered into the chat view so opening the task's
// chat tab shows the prompt and the live steps. runAgentTurn alone would pick the NULL
// render adapter (workflowMode is on), leaving the tab blank.
async function _runnerTurn(prompt: string): Promise<any> {
    if (_runnerChatId && activeChatId !== _runnerChatId) await switchToChat(_runnerChatId);
    appendMessage('user', renderMarkdown ? renderMarkdown(prompt) : esc(prompt).replace(/\n/g, '<br>'));
    return runAgentTurn(prompt, null, undefined, { placeholder: createResponsePlaceholder() });
}

// Run: try to complete the next task, then stop.
// Tasks whose start gate refused them this session (blocked dependency, rework limit): skipped by
// _selectNextTask so Autopilot moves on instead of picking the same task again.
const _runnerDeferred = new Set<string>();

function runnerStart() { _startRunner(false); }

// Autopilot: keep completing tasks, one chat each, until none are left (or you stop it).
function runnerAutopilot() { _startRunner(true); }

// Manual start of one specific task (the play button on its card): one chat, then stop.
function runnerStartTask(path: string) { _startRunner(false, path); }

function _startRunner(all: boolean, onlyPath: string | null = null) {
    if (_runnerRunning || agentStreaming) return;
    if (aiBusy()) {
        const statusEl = document.getElementById('runner-status');
        if (statusEl) statusEl.textContent = 'Another AI task is running — wait for it to finish';
        return;
    }
    _runnerAll         = all;
    _runnerOnlyPath    = onlyPath;
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

// Flag the run as aborted (no stream abort). agent-core's stopNow calls this, so it must not
// call stopNow back.
function runnerAbort() {
    _runnerAbort  = true;
    _runnerPaused = false;
    _runnerPendingSteer.length = 0;
    if (_runnerUnblockResolve) {
        _runnerUnblockResolve('');
        _runnerUnblockResolve = null;
    }
}

function runnerStop() {
    runnerAbort();
    // Abort any in-flight LLM stream so the stop takes effect immediately.
    if (typeof agentStreaming !== 'undefined' && agentStreaming) stopNow?.();
}

// Steer the running task: the message is delivered as its own turn once the current step ends.
// The step in flight is cut short (soft stop) so the message is not stuck behind a long turn.
function runnerSteer(text: string) {
    const msg = String(text || '').trim();
    if (!msg || !_runnerRunning) return;
    if (_runnerPaused && _runnerUnblockResolve) { runnerSendUnblockWith(msg); return; }
    _runnerPendingSteer.push(msg);
    if (typeof agentStreaming !== 'undefined' && agentStreaming) {
        setSoftStopPending(true);
        activeAbortController?.abort();
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
    const all = _runnerAll;
    if (_runnerRunning) {
        runnerStop();
        const poll = setInterval(() => {
            if (!_runnerRunning) { clearInterval(poll); _startRunner(all); }
        }, 100);
    } else {
        _startRunner(all);
    }
}

// ── Loop core ──────────────────────────────────────────────────────────────

async function _runLoop() {
    _runnerRunning       = true;
    setAiJob('runner');
    _runnerPaused        = false;
    _runnerAbort         = false;
    _runnerConsecutiveFails = 0;
    _runnerPendingSteer.length = 0;
    _runnerDeferred.clear();
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
                if (userReply) await _runnerTurn(userReply);
                _runnerConsecutiveFails = 0;
                // The follow-up may have finished the task the block was about: record that, then
                // let the Run / Autopilot rule decide whether another task starts.
                try {
                    const fm = parseFrontmatter(await agentReadFile(task.path));
                    if (canonTaskStatus(fm.status) === 'done') {
                        const last = _runnerSessionLog[_runnerSessionLog.length - 1];
                        if (last) { last.outcome = 'done'; last.reason = ''; }
                        _renderRunnerLog();
                    }
                } catch {}
                if (!_runnerAll) break;
                await refreshTasks();
                continue;
            }

            // Run: one task attempted (done or failed) is the whole job.
            if (!_runnerAll) break;

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
        _runnerOnlyPath = null;
        setAiJob('');
        _runnerPaused  = false;
        _runnerAbort   = false;
        _runnerChatId  = null;
        // Leave autonomous mode: left on, every later chat turn ran with the NULL render
        // adapter (nothing shown) and skipped the chat-view snapshot.
        if (typeof setWorkflowMode === 'function') setWorkflowMode(false);
        if (typeof clearMainAgentRole === 'function') clearMainAgentRole();
        _clearRunnerProcess();
        _updateRunnerCurrentTask(null);
        _updateRunnerUI();
        if (_runnerPriorChatId) switchToChat(_runnerPriorChatId).catch(() => {});
    }
}

function _selectNextTask(tasks: Task[]): Task | null {
    if (_runnerOnlyPath) return tasks.find(t => t.path === _runnerOnlyPath && !_runnerDeferred.has(t.path)) ?? null;
    const groups = [
        ['in-review', 'review'],
        ['in-progress'],
        ['todo', 'open'],
    ];
    for (const group of groups) {
        const matched = tasks.filter(t => !_runnerDeferred.has(t.path) && group.includes((t.fm.status || 'todo').toLowerCase()));
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

    // Start through the lifecycle engine, so the dependency, enrichment and rework-limit gates
    // apply to the runner as they do to a card dragged on the board. A refusal ends the episode
    // before any agent work (or a new chat) begins.
    const _startStatus = canonTaskStatus((parseFrontmatter(await agentReadFile(task.path).catch(() => '')).status));
    if (getRunnerQa()) {
        const start = await transitionTask(task.path, 'in-progress');
        if (!start.transitioned) {
            _runnerDeferred.add(task.path);
            await refreshTasks();
            return { success: false, blocked: false, blockedReason: '', failReason: start.reason || 'Start gate refused the task' };
        }
    } else {
        await setTaskStatus(task.path, 'in-progress');
    }
    await refreshTasks();

    // createNewChat does not persist the chat it replaces — save it first.
    saveHistory();
    createNewChat();
    _runnerChatId = activeChatId;
    // Name the chat after the task so the rail entry is identifiable.
    const _taskLabel = `${task.fm.id ? '#' + task.fm.id + ' ' : ''}${task.fm.title || task.path}`;
    const _shortLabel = _taskLabel.length > 50 ? _taskLabel.slice(0, 50) + '…' : _taskLabel;
    if (typeof setChatName === 'function') setChatName(_runnerChatId, _shortLabel);
    _clearRunnerProcess(false);
    _clearHistory();

    // Activate the director role for the main agent — injects Kanban instructions into the
    // system prompt without polluting general chat sessions.
    if (typeof setMainAgentRole === 'function') setMainAgentRole('director');
    if (typeof setWorkflowMode === 'function') setWorkflowMode(true);

    // The runner prompts end with "call update_task_status", so the agent must have it whatever the
    // saved Settings → Tools selection says (a saved disabled list from before the tool existed, or
    // one that turned it off, left a run-task agent with no way to finish: chat 6f25, 2026-10-06).
    // In-memory only — the persisted selection is untouched and applies again after a reload.
    coworkEnabledTools.add('update_task_status');
    enabledTools.add('update_task_status');

    // The agent sees the task as the start gates left it (enrichment may have added to it) but
    // with its original status, not the in-progress mark the runner just set.
    // If the runner crashes before the cleanup block runs, the task stays in-progress
    // and will be retried on the next runner start — preferable to a silent stuck state.
    let _initialTaskContent: string = '';
    try { _initialTaskContent = (await agentReadFile(task.path)).replace(/^status:.*$/m, `status: ${_startStatus}`); } catch {}

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

        // Messages the user sent while the task ran: each is its own turn, then the task prompt resumes.
        while (_runnerPendingSteer.length && !_runnerAbort) {
            await _runnerTurn(_runnerPendingSteer.shift()!);
        }
        if (_runnerAbort) break;

        const taskName = task.fm.title || task.path;
        const prompt = turn === 1
            ? `Process this task file completely.\n\nFile: ${task.path}\n\n${taskContent}\n\nWhen done, call update_task_status("${task.path}", "done", "<one-line summary>").\nIf impossible, call update_task_status("${task.path}", "failed", "<reason>").`
            : `The task "${taskName}" (${task.path}) is not yet marked as done. Do NOT describe what needs to be done — call the tool now. Call update_task_status("${task.path}", "done", "<summary>") immediately, or update_task_status("${task.path}", "failed", "<reason>") if it cannot be done. No text response — tool call only.`;

        const _lastResult: any = await _runnerTurn(prompt);
        const lastMsg: string = typeof _lastResult === 'string' ? _lastResult : (_lastResult?.text ?? '');

        if (!_runnerRunning || _runnerAbort) break;

        // The runner's agent (director) declares "BLOCKED: <reason>", which _stripTerminal removes
        // from the returned text — so a text match for "STATUS: blocked" (the worker footer) never
        // saw it and blocked tasks were retried/replanned instead of pausing for the user.
        // runAgentTurn reports the declaration as finishSignal 'blocked'; the text is the reason.
        const _signal = typeof _lastResult === 'object' ? _lastResult?.finishSignal : null;
        const _statusBlocked = lastMsg.match(/STATUS:\s*blocked(?:[:\s-]+([^\n]+))?/i);
        if (_signal === 'blocked' || _statusBlocked) {
            blocked       = true;
            blockedReason = (_statusBlocked?.[1] ?? lastMsg.trim().split('\n').find(l => l.trim()) ?? '').trim().slice(0, 200)
                || 'Task blocked — needs user input';
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
        await _runnerTurn(replanPrompt);
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
    runnerSendUnblockWith(val);
}

function runnerSendUnblockWith(val: string) {
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
    runnerSteer(val);
}

// ── UI ─────────────────────────────────────────────────────────────────────

function _updateRunnerUI() {
    const runBtn      = document.getElementById('runner-run-btn');
    const autoBtn     = document.getElementById('autopilot-btn') as HTMLButtonElement | null;
    const pauseBtn    = document.getElementById('runner-pause-btn');
    const resumeBtn   = document.getElementById('runner-resume-btn');
    const restartBtn  = document.getElementById('runner-restart-btn');
    const stopBtn     = document.getElementById('runner-stop-btn');
    const statusEl    = document.getElementById('runner-status');
    const inputBar    = document.getElementById('runner-input-bar');
    const interruptBar = document.getElementById('runner-interrupt-bar');

    const idle    = !_runnerRunning;
    const running = _runnerRunning && !_runnerPaused;
    const paused  = _runnerRunning && _runnerPaused;

    if (runBtn)      runBtn.style.display      = idle    ? 'inline-block' : 'none';
    // Hidden while anything runs, like Run; the runner's Stop button stops either mode.
    if (autoBtn)     autoBtn.style.display     = idle    ? 'inline-block' : 'none';
    if (pauseBtn)    pauseBtn.style.display    = running  ? 'inline-block' : 'none';
    if (resumeBtn)   resumeBtn.style.display   = paused   ? 'inline-block' : 'none';
    if (restartBtn)  restartBtn.style.display  = _runnerRunning ? 'inline-block' : 'none';
    if (stopBtn)     stopBtn.style.display     = _runnerRunning ? 'inline-block' : 'none';
    if (inputBar)    inputBar.style.display    = paused   ? 'flex' : 'none';
    if (interruptBar) interruptBar.style.display = running ? 'flex' : 'none';

    if (statusEl) {
        if (idle)         statusEl.textContent = 'Idle';
        else if (paused)  statusEl.textContent = `Paused: ${_runnerPauseReason}`;
        else              statusEl.textContent = 'Running…';
        statusEl.classList.toggle('runner-running', running);
    }

    // Glow the Tasks rail nav button and the Runner label while the loop is active.
    const tasksRailBtn = document.querySelector('.left-rail .rail-nav-btn[data-tab="tasks"]');
    if (tasksRailBtn) tasksRailBtn.classList.toggle('runner-glow', _runnerRunning);
    // Per-card play buttons are only offered while the runner is idle.
    document.querySelector('.tab-panel[data-panel="tasks"]')?.classList.toggle('runner-active', _runnerRunning);
    const runnerLabel  = document.querySelector('.runner-label');
    if (runnerLabel)  runnerLabel.classList.toggle('runner-running', running);

    // Auto-expand runner zone when loop becomes active; don't auto-collapse on idle
    // so the session log stays visible after a run.
    if (_runnerRunning) toggleRunnerZone(true);
}

export function _updateRunnerCurrentTask(task: Task | null): void {
    const el = document.getElementById('runner-current-task');
    if (!el) return;
    if (!task) { el.textContent = '—'; return; }
    const id = task.fm.id ? `#${task.fm.id} ` : '';
    const label = `${id}${task.fm.title || task.path}`;
    const chatId = _runnerChatId;
    if (chatId) {
        // Clickable link that switches to the runner's chat; stopPropagation
        // prevents the runner-header onclick (toggleRunnerZone) from firing too.
        // Built with DOM methods: the label comes from task files, which agents write and
        // projects import, so it must never be parsed as HTML.
        const a = document.createElement('a');
        a.className = 'runner-chat-link';
        a.href = '#';
        a.title = 'Open chat';
        a.textContent = label;
        a.onclick = (e) => {
            e.preventDefault(); e.stopPropagation();
            if (typeof switchToChat === 'function') switchToChat(chatId).catch(() => {});
            if (typeof activateTab  === 'function') activateTab('chat');
        };
        el.replaceChildren(a);
    } else {
        el.textContent = label;
    }
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
Object.assign(window, { runnerStart, runnerAutopilot, runnerPause, runnerResume, runnerStartTask, runnerStop, runnerAbort, runnerSteer, runnerToggle, runnerRestart, runnerSendUnblock, runnerInterrupt, initRunner, isRunnerRunning, getRunnerChatId, toggleRunnerZone });
