// tasks.js — FreeGent: task file loading and Kanban board rendering
// Depends on: config.js, tabs.js

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
                        const content = await agentReadFile(f.name);
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
    previewEl.innerHTML = `
        <div class="task-preview-header">
            <span class="task-preview-name">${path}</span>
            <button class="ws-action-btn" onclick="document.getElementById('task-preview').classList.remove('active')" style="font-size:10px; padding:1px 6px;">✕ Close</button>
        </div>
        <div class="task-preview-body"></div>
    `;

    const body = previewEl.querySelector('.task-preview-body');
    try {
        const content = await agentReadFile(path);
        taskPreviewEditor?.destroy();
        taskPreviewEditor = await createEditor(body, path, content, { readOnly: true });
    } catch (e) {
        body.innerHTML = `<div class="workspace-empty">Error loading preview: ${e.message}</div>`;
    }
}

function makeKanbanCard(task) {
    const card = document.createElement('div');
    card.className = 'kanban-card';
    card.onclick = () => previewTask(task.path);
    card.ondblclick = () => openFileTab(task.path);

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
    if (status === 'in-review' || status === 'review') {
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

let _refreshInFlight: Promise<void> | null = null;
async function refreshTasks(): Promise<void> {
    // Coalesce concurrent calls: if a render is already in progress, return its promise so
    // callers that await us still resolve at the right time but no duplicate render runs.
    if (_refreshInFlight) return _refreshInFlight;
    _refreshInFlight = _doRefreshTasks().finally(() => { _refreshInFlight = null; });
    return _refreshInFlight;
}
async function _doRefreshTasks() {
    const COLS = { todo: 'col-todo', open: 'col-todo', 'in-progress': 'col-in-progress', 'in-review': 'col-review', review: 'col-review', blocked: 'col-todo', done: 'col-done', completed: 'col-done' };
    for (const id of Object.values(COLS)) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    }
    const counts = Object.fromEntries(Object.keys(COLS).map(k => [k, 0]));
    const tasks = await loadTaskFiles();
    for (const task of tasks) {
        const status = (task.fm.status || 'todo').toLowerCase();
        const colKey = COLS[status] ? status : 'todo';
        const col = document.getElementById(COLS[colKey]);
        if (col) { col.appendChild(makeKanbanCard(task)); counts[colKey]++; }
    }
    for (const [status, n] of Object.entries(counts)) {
        const badge = document.querySelector(`.kanban-col[data-status="${status}"] .kanban-col-count`);
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
Object.assign(window, { loadTaskFiles, refreshTasks, syncLedgerWithTaskFiles });
