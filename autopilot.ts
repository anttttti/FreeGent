// autopilot.js — FreeGent: autopilot task processing system
// Depends on: config.js, agent-core.js, chat-state.js, tasks.js, tabs.js, state.js (_clearHistory)

let autopilotActive: boolean = false;
const autopilotTaskTabs = new Map(); // taskPath → tab element
const MAX_TASK_ATTEMPTS = 5;

// ── Public API ─────────────────────────────────────────────────────────────

function toggleAutopilot() {
    if (autopilotActive) stopAutopilot();
    else startAutopilot();
}

// Exposed so the Agent-tab loop can refuse to start while autopilot owns the task files.
function isAutopilotRunning(): boolean { return autopilotActive; }

function stopAutopilot() {
    autopilotActive = false;
    _updateAutopilotBtn();
    _setTasksTabGlow(false);
}

async function startAutopilot() {
    if (autopilotActive || agentStreaming) return;
    // Both loops transition the same fg-tasks/*.md frontmatter and ledger — running them
    // concurrently interleaves status writes and corrupts task state.
    if (typeof isRunnerRunning === 'function' && isRunnerRunning()) {
        console.warn('[autopilot] Agent loop is running — stop it first (Agent tab).');
        return;
    }
    // Tabs from a previous run are stale: their chats are gone and their task statuses
    // have moved on. Without this the tab bar accumulates one entry per task, forever.
    _clearTaskTabs();
    autopilotActive = true;
    _updateAutopilotBtn();
    _setTasksTabGlow(true);
    try {
        await _runAutopilotLoop();
    } catch (e) {
        // toggleAutopilot discards this promise, so an escaping error would be an invisible
        // unhandled rejection. A write failure from setTaskStatus (audit §4.3) lands here.
        console.error('[autopilot] stopped:', e?.message || e);
    } finally {
        stopAutopilot();
    }
}

// ── Internal loop ──────────────────────────────────────────────────────────


async function _runAutopilotLoop() {
    while (autopilotActive) {
        // Synchronize ledger with task file statuses before processing
        try {
            await syncLedgerWithTaskFiles();
        } catch (e) {
            console.error('Ledger sync failed:', e.message);
        }

        const tasks = await loadTaskFiles();
        // Priority: in-review (furthest along) > in-progress > todo/open
        const next =
            tasks.find(t => (t.fm.status || '').toLowerCase() === 'in-review') ||
            tasks.find(t => (t.fm.status || '').toLowerCase() === 'in-progress') ||
            tasks.find(t => { const s = (t.fm.status || 'todo').toLowerCase(); return s === 'todo' || s === 'open'; });
        if (!next) break; // all tasks done

        await _processTaskAutopilot(next);
        if (!autopilotActive) break;

        await refreshTasks();
    }
}

async function _processTaskAutopilot(task) {
    if (agentStreaming) return;

    // Create a dedicated chat for this task
    createNewChat();
    const chatId = activeChatId;

    // Create visual tab in the tab bar
    const tab = _createTaskTab(task, chatId);
    _setTaskTabStatus(tab, 'processing');

    // Mark task as in-progress in the file (runs entry gates)
    await transitionTask(task.path, 'in-progress');
    await refreshTasks();

    let success: boolean = getAgentPlanMode()
        ? await _runPlanThenExecute(task, chatId)
        : await _runDirectExecution(task, chatId);

    if (success) {
        // Model signalled done — run lifecycle gates before finalising
        // Reset to in-progress so transitionTask sees the correct fromStatus
        await setTaskStatus(task.path, 'in-progress');
        const r1 = await transitionTask(task.path, 'in-review');
        if (r1.transitioned) {
            const r2 = await transitionTask(task.path, 'done');
            success = r2.transitioned;
        } else {
            success = false; // held at in-review for rework
        }
    }

    _setTaskTabStatus(tab, success ? 'done' : 'failed');
    if (!success) {
        try {
            await setTaskStatus(task.path, 'failed');
            const content = await agentReadFile(task.path);
            const date    = new Date().toISOString().slice(0, 10);
            await agentWriteFile(task.path,
                content.trimEnd() + `\n### ${date} — autopilot gave up\n`);
        } catch {}
    }

    await refreshTasks();
}

// ── Plan-then-execute (plan mode only) ─────────────────────────────────────

function _planFilePath(taskPath) {
    return taskPath.replace(/\.md$/, '.plan.md');
}

function _parsePlanSteps(content) {
    const steps = [];
    for (const line of content.split('\n')) {
        // Accept the checkbox variants models actually write: "- [ ]", "* [ ]",
        // "+ [ ]", "1. [ ]", "1) [ ]", with optional indentation — a stricter match
        // silently dropped steps from otherwise-valid plans.
        const m = line.match(/^\s*(?:[-*+]|\d+[.)])\s*\[([ xX])\]\s*(.+)/);
        if (m) steps.push({ done: m[1].trim().toLowerCase() === 'x', text: m[2].trim() });
    }
    return steps;
}

// Returns a string reason if replanning is needed, or null.
async function _shouldReplan(lastMsgText, steps, currentStepIndex, useLedger, ledgerPath) {
    if (/^STATUS:\s*blocked/i.test(lastMsgText)) {
        return 'Worker returned STATUS: blocked';
    }

    // Catches empty output or stall signals like "*(done)*"
    if (lastMsgText.trim().length < 50 && !/write_file|append_file|replace_in_file|update_task_status/i.test(lastMsgText)) {
        return 'Step produced no meaningful output';
    }

    if (useLedger) {
        try {
            const ledger = await agentReadFile(ledgerPath);
            if (/Plan still valid:\s*no/i.test(ledger)) {
                return 'Ledger indicates plan is no longer valid';
            }
        } catch {}
    }

    return null;
}

async function _runPlanThenExecute(task, chatId) {
    const planPath = _planFilePath(task.path);
    const input    = document.getElementById('agent-input');

    // Ensure we are in this task's chat
    if (activeChatId !== chatId) await switchToChat(chatId);
    activateTab('chat');

    // ── Ledger setup ──
    const useLedger = getAgentLedger();
    const now = new Date();
    const ts  = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}-${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
    const ledgerPath = `fg-tasks/ledger-${ts}.md`;

    // ── Planning call: skip if a partial plan from a prior session exists ──
    let taskContent: string = '';
    try { taskContent = await agentReadFile(task.path); } catch {}

    let planContent: string = '';
    let steps: { done: boolean; text: string }[] = [];
    let resuming: boolean = false;
    try {
        planContent = await agentReadFile(planPath);
        steps = _parsePlanSteps(planContent);
        if (steps.length && steps.some(s => !s.done)) resuming = true;
    } catch {}

    if (!resuming) {
        if (useLedger) {
            const ledgerInit =
                `# Task Ledger\n\n## Task\n**Goal:** ${task.fm.title || task.path}\n\n` +
                `**Constraints:** (from task file)\n${taskContent.slice(0, 800)}\n\n` +
                `**Initial assumptions:** TBD after planning\n\n## Progress\n`;
            try { await agentWriteFile(ledgerPath, ledgerInit); } catch {}
        }

        const planPrompt =
            `Read this task and write a concise step-by-step plan to \`${planPath}\` ` +
            `using \`- [ ] step\` checkboxes (3–8 steps). Do NOT execute anything yet — plan only.\n\n` +
            `${task.path}:\n${taskContent}`;
        if (input) { _setInputText(input, planPrompt); autoResizeTextarea(input); }
        await agentSend();
        if (!autopilotActive) return false;

        planContent = '';
        try { planContent = await agentReadFile(planPath); } catch {}
        steps = _parsePlanSteps(planContent);
    }

    if (!steps.length) {
        // Model didn't create a plan — fall back to direct execution. If the file has
        // checkbox-shaped lines that none of the accepted formats matched, say so —
        // silently dropping a written plan is the failure mode we're guarding against.
        if (/\[[ xX]\]/.test(planContent))
            console.warn('[autopilot] plan file has checkbox-like lines but none parsed — check format. Falling back to direct execution.');
        return _runDirectExecution(task, chatId);
    }

    let replanCount: number = 0;
    const maxReplans = getAgentMaxReplans();

    // ── Execute each unchecked step with focused context ──
    let prevStepSummary: string = '';
    for (let i = 0; i < steps.length && autopilotActive; i++) {
        if (steps[i].done) continue;

        // Capture last model output before clearing history, to carry forward as context
        if (i > 0) {
            const lastModelEl = getMessagesEl()?.querySelector('.agent-msg-model:last-child');
            if (lastModelEl) {
                prevStepSummary = lastModelEl.textContent.slice(0, 400).trim();
            }
        }

        // Clear history so each step gets a focused, minimal context
        _clearHistory();

        try { taskContent = await agentReadFile(task.path); } catch {}
        const ledgerRef = useLedger ? `\nLedger (completed steps and current state): \`${ledgerPath}\` — read it to orient yourself.\n` : '';
        const prevRef = prevStepSummary ? `\nPrevious step outcome (summary): ${prevStepSummary}\n` : '';
        const stepPrompt =
            `Execute step ${i + 1} of ${steps.length}: **${steps[i].text}**\n\n` +
            `Task file: ${task.path}\n${taskContent.slice(0, 1500)}\n` +
            ledgerRef + prevRef +
            `\nWhen done, update \`${planPath}\` — change \`[ ]\` to \`[x]\` for this step.`;
        if (input) { _setInputText(input, stepPrompt); autoResizeTextarea(input); }
        await agentSend();

        if (!autopilotActive) return false;

        const lastMsgText = getMessagesEl()?.querySelector('.agent-msg-model:last-child')?.textContent || '';
        if (_isRateLimit(lastMsgText) && _switchToFreeModel()) {
            _clearHistory();
        }

        // ── Append progress entry to ledger ──
        if (useLedger) {
            const stepTime = new Date().toISOString().slice(0, 16).replace('T', ' ');
            const progressEntry =
                `\n### Step ${i + 1} — ${steps[i].text} — ${stepTime}\n` +
                `Outcome: (see chat above)\n` +
                `Advanced: yes\n` +
                `Remaining: ${steps.slice(i + 1).filter(s => !s.done).map(s => s.text).join('; ') || 'none'}\n` +
                `Plan still valid: yes\n`;
            try {
                const ledger = await agentReadFile(ledgerPath);
                await agentWriteFile(ledgerPath, ledger + progressEntry);
            } catch {}
        }

        const replanReason = await _shouldReplan(lastMsgText, steps, i, useLedger, ledgerPath);
        if (replanReason) {
            if (replanCount >= maxReplans) {
                // Replan limit reached — mark task as blocked
                try {
                    const content = await agentReadFile(task.path);
                    const date = new Date().toISOString().slice(0, 10);
                    const blockedMsg = `\n### ${date} — blocked: replan limit (${maxReplans}) reached — ${replanReason}\n`;
                    await agentWriteFile(task.path, content.trimEnd() + blockedMsg);
                } catch {}
                return false;
            }

            replanCount++;

            // Log replan reason to ledger
            if (useLedger) {
                const replanEntry = `\n### Replan #${replanCount} — ${replanReason}\n`;
                try {
                    const ledger = await agentReadFile(ledgerPath);
                    await agentWriteFile(ledgerPath, ledger + replanEntry);
                } catch {}
            }

            // Collect current state for replan prompt
            let completedSteps: string[] = steps.slice(0, i).filter(s => s.done).map(s => `- [x] ${s.text}`);
            let remainingSteps: string[] = steps.slice(i).filter(s => !s.done).map(s => `- [ ] ${s.text}`);
            let fileListing: string = '';
            try {
                const files = await listWorkspaceFiles();
                fileListing = files.map(f => f.name).join('\n');
            } catch {}

            const replanPrompt =
                `The current plan has diverged from reality. Replan the remaining steps.\n\n` +
                `Original goal: ${task.fm.title || task.path}\n\n` +
                `Completed so far:\n${completedSteps.join('\n') || '(none)'}\n\n` +
                `Remaining steps (may need revision):\n${remainingSteps.join('\n')}\n\n` +
                `Replan trigger: ${replanReason}\n\n` +
                `Current workspace files:\n${fileListing}\n\n` +
                `Write a revised plan to \`${planPath}\` using \`- [ ] step\` checkboxes ` +
                `for the remaining work. Keep already-completed steps as \`- [x] step\`.`;

            _clearHistory();
            if (input) { _setInputText(input, replanPrompt); autoResizeTextarea(input); }
            await agentSend();
            if (!autopilotActive) return false;

            // Read the revised plan
            try {
                const oldRemainingText = remainingSteps.join('\n');
                planContent = await agentReadFile(planPath);
                const newSteps = _parsePlanSteps(planContent);
                const newRemainingText = newSteps.filter(s => !s.done).map(s => `- [ ] ${s.text}`).join('\n');
                if (newRemainingText === oldRemainingText && newRemainingText) {
                    // Replan produced no change — don't retry, treat as blocked
                    const content = await agentReadFile(task.path);
                    const date = new Date().toISOString().slice(0, 10);
                    await agentWriteFile(task.path, content.trimEnd() + `\n### ${date} — blocked: replan produced identical steps\n`);
                    return false;
                }
                steps = newSteps;
                // Reset to the first unchecked step in the new plan
                i = steps.findIndex(s => !s.done);
                if (i === -1) i = steps.length; // all done
            } catch {
                // If we can't read the revised plan, continue with original
            }
        }
    }

    // ── Finalise: ask model to mark task done ──
    _clearHistory();
    const finalPrompt =
        `All steps in \`${planPath}\` are complete. ` +
        `Update \`${task.path}\` frontmatter status to "done" and append a log entry.`;
    if (input) { _setInputText(input, finalPrompt); autoResizeTextarea(input); }
    await agentSend();

    try {
        const content = await agentReadFile(task.path);
        const fm = parseFrontmatter(content);
        return (fm.status || '').toLowerCase() === 'done';
    } catch { return false; }
}

// ── Direct execution (original approach, no plan mode) ─────────────────────

async function _runDirectExecution(task, chatId) {
    const input    = document.getElementById('agent-input');
    const taskName = task.fm.title || task.path;
    let attempts: number = 0;

    while (autopilotActive && attempts < MAX_TASK_ATTEMPTS) {
        attempts++;

        let taskContent: string = '';
        try { taskContent = await agentReadFile(task.path); } catch {}

        const prompt = attempts === 1
            ? `Process this task file completely.\n\nFile: ${task.path}\n\n${taskContent}\n\nWhen the task is fully done, update the frontmatter status to "done" and append a log entry. If the task is impossible, set status to "failed" and explain why in the log.`
            : `The task "${taskName}" (${task.path}) is not yet marked as done. Please complete it now and update the status to "done", or set it to "failed" if it cannot be done.`;

        if (activeChatId !== chatId) await switchToChat(chatId);
        activateTab('chat');

        if (input) { _setInputText(input, prompt); autoResizeTextarea(input); }
        await agentSend();
        if (!autopilotActive) return false;

        const lastMsgText = getMessagesEl()?.querySelector('.agent-msg-model:last-child')?.textContent || '';
        if (_isRateLimit(lastMsgText) && _switchToFreeModel()) {
            _clearHistory();
            continue;
        }

        try {
            const content = await agentReadFile(task.path);
            const fm      = parseFrontmatter(content);
            const status  = (fm.status || '').toLowerCase();
            if (status === 'done') return true;
            if (status === 'failed' || status === 'impossible') return false;
        } catch {}
    }

    return false;
}

// ── Tab management ─────────────────────────────────────────────────────────

function _createTaskTab(task, chatId) {
    const rawName = task.fm.title || task.path.replace(/^.*\//, '').replace('.md', '');
    const label   = rawName.length > 22 ? rawName.slice(0, 22) + '…' : rawName;

    const tab = document.createElement('div');
    tab.className = 'tab task-auto-tab';
    tab.dataset.chatId   = chatId;
    tab.dataset.taskPath = task.path;
    tab.title = rawName;
    tab.onclick = () => { switchToChat(chatId); activateTab('chat'); };

    const icon    = document.createElement('span');
    icon.className = 'task-auto-icon';
    icon.textContent = '⚙';

    const text    = document.createElement('span');
    text.textContent = ' ' + label;

    tab.append(icon, text);

    document.getElementById('tab-bar').appendChild(tab);

    autopilotTaskTabs.set(task.path, tab);
    return tab;
}

// Remove every tab this module added to the tab bar. autopilotTaskTabs was previously
// written but never read, so tabs leaked across runs.
function _clearTaskTabs() {
    for (const tab of autopilotTaskTabs.values()) tab.remove();
    autopilotTaskTabs.clear();
}

function _setTaskTabStatus(tab, status) {
    tab.classList.remove('task-auto-processing', 'task-auto-done', 'task-auto-failed');
    tab.classList.add(`task-auto-${status}`);
    const icon = tab.querySelector('.task-auto-icon');
    if (icon) icon.textContent = status === 'done' ? '✓' : status === 'failed' ? '✗' : '⚙';
}

// ── UI helpers ─────────────────────────────────────────────────────────────

function _updateAutopilotBtn() {
    const btn = document.getElementById('autopilot-btn');
    if (!btn) return;
    if (autopilotActive) {
        btn.textContent = '⏹ Stop';
        btn.classList.add('autopilot-btn-active');
    } else {
        btn.textContent = '▶ Autopilot';
        btn.classList.remove('autopilot-btn-active');
    }
}

function _setTasksTabGlow(on) {
    const tab = document.querySelector('#tab-bar [data-tab="tasks"]');
    if (tab) tab.classList.toggle('autopilot-glow', on);
}

// Window bridge for classic scripts and inline handlers (ESM migration).
Object.assign(window, { toggleAutopilot, stopAutopilot, isAutopilotRunning });
