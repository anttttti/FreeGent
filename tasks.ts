// tasks.js — FreeGent: task file loading and Kanban board rendering
// Depends on: config.js, tabs.js

import { splitFrontmatter, parseFmLines, setFmLines, buildFrontmatter } from './frontmatter.js';
import { workspaceEpoch } from './exec-limits.js';
import { lease } from './lease.js';
import { canonTaskStatus, columnOfStatus, dedupeTasksByTitle, isTaskPath } from './task-status.js';

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
                .filter(f => isTaskPath(f.name) && f.name.endsWith('.md') && !f.name.endsWith('/ledger.md'))
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
    // A copy of a task (same title) is not a second task: Autopilot once wrote one while working.
    return dedupeTasksByTitle(tasks);
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

    const editBtn = document.createElement('button');
    editBtn.className = 'kanban-card-edit';
    editBtn.title = 'Edit this task: title, status, priority, description and acceptance criteria';
    editBtn.textContent = '✎';
    editBtn.draggable = false;
    editBtn.onclick = e => {
        e.stopPropagation();
        openEditTaskDialog(task.path);
    };
    card.appendChild(editBtn);

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
    openTaskDialog({ status });
}

async function openEditTaskDialog(path: string) {
    let content: string;
    try {
        content = await agentReadFile(path);
    } catch (e: any) {
        alert('Failed to open task: ' + (e?.message || e));
        return;
    }
    openTaskDialog({ path, content });
}

// Split a task file into the parts the dialog edits and the rest, which is written back untouched.
function parseTaskForEdit(content: string) {
    const norm = content.replace(/\r\n/g, '\n');
    const split = splitFrontmatter(norm);
    const fmLines = split ? split.lines : [];
    const body = split ? split.body : norm;
    const fm: Record<string, string> = parseFmLines(fmLines);
    const critIdx = body.search(/^## Acceptance Criteria[ \t]*$/im);
    const head = critIdx === -1 ? body : body.slice(0, critIdx);
    let rest = '';
    const criteria: { text: string; checked: boolean }[] = [];
    if (critIdx !== -1) {
        const after = body.slice(critIdx).replace(/^.*\n?/, '');
        const next = after.search(/^## /m);
        const block = next === -1 ? after : after.slice(0, next);
        rest = next === -1 ? '' : after.slice(next);
        for (const l of block.split('\n')) {
            const cm = l.match(/^\s*[-*]\s*(?:\[([ xX])\]\s*)?(.*\S)\s*$/);
            if (cm) criteria.push({ text: cm[2], checked: /x/i.test(cm[1] || '') });
        }
    }
    // "## Attachments": one workspace path per list item; pulled out of `rest` so it is written back
    // from the dialog's list.
    const attachments: string[] = [];
    const am = rest.match(/^## Attachments[ \t]*\n/m);
    if (am && am.index !== undefined) {
        const from = am.index + am[0].length;
        const nx = rest.slice(from).search(/^## /m);
        const block = nx === -1 ? rest.slice(from) : rest.slice(from, from + nx);
        for (const l of block.split('\n')) {
            const t = l.match(/^\s*[-*]\s+(.*\S)\s*$/);
            if (t) attachments.push(t[1].replace(/^`|`$/g, ''));
        }
        rest = rest.slice(0, am.index) + (nx === -1 ? '' : rest.slice(from + nx));
    }
    const h = head.match(/^# (.*)$/m);
    const desc = head.replace(/^# .*\n?/m, '').trim();
    return { fmLines, fm, heading: h ? h[1] : '', desc, criteria, attachments, rest };
}

function attachmentsBlock(paths: string[]): string {
    return paths.length ? `## Attachments\n${paths.map(p => `- ${p}`).join('\n')}\n` : '';
}

function openTaskDialog(opts: { status?: string; path?: string; content?: string }) {
    const editing = opts.path !== undefined;
    const parsed = editing ? parseTaskForEdit(opts.content || '') : null;
    const status = opts.status || 'todo';
    document.getElementById('fg-add-task-dialog')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'fg-add-task-dialog';
    overlay.className = 'fg-modal-overlay';
    // Attachments: workspace paths listed in the task file. Uploads made in this dialog are written to
    // the workspace at once, so they are deleted again when the dialog closes without saving.
    const attached: string[] = parsed ? [...parsed.attachments] : [];
    const uploaded = new Set<string>();
    let saved = false;
    let pendingUploads = 0;
    // Uploads belong to the project they were stored in. After Clear or an import the same paths may name a restored file
    // that the form never owned, so a late cleanup must leave them (codex report 8, cases 233/238).
    const epoch = workspaceEpoch();
    const dismiss = () => {
        overlay.remove();
        if (!saved && workspaceEpoch() === epoch) for (const p of uploaded) void agentDeleteFile?.(p).catch(() => {});
    };
    overlay.addEventListener('click', e => { if (e.target === overlay) dismiss(); });
    const lbl = 'padding:4px 8px 4px 0;color:var(--muted);white-space:nowrap;width:80px;vertical-align:top';
    const inp = 'margin:0;width:100%';
    const statuses = [['open', 'To Do'], ['in-progress', 'In Progress'], ['in-review', 'Review'], ['done', 'Done']];
    let cur = status === 'todo' ? 'open' : status;
    if (parsed) {
        const col = columnOfStatus(parsed.fm.status);
        cur = col === 'todo' ? 'open' : col === 'review' ? 'in-review' : col;
    }
    const priorities = ['High', 'Medium', 'Low'];
    const curPrio = parsed ? (priorities.find(p => p.toLowerCase() === (parsed.fm.priority || '').toLowerCase()) || 'Medium') : 'Medium';
    const verb = editing ? 'Save task' : 'Add task';
    overlay.innerHTML = `<div class="fg-modal" style="max-width:520px;width:95%">
  <div class="fg-modal-header">
    <span class="fg-modal-title">${editing ? 'Edit task' : 'Add task'}</span>
    <button class="fg-modal-close" id="atd-close" title="Close without ${editing ? 'saving' : 'adding a task'}">✕</button>
  </div>
  <div class="fg-modal-body">
    <table style="width:100%;border-collapse:collapse;font-size:12px"><tbody>
      <tr><td style="${lbl}">Title</td><td><input class="settings-input" id="atd-title" type="text" style="${inp}" placeholder="Short imperative title"></td></tr>
      <tr><td style="${lbl}">Status</td><td><select class="settings-input" id="atd-status" style="${inp}">${statuses.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('')}</select></td></tr>
      <tr><td style="${lbl}">Priority</td><td><select class="settings-input" id="atd-priority" style="${inp}">${priorities.map(p => `<option ${p === curPrio ? 'selected' : ''}>${p}</option>`).join('')}</select></td></tr>
      <tr><td style="${lbl}">Description</td><td><textarea class="settings-input" id="atd-desc" rows="4" style="${inp};resize:vertical" placeholder="What to do and what done looks like"></textarea></td></tr>
      <tr><td style="${lbl}">Files</td><td>
        <div class="attach-wrap" style="display:inline-block">
          <button type="button" class="fg-modal-btn" id="atd-attach-btn" aria-haspopup="true" title="Attach files to this task: from the device, an upload, or the workspace" style="display:inline-flex;align-items:center;gap:6px">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>Attachments</button>
          <div class="attach-menu down" id="atd-attach-menu" role="menu">
            <button type="button" role="menuitem" id="atd-attach-device" title="Use the device's attachment sheet: camera, photo library, files">&#128247; Attach <span class="attach-menu-hint">camera / photos</span></button>
            <button type="button" role="menuitem" id="atd-attach-upload" title="Upload any file from this device">&#8679; Upload <span class="attach-menu-hint">any file</span></button>
            <button type="button" role="menuitem" id="atd-attach-ws" title="Pick files already in the workspace or synced folder">&#128193; Select <span class="attach-menu-hint">from workspace</span></button>
          </div>
          <input type="file" id="atd-file-device" multiple accept="image/*,audio/*,video/*">
          <input type="file" id="atd-file-any" multiple>
        </div>
        <div id="atd-attached" style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px"></div>
      </td></tr>
      <tr><td style="${lbl}">Criteria</td><td><textarea class="settings-input" id="atd-criteria" rows="3" style="${inp};resize:vertical" placeholder="Acceptance criteria, one per line"></textarea></td></tr>
    </tbody></table>
    <div id="atd-err" style="color:#c62828;font-size:11px;min-height:14px"></div>
  </div>
  <div class="fg-modal-btns">
    <button class="fg-modal-btn fg-modal-btn-cancel" id="atd-cancel" title="Close without ${editing ? 'saving' : 'adding a task'}">Cancel</button>
    <button class="fg-modal-btn fg-modal-btn-ok" id="atd-ok" title="${editing ? 'Write these changes to the task file' : 'Create the task file with these details and add it to the board'}">${verb}</button>
  </div>
</div>`;
    document.body.appendChild(overlay);
    const $ = (id: string) => overlay.querySelector('#' + id) as any;
    $('atd-close').onclick = $('atd-cancel').onclick = dismiss;
    const menu = $('atd-attach-menu');
    const renderAttached = () => {
        const box = $('atd-attached');
        box.textContent = '';
        for (const path of attached) {
            const chip = document.createElement('span');
            chip.className = 'file-chip';
            chip.title = path;
            chip.append((path.split('/').pop() || path) + ' ');
            const x = document.createElement('button');
            x.type = 'button'; x.textContent = '✕'; x.title = 'Remove this file from the task (the file itself is kept)';
            x.style.cssText = 'background:none;border:0;cursor:pointer;color:inherit;padding:0 2px';
            x.onclick = () => { attached.splice(attached.indexOf(path), 1); renderAttached(); };
            chip.appendChild(x);
            box.appendChild(chip);
        }
    };
    const addPaths = (paths: string[]) => { for (const p of paths) if (!attached.includes(p)) attached.push(p); renderAttached(); };
    const upload = async (input: HTMLInputElement) => {
        const files = [...(input.files || [])];
        input.value = '';
        for (const f of files) {
            // Each file holds a lease on the form: closed (Cancel, Clear, an import) before this file's turn or while it was being
            // stored, nothing is stored or kept (cases 236-239).
            const t = lease('task-upload', { node: overlay });
            if (!t.valid()) return;
            pendingUploads++;
            try {
                const path = await (window as any).saveFileToWorkspace(f);
                // An orphan unless the form was saved. The path is new (saveFileToWorkspace makes a unique folder), so it cannot
                // be a file the replacement project restored.
                t.onInvalid(() => { if (!saved) void agentDeleteFile?.(path).catch(() => {}); });
                if (!t.finish()) return;
                uploaded.add(path);
                addPaths([path]);
            } catch (e: any) {
                if (t.finish()) $('atd-err').textContent = `Failed to attach ${f.name}: ${e?.message || e}`;
            } finally { pendingUploads--; }
        }
    };
    $('atd-attach-btn').onclick = (e: Event) => { e.stopPropagation(); menu.classList.toggle('open'); };
    overlay.addEventListener('click', e => {
        if (!(e.target as HTMLElement).closest?.('.attach-wrap')) menu.classList.remove('open');
    });
    $('atd-attach-device').onclick = () => { menu.classList.remove('open'); $('atd-file-device').click(); };
    $('atd-attach-upload').onclick = () => { menu.classList.remove('open'); $('atd-file-any').click(); };
    $('atd-attach-ws').onclick = async () => {
        menu.classList.remove('open');
        addPaths(await (window as any).pickWorkspaceFiles('Attach files to the task'));
    };
    $('atd-file-device').onchange = (e: Event) => upload(e.target as HTMLInputElement);
    $('atd-file-any').onchange = (e: Event) => upload(e.target as HTMLInputElement);
    renderAttached();
    if (parsed) {
        $('atd-title').value = parsed.fm.title || parsed.heading;
        $('atd-desc').value = parsed.desc;
        $('atd-criteria').value = parsed.criteria.map(c => c.text).join('\n');
    }
    $('atd-title').focus();
    $('atd-ok').onclick = async () => {
        const title = $('atd-title').value.trim().replace(/\s+/g, ' ');
        if (!title) { $('atd-err').textContent = 'Title is required.'; return; }
        // A file still being stored is not in the list yet; saving now dropped it silently (cases 237/240).
        if (pendingUploads > 0) { $('atd-err').textContent = 'A file is still being attached. Save again when it has finished.'; return; }
        $('atd-ok').disabled = true;
        try {
            if (parsed && opts.path) {
                const stripBullet = (l: string) => l.trim().replace(/^[-*]\s*(\[[ x]\]\s*)?/, '');
                // The file may have changed since the dialog opened (another tab, the agent: status, ticked criteria, log lines). The
                // dialog only replaces what the user edited in it; everything else comes from the file as it is now.
                let latest = parsed;
                let nowText: unknown;
                try { nowText = await agentReadFile(opts.path); }
                catch (e: any) {
                    // A task that cannot be read now was deleted, or its project was cleared or replaced, since this form opened.
                    // Writing the form's old copy would bring it back (codex report 8, cases 217/235).
                    throw new Error(`${opts.path} can no longer be read (${e?.message || e}). It was probably deleted or its project was replaced, so nothing was saved.`);
                }
                if (typeof nowText === 'string' && nowText.replace(/\r\n/g, '\n') !== (opts.content || '').replace(/\r\n/g, '\n')) latest = parseTaskForEdit(nowText);
                const typedCriteria = $('atd-criteria').value.split('\n').map(stripBullet).filter(Boolean);
                const criteriaEdited = typedCriteria.join('\n') !== parsed.criteria.map(c => c.text).join('\n');
                const crit = criteriaEdited || latest === parsed ? typedCriteria : latest.criteria.map(c => c.text);
                const checked = new Set(latest.criteria.filter(c => c.checked).map(c => c.text));
                const descEdited = $('atd-desc').value.trim() !== parsed.desc.trim();
                const descOut = descEdited ? $('atd-desc').value.trim() : latest.desc.trim();
                const attachedOut = JSON.stringify(attached) !== JSON.stringify(parsed.attachments) ? attached : latest.attachments;
                // A title renamed elsewhere stays unless this form changed it too (case 218).
                const titleEdited = title !== (parsed.fm.title || parsed.heading).trim().replace(/\s+/g, ' ');
                const titleOut = titleEdited ? title : (latest.fm.title || latest.heading || title);
                const lines = setFmLines(latest.fmLines, {
                    title: titleOut,
                    priority: $('atd-priority').value === curPrio && latest.fm.priority ? latest.fm.priority : $('atd-priority').value,
                    updated: new Date().toISOString().slice(0, 10),
                });
                const out = `---\n${lines.join('\n')}\n---\n# ${titleOut}\n${descOut}\n## Acceptance Criteria\n`
                    + crit.map(c => `- [${checked.has(c) ? 'x' : ' '}] ${c}`).join('\n') + (crit.length ? '\n' : '')
                    + attachmentsBlock(attachedOut)
                    + (latest.rest || '## Log\n');
                await agentWriteFile(opts.path, out);
                saved = true;
                // A status change goes through the same gates as dragging the card to another column.
                const newStatus = $('atd-status').value;
                if (newStatus !== cur) {
                    const r = await transitionTask(opts.path, newStatus);
                    if (!r.transitioned) alert('Status change blocked: ' + (r.reason || 'QA gate blocked transition'));
                }
                overlay.remove();
                await syncLedgerWithTaskFiles();
                return;
            }
            const existing = await loadTaskFiles();
            const nextId = Math.max(0, ...existing.map(t => Number(t.fm.id) || 0),
                ...existing.map(t => Number((t.path.match(/\/(\d+)-/) || [])[1]) || 0)) + 1;
            const id = String(nextId).padStart(3, '0');
            const slug = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'task';
            const criteria = $('atd-criteria').value.split('\n').map((l: string) => l.trim().replace(/^[-*]\s*(\[[ x]\]\s*)?/, '')).filter(Boolean);
            const today = new Date().toISOString().slice(0, 10);
            const content = `${buildFrontmatter({ id, title, status: $('atd-status').value, priority: $('atd-priority').value, created: today })}# ${title}\n${$('atd-desc').value.trim()}\n## Acceptance Criteria\n${criteria.map((c: string) => `- [ ] ${c}`).join('\n')}\n${attachmentsBlock(attached)}## Log\n`;
            await agentWriteFile(`fg-tasks/${id}-${slug}.md`, content);
            saved = true;
            overlay.remove();
            await syncLedgerWithTaskFiles();   // new row in the ledger, then refresh the board
        } catch (e: any) {
            $('atd-err').textContent = `Failed to ${editing ? 'save' : 'add'} task: ` + (e?.message || e);
            $('atd-ok').disabled = false;
        }
    };
    overlay.addEventListener('keydown', e => { if (e.key === 'Escape') dismiss(); });
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
    // A ledger failure (e.g. a write error on a low-memory device) must not stop the board refresh.
    try { await rebuildLedger(); } catch (e) { console.warn('[ledger] rebuild failed:', e); }
    // Always refresh the board — rebuildLedger() returns early when there are no task
    // files and won't trigger refreshTasks() via agentWriteFile. The in-flight guard in
    // refreshTasks() collapses this into one render when agentWriteFile already fired one.
    await refreshTasks();
}

// Window bridge for classic scripts and inline handlers (ESM migration).
Object.assign(window, { openAddTaskDialog, openEditTaskDialog, moveTaskToColumn, loadTaskFiles, refreshTasks, syncLedgerWithTaskFiles });
