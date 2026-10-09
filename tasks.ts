// tasks.js — FreeGent: task file loading and Kanban board rendering
// Depends on: config.js, tabs.js

import { canonTaskStatus, columnOfStatus } from './task-status.js';

function parseLastLogEntry(content) {
    const logIdx = content.search(/^## Log/im);
    if (logIdx === -1) return '';
    const logSection = content.slice(logIdx);
    const entries = [...logSection.matchAll(/^### (.+)$/gm)];
    return entries.length ? entries[entries.length - 1][1] : '';
}

async function loadTaskFiles() {
    const tasks: any[] = [];
    try {
        const files = await agentListFiles();
        await Promise.all(
            files
                .filter(f => (f.name.startsWith('fg-tasks/') || f.name.startsWith('tasks/') || f.name.startsWith('local/tasks/')) && f.name.endsWith('.md') && !f.name.endsWith('/ledger.md'))
                .map(async f => {
                    try {
                        // One retry: a transient read failure (IndexedDB hiccup on a low-memory device)
                        // otherwise drops the task from the board and from the runner's selection.
                        const content = await agentReadFile(f.name).catch(() => agentReadFile(f.name));
                        const fm = parseFrontmatter(content);
                        // Accept any file that has id, title, or matches the NNN-slug.md naming
                        // convention — an AI-created task may lack frontmatter keys but is still valid.
                        if (!fm.id && !fm.title && !/\/\d{2,}-/.test(f.name)) return;
                        tasks.push({ path: f.name, fm, lastLog: parseLastLogEntry(content) });
                    } catch {}
                })
        );
    } catch {}
    tasks.sort((a, b) => (Number(a.fm.id) || 0) - (Number(b.fm.id) || 0));
    return tasks;
}

let taskPreviewEditor: any = null;
async function previewTask(path) {
    const previewEl = document.getElementById('task-preview');
    if (!previewEl) return;

    previewEl.classList.add('active');
    // Built from DOM nodes: the path comes from workspace files, which an import, the agent or the
    // sandbox can name freely, so it must never be parsed as HTML.
    previewEl.textContent = '';
    const header = document.createElement('div');
    header.className = 'task-preview-header';
    const nameEl = document.createElement('span');
    nameEl.className = 'task-preview-name';
    nameEl.textContent = path;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ws-action-btn';
    closeBtn.style.cssText = 'font-size:10px; padding:1px 6px;';
    closeBtn.textContent = '✕ Close';
    closeBtn.title = 'Close this task preview';
    closeBtn.onclick = () => previewEl.classList.remove('active');
    header.append(nameEl, closeBtn);
    const body = document.createElement('div');
    body.className = 'task-preview-body';
    previewEl.append(header, body);

    try {
        const content = await agentReadFile(path);
        taskPreviewEditor?.destroy();
        taskPreviewEditor = await createEditor(body, path, content, { readOnly: true });
    } catch (e) {
        const err = document.createElement('div');
        err.className = 'workspace-empty';
        err.textContent = `Error loading preview: ${e.message}`;
        body.textContent = '';
        body.appendChild(err);
    }
}

function makeKanbanCard(task) {
    const card = document.createElement('div');
    card.className = 'kanban-card';
    card.draggable = true;
    card.addEventListener('dragstart', e => {
        e.dataTransfer?.setData('text/plain', task.path);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.onclick = () => previewTask(task.path);
    card.ondblclick = () => openFileTab(task.path);

    const trash = document.createElement('button');
    trash.className = 'kanban-card-trash';
    trash.title = 'Delete this task file permanently (asks to confirm)';
    trash.textContent = '🗑';
    trash.draggable = false;
    trash.onclick = async e => {
        e.stopPropagation();
        const name = task.fm.title || task.path;
        if (!confirm(`Delete task "${name}"? This removes ${task.path}.`)) return;
        try {
            await agentDeleteFile(task.path);
            document.getElementById('task-preview')?.classList.remove('active');
            await syncLedgerWithTaskFiles();
        } catch (err: any) {
            alert('Failed to delete task: ' + (err?.message || err));
        }
    };
    card.appendChild(trash);

    // Manual block / unblock: a plain status flip (no QA gates). Unblocking returns the task to To Do.
    const isBlocked = canonTaskStatus(task.fm.status) === 'blocked';
    const blockBtn = document.createElement('button');
    blockBtn.className = 'kanban-card-block';
    blockBtn.title = isBlocked ? 'Unblock this task: move it back to To Do so the runner can pick it up' : 'Block this task: the runner skips it until you unblock it';
    blockBtn.textContent = isBlocked ? '🔓' : '⊘';
    blockBtn.draggable = false;
    blockBtn.onclick = async e => {
        e.stopPropagation();
        try {
            await setTaskStatus(task.path, isBlocked ? 'open' : 'blocked');
            await syncLedgerWithTaskFiles();
        } catch (err: any) {
            alert('Failed to ' + (isBlocked ? 'unblock' : 'block') + ' task: ' + (err?.message || err));
        }
    };
    card.appendChild(blockBtn);

    // Manual start: run just this task (one chat, then the runner stops).
    const canon = canonTaskStatus(task.fm.status);
    if (canon !== 'done' && canon !== 'blocked') {
        const playBtn = document.createElement('button');
        playBtn.className = 'kanban-card-play';
        playBtn.title = 'Start this task now: runs only this task in its own chat, then stops';
        playBtn.textContent = '▶';
        playBtn.draggable = false;
        playBtn.onclick = e => {
            e.stopPropagation();
            runnerStartTask(task.path);
        };
        card.appendChild(playBtn);
    }

    const title = document.createElement('div');
    title.className = 'kanban-card-title';
    const taskName = task.fm.title || task.path.replace(/^(?:fg-|local\/)?tasks\//, '').replace('.md', '');
    title.textContent = task.fm.id ? `#${task.fm.id} ${taskName}` : taskName;
    card.appendChild(title);

    if (task.lastLog) {
        const log = document.createElement('div');
        log.className = 'kanban-card-log';
        log.textContent = task.lastLog;
        card.appendChild(log);
    }

    if (task.fm.updated || task.fm.created) {
        const meta = document.createElement('div');
        meta.className = 'kanban-card-meta';
        meta.textContent = task.fm.updated || task.fm.created;
        card.appendChild(meta);
    }

    const status = (task.fm.status || 'todo').toLowerCase();
    if (canonTaskStatus(status) === 'in-review') {
        card.style.borderLeft = '3px solid #e65100';
    } else if (status === 'blocked') {
        card.style.borderLeft = '3px solid #c62828';
        const badge = document.createElement('div');
        badge.className = 'kanban-card-log';
        badge.style.color = '#c62828';
        badge.textContent = '⊘ blocked';
        card.appendChild(badge);
    }

    return card;
}

function openAddTaskDialog(status: string) {
    document.getElementById('fg-add-task-dialog')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'fg-add-task-dialog';
    overlay.className = 'fg-modal-overlay';
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    const lbl = 'padding:4px 8px 4px 0;color:var(--muted);white-space:nowrap;width:80px;vertical-align:top';
    const inp = 'margin:0;width:100%';
    const statuses = [['open', 'To Do'], ['in-progress', 'In Progress'], ['in-review', 'Review'], ['done', 'Done']];
    const cur = status === 'todo' ? 'open' : status;
    overlay.innerHTML = `<div class="fg-modal" style="max-width:520px;width:95%">
  <div class="fg-modal-header">
    <span class="fg-modal-title">Add task</span>
    <button class="fg-modal-close" id="atd-close" title="Close without adding a task">✕</button>
  </div>
  <div class="fg-modal-body">
    <table style="width:100%;border-collapse:collapse;font-size:12px"><tbody>
      <tr><td style="${lbl}">Title</td><td><input class="settings-input" id="atd-title" type="text" style="${inp}" placeholder="Short imperative title"></td></tr>
      <tr><td style="${lbl}">Status</td><td><select class="settings-input" id="atd-status" style="${inp}">${statuses.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('')}</select></td></tr>
      <tr><td style="${lbl}">Priority</td><td><select class="settings-input" id="atd-priority" style="${inp}"><option>High</option><option selected>Medium</option><option>Low</option></select></td></tr>
      <tr><td style="${lbl}">Description</td><td><textarea class="settings-input" id="atd-desc" rows="4" style="${inp};resize:vertical" placeholder="What to do and what done looks like"></textarea></td></tr>
      <tr><td style="${lbl}">Criteria</td><td><textarea class="settings-input" id="atd-criteria" rows="3" style="${inp};resize:vertical" placeholder="Acceptance criteria, one per line"></textarea></td></tr>
    </tbody></table>
    <div id="atd-err" style="color:#c62828;font-size:11px;min-height:14px"></div>
  </div>
  <div class="fg-modal-btns">
    <button class="fg-modal-btn fg-modal-btn-cancel" id="atd-cancel" title="Close without adding a task">Cancel</button>
    <button class="fg-modal-btn fg-modal-btn-ok" id="atd-ok" title="Create the task file with these details and add it to the board">Add task</button>
  </div>
</div>`;
    document.body.appendChild(overlay);
    const $ = (id: string) => overlay.querySelector('#' + id) as any;
    $('atd-close').onclick = $('atd-cancel').onclick = () => overlay.remove();
    $('atd-title').focus();
    $('atd-ok').onclick = async () => {
        const title = $('atd-title').value.trim().replace(/\s+/g, ' ');
        if (!title) { $('atd-err').textContent = 'Title is required.'; return; }
        $('atd-ok').disabled = true;
        try {
            const existing = await loadTaskFiles();
            const nextId = Math.max(0, ...existing.map(t => Number(t.fm.id) || 0),
                ...existing.map(t => Number((t.path.match(/\/(\d+)-/) || [])[1]) || 0)) + 1;
            const id = String(nextId).padStart(3, '0');
            const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'task';
            const criteria = $('atd-criteria').value.split('\n').map((l: string) => l.trim().replace(/^[-*]\s*(\[[ x]\]\s*)?/, '')).filter(Boolean);
            const today = new Date().toISOString().slice(0, 10);
            const content = `---\nid: ${id}\ntitle: ${title.replace(/:/g, ' -')}\nstatus: ${$('atd-status').value}\npriority: ${$('atd-priority').value}\ncreated: ${today}\n---\n# ${title}\n${$('atd-desc').value.trim()}\n## Acceptance Criteria\n${criteria.map((c: string) => `- [ ] ${c}`).join('\n')}\n## Log\n`;
            await agentWriteFile(`fg-tasks/${id}-${slug}.md`, content);
            overlay.remove();
            await syncLedgerWithTaskFiles();   // new row in the ledger, then refresh the board
        } catch (e: any) {
            $('atd-err').textContent = 'Failed to add task: ' + (e?.message || e);
            $('atd-ok').disabled = false;
        }
    };
    overlay.addEventListener('keydown', e => { if (e.key === 'Escape') overlay.remove(); });
}

// Column drop targets. Wired once; the column elements persist across refreshes.
async function moveTaskToColumn(path: string, colStatus: string) {
    const newStatus = colStatus === 'todo' ? 'open' : canonTaskStatus(colStatus);
    const task = (await loadTaskFiles()).find(t => t.path === path);
    if (!task) return;
    const cur = (task.fm.status || 'todo').toLowerCase();
    const curCol = columnOfStatus(cur);
    if (curCol === colStatus) return;
    try {
        const r = await transitionTask(path, newStatus);
        if (!r.transitioned) { alert('Move blocked: ' + (r.reason || 'QA gate blocked transition')); return; }
    } catch (e: any) {
        alert('Failed to move task: ' + (e?.message || e));
    }
    // Rebuild rather than patch the row: it also covers a task with no row yet, and keeps the
    // ledger right when the move itself was refused or failed half-way.
    await syncLedgerWithTaskFiles();
}
function initKanbanDnD() {
    document.querySelectorAll('.kanban-col').forEach((col: any) => {
        col.addEventListener('dragover', (e: DragEvent) => { e.preventDefault(); col.classList.add('drag-over'); });
        col.addEventListener('dragleave', (e: DragEvent) => { if (!col.contains(e.relatedTarget as Node)) col.classList.remove('drag-over'); });
        col.addEventListener('drop', (e: DragEvent) => {
            e.preventDefault();
            col.classList.remove('drag-over');
            const path = e.dataTransfer?.getData('text/plain');
            if (path) moveTaskToColumn(path, col.dataset.status);
        });
    });
}
initKanbanDnD();

// Coalesce concurrent refreshes, but never drop one: a call that arrives while a render is running
// (it may already have read the task files) queues exactly one more pass. Returning the running
// render's promise instead left the board showing the old state — a task finished while the previous
// render was loading stayed under In Progress until the next refresh.
let _refreshInFlight: Promise<void> | null = null;
let _refreshAgain = false;
async function refreshTasks(): Promise<void> {
    if (_refreshInFlight) { _refreshAgain = true; return _refreshInFlight; }
    _refreshInFlight = (async () => {
        try {
            do { _refreshAgain = false; await _doRefreshTasks(); } while (_refreshAgain);
        } finally { _refreshInFlight = null; }
    })();
    return _refreshInFlight;
}
async function _doRefreshTasks() {
    const COLUMNS = ['todo', 'in-progress', 'review', 'done'];
    const counts: Record<string, number> = Object.fromEntries(COLUMNS.map(c => [c, 0]));
    const tasks = await loadTaskFiles();
    // Build off-screen and swap in once loaded: the columns used to be emptied first, so a failed or
    // slow load (low-memory iPad) left the board blank or half-drawn.
    const frags: Record<string, DocumentFragment> = {};
    for (const task of tasks) {
        const column = columnOfStatus(task.fm.status);
        (frags[column] ??= document.createDocumentFragment()).appendChild(makeKanbanCard(task));
        counts[column]++;
    }
    for (const c of COLUMNS) {
        const el = document.getElementById(`col-${c}`);
        if (el) { el.innerHTML = ''; if (frags[c]) el.appendChild(frags[c]); }
    }
    for (const [column, n] of Object.entries(counts)) {
        const badge = document.querySelector(`.kanban-col[data-status="${column}"] .kanban-col-count`);
        if (badge) badge.textContent = String(n);
    }
}
async function syncLedgerWithTaskFiles() {
    await rebuildLedger();
    // Always refresh the board — rebuildLedger() returns early when there are no task
    // files and won't trigger refreshTasks() via agentWriteFile. The in-flight guard in
    // refreshTasks() collapses this into one render when agentWriteFile already fired one.
    await refreshTasks();
}

// Window bridge for classic scripts and inline handlers (ESM migration).
Object.assign(window, { openAddTaskDialog, moveTaskToColumn, loadTaskFiles, refreshTasks, syncLedgerWithTaskFiles });
