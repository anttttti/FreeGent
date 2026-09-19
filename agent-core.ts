// agent-core.js — FreeGent: checkpoints, input state, main send/abort/clear, textarea resize
// Depends on: config.js, chat-render.js, chat-state.js, llm-loops.js, chat-attachments.js
import { type AgentSession, defaultSession, workflowMode, activeChatId, mainAgentRole, setMainAgentRole, softStopPending, _lastTurnDoneToken, _lastTurnBlockedToken } from './state.js';
import { type TurnResult, type FinishSignal } from './types.js';
import { _BLOCKED_DECLARATION_RE } from './turn-protocol.js';
import { type RenderAdapter, NULL_RENDER_ADAPTER } from './render-adapter.js';
import { KEYS, chatKey, ckptKey } from './storage-keys.js';
import * as MsgQueue from './msg-queue.js';
import { registry } from './session-registry.js';
import { _stripTerminal } from './turn-protocol.js';
import { getActiveMainModelList, specHasKey } from './config.js';
import { getMessagesEl, appendMessage, renderMarkdown } from './chat-render.js';
import { generateAndShowSuggestion } from './prompt-suggest.js';
import { repairLedgerIfBroken, runPostTurnAgents } from './post-turn.js';

// Max binary-attachment size to include in a checkpoint snapshot (bytes).
// Larger binary files are excluded to keep localStorage usage bounded.
const _ATTACH_BINARY_MAX = 500_000;

// ── Input history for ↑/↓ recall ─────────────────────────────────────────
// Captures every rawText the user actually sends (never cleared by compaction).
// init.js reads this via window._userInputHistory instead of filtering openaiHistory,
// so recalled entries are always real user turns, not compact summaries.
const _userInputHistory: string[] = [];

// Max stored checkpoints — older entries are pruned when the list exceeds this.
const _CKPT_LIST_MAX = 50;

// Lazy singleton — Turndown loaded from CDN; falls back to innerText if not yet available.
function _htmlToMarkdown(elOrHtml: HTMLElement | string): string {
    if (TurndownService) {
        const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
        const html = typeof elOrHtml === 'string' ? elOrHtml : elOrHtml.innerHTML;
        return td.turndown(html);
    }
    // Fallback: plain text
    if (typeof elOrHtml === 'string') {
        const tmp = document.createElement('div'); tmp.innerHTML = elOrHtml;
        return tmp.innerText;
    }
    return elOrHtml.innerText || '';
}

// Read text from the contenteditable agent-input, converting any pasted/typed HTML to markdown.
function _readInputText(el: HTMLElement | null): string {
    if (!el) return '';
    // No rich formatting — return innerText directly (handles Chrome's Enter-div wrapping correctly).
    if (!/<(b|strong|i|em|s|del|code|pre|a|h[1-6]|blockquote|ul|ol|li)\b/i.test(el.innerHTML)) {
        return (el.innerText || '').trim();
    }
    return _htmlToMarkdown(el).trim();
}

// Set plain text on the contenteditable input without injecting HTML.
function _setInputText(el: HTMLElement, text: string): void {
    if (!el) return;
    el.innerText = text || '';
}



// ── Checkpoints ────────────────────────────────────────────────────────────

function saveCheckpoint(userText: string): string {
    const id   = Date.now().toString();
    const base = {
        openaiLen:   openaiHistory.length,
        provider:    getProvider(),
        model:       getActiveModel(),
        roleName:    (typeof mainAgentRole !== 'undefined') ? (mainAgentRole?.name ?? null) : null,
        userText,
    };
    // Capture attachments. Binary files >500 KB are omitted to avoid quota errors;
    // they will show as missing chips on rerun and need to be re-attached manually.
    const { images: _snapImages, files: _snapFiles } = getPendingAttachments();
    const images = _snapImages.map(img => ({ mimeType: img.mimeType, base64: img.base64 }));
    const files  = _snapFiles
        .filter(f => f.contentType === 'text' || f.size < _ATTACH_BINARY_MAX)
        .map(f => ({ name: f.name, mimeType: f.mimeType, contentType: f.contentType, content: f.content, size: f.size }));

    const _commit = data => {
        localStorage.setItem(ckptKey(id), JSON.stringify(data));
        // Re-read the list immediately before writing (minimises concurrent-tab overwrite window).
        // Skip if already present (idempotent under concurrent saves of the same checkpoint).
        const list: string[] = JSON.parse(localStorage.getItem(KEYS.CKPT_LIST) || '[]');
        if (!list.includes(id)) list.push(id);
        if (list.length > _CKPT_LIST_MAX)
            list.splice(0, list.length - _CKPT_LIST_MAX).forEach(old => localStorage.removeItem(ckptKey(old)));
        localStorage.setItem(KEYS.CKPT_LIST, JSON.stringify(list));
    };
    try {
        _commit({ ...base, images, files });
    } catch {
        try { _commit(base); } catch {}  // fallback: save without attachments if quota exceeded
    }
    return id;
}

async function _saveCheckpointSnapshot(ckptId: string): Promise<void> {
    if (!activeChatId || typeof saveCheckpointSnapshot !== 'function') return;
    try { await saveCheckpointSnapshot(activeChatId, ckptId); }
    catch (e) { console.warn('[checkpoint] snapshot failed:', e); }
}

// Takes a post-turn snapshot and, if files changed, appends a Diff button to the AI message.
async function _appendDiffButton(msgDiv: HTMLElement, chatId: string): Promise<void> {
    if (!chatId || typeof saveCheckpointSnapshot !== 'function' || typeof getCheckpointDiff !== 'function') return;
    const postCkptId = `post_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    try {
        await saveCheckpointSnapshot(chatId, postCkptId);
        const diff = await getCheckpointDiff(chatId, postCkptId);
        if (!diff || (!diff.idbDelta.length && !diff.localDelta.length)) return;
        const bubble = msgDiv.querySelector('.agent-msg-bubble');
        if (!bubble) return;
        // Append diff button to the action row that finalize() already created.
        // Set checkpointId on it now so delegation can find it after page reload.
        const row = (bubble.querySelector('.agent-turn-diff-row') as HTMLElement)
            ?? (() => {
                const r = document.createElement('div');
                r.className = 'agent-turn-diff-row';
                bubble.appendChild(r);
                return r;
            })();
        row.dataset.checkpointId = postCkptId; // persists in saved HTML so delegation survives reload
        const btn = document.createElement('button');
        btn.className = 'agent-ckpt-btn agent-turn-diff-btn';
        btn.dataset.action = 'diff';
        btn.textContent = '⊟ Diff';
        btn.title = 'Show file changes made this turn (workspace + local filesystem)';
        btn.onclick = () => showCheckpointDiff(postCkptId, chatId);
        row.appendChild(btn);
    } catch {}
}

// Drop session-log/raw-capture entries recorded at/after sinceMs so a
// Rewind/Rerun/Retry doesn't leave the old failed attempt's log trail sitting alongside
// the replacement — otherwise conversationLog/raw-captures only ever grow. Shared by
// applyCheckpoint (Rewind, Rerun) and retryLastTurn (the retry button).
function _pruneLogsFrom(sinceMs: number): void {
    if (!activeChatId || !Number.isFinite(sinceMs)) return;
    pruneConvoLogFrom?.(activeChatId, sinceMs);
    sessionPruneRawFrom?.(activeChatId, sinceMs);
}

async function applyCheckpoint(ckptId: string): Promise<boolean> {
    const raw = localStorage.getItem(ckptKey(ckptId));
    if (!raw) {
        // Checkpoint metadata was cleared (e.g. browser storage cleared, or >50 turns).
        // Show an in-chat notice rather than alert() which browsers may suppress silently.
        console.warn('[checkpoint] not found in localStorage:', ckptId);
        appendMessage?.('model', '<em style="color:var(--muted)">Checkpoint data no longer available — history context was cleared. You can still read the conversation above.</em>');
        return false;
    }
    const { openaiLen, roleName } = JSON.parse(raw);
    openaiHistory.length = openaiLen;
    lastUserMessageText  = '';
    // Checkpoint id is a Date.now() timestamp — see saveCheckpoint.
    _pruneLogsFrom(parseInt(ckptId, 10));
    // Restore the role active at checkpoint time so rerun starts from the right role.
    // roleName is null for pre-Agent-role checkpoints → fall back to Agent default.
    if (roleName) setMainAgentRole(roleName);
    else if (typeof clearMainAgentRole === 'function') clearMainAgentRole(); // restores Agent

    if (activeChatId && typeof restoreCheckpointWorkspace === 'function') {
        try {
            const { localFiles } = await restoreCheckpointWorkspace(activeChatId, ckptId);
            // Only offer local-file restore when a folder is actually synced via FSA.
            // Without an active FSA handle, writeFsaFile throws immediately and the
            // dialog's "Restore all" button appears to do nothing — the retry also
            // stalls if createWritable() hangs waiting for a browser permission prompt.
            const _canWriteLocal = typeof writeFsaFile === 'function'
                                && typeof hasLocalFolder === 'function' && hasLocalFolder();
            if (localFiles.length > 0 && _canWriteLocal) {
                const ok = await _confirmLocalRestore(localFiles.length);
                if (ok) {
                    // Parallel writes: don't let one stalled FSA handle block the rest.
                    await Promise.all(localFiles.map(async f => {
                        try {
                            if (f.content === null) { try { await deleteFsaFile(f.name); } catch {} }
                            else await writeFsaFile(f.name, f.content);
                        } catch {}
                    }));
                }
            }
            renderFileList?.();
        } catch (e) { console.warn('[checkpoint] workspace restore failed:', e); }
    }
    return true;
}

function _confirmLocalRestore(count: number): Promise<boolean> {
    if (localStorage.getItem(KEYS.CKPT_LOCAL_WARN_OK) === '1') return Promise.resolve(true);
    return new Promise(resolve => {
        const ov = document.createElement('div');
        ov.className = 'fg-modal-overlay';
        ov.innerHTML = `<div class="fg-modal fg-modal-sm">
            <div class="fg-modal-header"><span class="fg-modal-title">Restore local files?</span></div>
            <div class="fg-modal-body"><p>${count} local file(s) will be overwritten on your filesystem to match this checkpoint.</p>
            <label class="fg-modal-check-label"><input type="checkbox" id="fg-local-cb"> Don't show this again</label></div>
            <div class="fg-modal-btns">
                <button class="fg-modal-btn fg-modal-btn-cancel">Skip local files</button>
                <button class="fg-modal-btn fg-modal-btn-ok">Restore all</button>
            </div></div>`;
        document.body.appendChild(ov);
        (ov.querySelector('.fg-modal-btn-cancel') as HTMLElement).onclick = () => { ov.remove(); resolve(false); };
        (ov.querySelector('.fg-modal-btn-ok') as HTMLElement).onclick = () => {
            if ((ov.querySelector('#fg-local-cb') as HTMLInputElement).checked) localStorage.setItem(KEYS.CKPT_LOCAL_WARN_OK, '1');
            ov.remove(); resolve(true);
        };
    });
}

function _showSideBySideDiff(filename: string, oldContent: string, newContent: string): void {
    const _esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const oldLines = splitLines(oldContent);
    const newLines = splitLines(newContent);
    const regions  = diffRegions(oldLines, newLines);
    let rows = '';
    for (const r of regions) {
        if (r.type === 'eq') {
            for (let k = 0; k < r.baseEnd - r.baseStart; k++) {
                const i = r.baseStart + k, j = r.sideStart + k;
                rows += `<tr><td class="fg-sdiff-ln">${i+1}</td><td class="fg-sdiff-cell">${_esc(oldLines[i])}</td>`
                      + `<td class="fg-sdiff-ln">${j+1}</td><td class="fg-sdiff-cell">${_esc(newLines[j])}</td></tr>`;
            }
        } else if (r.type === 'del') {
            for (let i = r.baseStart; i < r.baseEnd; i++)
                rows += `<tr class="fg-sdiff-del"><td class="fg-sdiff-ln">${i+1}</td><td class="fg-sdiff-cell">${_esc(oldLines[i])}</td>`
                      + `<td class="fg-sdiff-ln"></td><td class="fg-sdiff-cell"></td></tr>`;
        } else if (r.type === 'ins') {
            for (let j = r.sideStart; j < r.sideEnd; j++)
                rows += `<tr class="fg-sdiff-ins"><td class="fg-sdiff-ln"></td><td class="fg-sdiff-cell"></td>`
                      + `<td class="fg-sdiff-ln">${j+1}</td><td class="fg-sdiff-cell">${_esc(newLines[j])}</td></tr>`;
        } else {
            const dLen = r.baseEnd - r.baseStart, iLen = r.sideEnd - r.sideStart;
            for (let k = 0; k < Math.max(dLen, iLen); k++) {
                const hasOld = k < dLen, hasNew = k < iLen;
                const i = r.baseStart + k, j = r.sideStart + k;
                rows += `<tr><td class="fg-sdiff-ln">${hasOld ? i+1 : ''}</td>`
                      + `<td class="fg-sdiff-cell${hasOld ? ' fg-sdiff-del-cell' : ''}">${hasOld ? _esc(oldLines[i]) : ''}</td>`
                      + `<td class="fg-sdiff-ln">${hasNew ? j+1 : ''}</td>`
                      + `<td class="fg-sdiff-cell${hasNew ? ' fg-sdiff-ins-cell' : ''}">${hasNew ? _esc(newLines[j]) : ''}</td></tr>`;
            }
        }
    }
    const ov2 = document.createElement('div');
    ov2.className = 'fg-modal-overlay';
    ov2.style.zIndex = '9100';
    ov2.innerHTML = `<div class="fg-modal fg-sdiff-modal"><div class="fg-modal-header"><span class="fg-modal-title">${_esc(filename)}</span><button class="fg-modal-close">✕</button></div><div class="fg-modal-body fg-sdiff-body"><table class="fg-sdiff-table"><thead><tr><th class="fg-sdiff-ln"></th><th class="fg-sdiff-hdr">Before</th><th class="fg-sdiff-ln"></th><th class="fg-sdiff-hdr">After</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
    (ov2.querySelector('.fg-modal-close') as HTMLElement).onclick = () => ov2.remove();
    ov2.addEventListener('click', e => { if (e.target === ov2) ov2.remove(); });
    document.body.appendChild(ov2);
}

async function showCheckpointDiff(ckptId: string, forChatId: string | null = null): Promise<void> {
    const chatId = forChatId ?? activeChatId;
    if (!chatId || typeof getCheckpointDiff !== 'function') return;
    const diff = await getCheckpointDiff(chatId, ckptId);
    const _sz  = n => n >= 1048576 ? `${(n/1048576).toFixed(1)}MB` : n >= 1024 ? `${(n/1024).toFixed(1)}KB` : `${n}B`;
    const _esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    let bodyHtml, all = [];
    if (!diff || (!diff.idbDelta.length && !diff.localDelta.length)) {
        bodyHtml = '<div class="fg-diff-empty">No workspace changes at this checkpoint.</div>';
    } else {
        all = [
            ...diff.idbDelta,
            ...diff.localDelta.map(f => ({ ...f, name: 'local/' + f.name })),
        ];
        const byOp = op => all.filter(f => f.op === op);
        const section = (label, cls, files) => {
            if (!files.length) return '';
            return `<div class="fg-diff-section"><div class="fg-diff-label ${cls}">${label} (${files.length})</div>`
                + files.map(f => {
                    const idx = all.indexOf(f);
                    const clickable = (f.op === 'modify' || f.op === 'add') ? ' fg-diff-file-clickable' : '';
                    const hint = f.op === 'modify' ? ' title="Double-click to view diff"' : f.op === 'add' ? ' title="Double-click to open file"' : '';
                    return `<div class="fg-diff-file${clickable}" data-idx="${idx}"${hint}>${_esc(f.name)}`
                        + (f.content != null ? ` <span class="fg-diff-size">${_sz(f.content.length)}</span>` : '')
                        + `</div>`;
                }).join('')
                + `</div>`;
        };
        bodyHtml = section('Added', 'fg-diff-add', byOp('add'))
                 + section('Modified', 'fg-diff-mod', byOp('modify'))
                 + section('Deleted', 'fg-diff-del', byOp('delete'));
    }

    const ov = document.createElement('div');
    ov.className = 'fg-modal-overlay';
    ov.innerHTML = `<div class="fg-modal"><div class="fg-modal-header"><span class="fg-modal-title">Workspace diff</span><button class="fg-modal-close">✕</button></div><div class="fg-modal-body">${bodyHtml}</div></div>`;
    (ov.querySelector('.fg-modal-close') as HTMLElement).onclick = () => ov.remove();
    ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
    ov.querySelectorAll('.fg-diff-file-clickable[data-idx]').forEach(el => {
        const f = all[+(el as HTMLElement).dataset.idx];
        if (!f) return;
        el.addEventListener('dblclick', e => {
            e.stopPropagation();
            if (f.op === 'modify') {
                _showSideBySideDiff(f.name, f.oldContent ?? '', f.content ?? '');
            } else if (f.op === 'add') {
                const fname = f.name.startsWith('local/') ? f.name.slice(6) : f.name;
                if (typeof openFileTab === 'function') openFileTab(fname);
                ov.remove();
            }
        });
    });
    document.body.appendChild(ov);
}

function pruneMessagesAfterCheckpoint(checkpointRow: HTMLElement): void {
    const msgs = getMessagesEl();
    if (!msgs) return;

    // Walk up to the direct child of msgs — handles checkpoints nested inside
    // agent-loop or other sub-containers (agentSend called with a container arg).
    // If checkpointRow is detached (createResponsePlaceholder moved it into the model
    // response div and removed it), find the model response div by checkpoint ID.
    let boundary: Element | null = msgs.contains(checkpointRow)
        ? checkpointRow
        : (() => {
            const id = checkpointRow.dataset.checkpointId;
            return id ? msgs.querySelector(`.agent-msg-model[data-checkpoint-id="${id}"]`) : null;
        })();
    if (!boundary) return;
    while (boundary.parentElement && boundary.parentElement !== msgs) {
        boundary = boundary.parentElement;
    }

    // Remove all direct children of msgs that come after the boundary.
    let el: Element | null = msgs.lastElementChild;
    while (el && el !== boundary) {
        const prev = el.previousElementSibling;
        el.remove();
        el = prev;
    }

    // Remove boundary and the user message that preceded it.
    const userMsgEl = boundary.previousElementSibling;
    if (boundary.parentNode) boundary.remove();
    if (userMsgEl?.parentNode) userMsgEl.remove();
}

async function rewindToCheckpoint(ckptId: string, checkpointRow: HTMLElement): Promise<void> {
    if (agentStreaming) { console.warn('[rewind] blocked — agent is still streaming'); return; }
    if (!await applyCheckpoint(ckptId)) return;
    pruneMessagesAfterCheckpoint(checkpointRow);
    saveHistory();
    updateTokenLabel();
    setInputState(true);
}

async function rerunCheckpoint(ckptId: string, checkpointRow: HTMLElement): Promise<void> {
    if (agentStreaming) { console.warn('[rerun] blocked — agent is still streaming'); return; }
    const raw = localStorage.getItem(ckptKey(ckptId));
    if (!raw) {
        console.warn('[checkpoint] not found in localStorage:', ckptId);
        appendMessage?.('model', '<em style="color:var(--muted)">Checkpoint data no longer available — cannot re-run this message.</em>');
        return;
    }
    const { userText, images = [], files = [] } = JSON.parse(raw);
    if (!userText && !images.length && !files.length) { console.warn('[checkpoint] no message content in checkpoint:', ckptId); return; }
    if (!await applyCheckpoint(ckptId)) return;
    pruneMessagesAfterCheckpoint(checkpointRow);
    saveHistory();
    updateTokenLabel();
    setInputState(true);
    // Restore attachments into the pending arrays so agentSend() picks them up
    clearImageAttachments();
    for (const img of images) addImageAttachment(img.mimeType, img.base64);
    for (const f of files)   restoreFileAttachment(f);
    const input = document.getElementById('agent-input') as HTMLTextAreaElement | null;
    if (input) { _setInputText(input, userText || ''); autoResizeTextarea(input); }
    agentSend();
}

function clearCheckpoints(): void {
    try {
        const list = JSON.parse(localStorage.getItem(KEYS.CKPT_LIST) || '[]');
        list.forEach(id => localStorage.removeItem(ckptKey(id)));
        localStorage.removeItem(KEYS.CKPT_LIST);
    } catch {}
}

window.rewindToCheckpoint  = rewindToCheckpoint;
window.rerunCheckpoint   = rerunCheckpoint;
window.showCheckpointDiff = showCheckpointDiff;

function appendCheckpointRow(ckptId: string, container: HTMLElement | null = null): HTMLElement {
    const row = document.createElement('div');
    row.className = 'agent-ckpt-row';
    row.dataset.checkpointId = ckptId;

    const rewindBtn = document.createElement('button');
    rewindBtn.className = 'agent-ckpt-btn'; rewindBtn.dataset.action = 'rewind';
    rewindBtn.textContent = '⏮ Rewind'; rewindBtn.title = 'Restore history to before this message';
    rewindBtn.onclick = (e) => { e.stopPropagation(); rewindToCheckpoint(ckptId, row); };

    const rerunBtn = document.createElement('button');
    rerunBtn.className = 'agent-ckpt-btn'; rerunBtn.dataset.action = 'rerun';
    rerunBtn.textContent = '↺ Rerun'; rerunBtn.title = 'Rewind and re-send this message';
    rerunBtn.onclick = (e) => { e.stopPropagation(); rerunCheckpoint(ckptId, row); };

    const modelLabel = document.createElement('span');
    modelLabel.className = 'agent-ckpt-model';
    try {
        const ckpt     = JSON.parse(localStorage.getItem(ckptKey(ckptId)) || '{}');
        const provider = ckpt.provider || getProvider();
        const model    = ckpt.model    || getActiveModel();
        // Worker spec is a "provider|model" string — keep it joined for brevity.
        const worker = ckpt.workerModel ? modelFriendlyName(ckpt.workerModel) : '';
        const modelPart = worker ? `${model} · ${worker}` : model;
        modelLabel.textContent = `${provider} · ${modelPart}`;
    } catch { modelLabel.textContent = getActiveModel(); }

    row.append(rewindBtn, rerunBtn, modelLabel);
    (container || getMessagesEl())?.appendChild(row);
    return row;
}

// ── Message editing ────────────────────────────────────────────────────────

function _pruneFromUserMsg(msgEl: HTMLElement): void {
    const msgs = getMessagesEl();
    if (!msgs) return;
    let boundary: Element | null = msgEl;
    while (boundary.parentElement && boundary.parentElement !== msgs) boundary = boundary.parentElement;
    if (!msgs.contains(boundary)) return;
    let el: Element | null = msgs.lastElementChild;
    while (el && el !== boundary) { const p = el.previousElementSibling; el.remove(); el = p; }
    boundary.remove();
}

async function _startEditUserMsg(msgEl: HTMLElement): Promise<void> {
    if (agentStreaming) return;
    const ckptId = msgEl.dataset.checkpointId;
    if (!ckptId) return;
    const raw = localStorage.getItem(ckptKey(ckptId));
    if (!raw) {
        appendMessage?.('model', '<em style="color:var(--muted)">Checkpoint expired — cannot edit this message.</em>');
        return;
    }
    const { userText = '' } = JSON.parse(raw);
    const bubble = msgEl.querySelector('.agent-msg-bubble') as HTMLElement | null;
    if (!bubble) return;
    const origHtml = bubble.innerHTML;

    // Lock the bubble at its current rendered height before we clear it.
    // Without this, replacing the rendered HTML with a plain-text textarea makes
    // the bubble shrink (plain text is shorter than rendered markdown with code
    // blocks, headers, etc.).  Setting minHeight preserves the visual space.
    const origHeight = bubble.offsetHeight;
    bubble.style.minHeight = origHeight + 'px';
    bubble.innerHTML = '';

    const ta = document.createElement('textarea');
    ta.className = 'msg-edit-textarea';
    ta.value = userText;
    // Auto-size: start at 'auto' so scrollHeight is the natural content height.
    ta.style.height = 'auto';
    requestAnimationFrame(() => {
        ta.style.height = ta.scrollHeight + 'px';
        ta.setSelectionRange(ta.value.length, ta.value.length);
        ta.focus();
    });
    ta.addEventListener('input', () => {
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
    });
    ta.addEventListener('click', e => e.stopPropagation());
    bubble.appendChild(ta);

    const btnRow = document.createElement('div');
    btnRow.className = 'msg-edit-btns';
    const saveBtn   = document.createElement('button');
    saveBtn.className = 'agent-ckpt-btn';
    saveBtn.textContent = '↑ Re-run';
    saveBtn.title = 'Save edit and re-run from here';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'agent-ckpt-btn';
    cancelBtn.textContent = 'Cancel';
    btnRow.append(saveBtn, cancelBtn);
    bubble.appendChild(btnRow);

    cancelBtn.onclick = (e) => {
        e.stopPropagation();
        bubble.style.minHeight = ''; // allow natural resize again
        bubble.innerHTML = origHtml;
    };

    const doSave = async () => {
        const newText = ta.value.trim();
        if (!newText) { ta.focus(); return; }
        // Update checkpoint with edited text
        try {
            const d = JSON.parse(localStorage.getItem(ckptKey(ckptId)) || '{}');
            d.userText = newText;
            localStorage.setItem(ckptKey(ckptId), JSON.stringify(d));
        } catch {}
        if (!await applyCheckpoint(ckptId)) return;
        _pruneFromUserMsg(msgEl);
        saveHistory();
        updateTokenLabel();
        setInputState(true);
        // Restore attachments stored in the checkpoint
        try {
            const d2 = JSON.parse(localStorage.getItem(ckptKey(ckptId)) || '{}');
            clearImageAttachments();
            for (const img of (d2.images || [])) addImageAttachment(img.mimeType, img.base64);
            for (const f of (d2.files || [])) restoreFileAttachment(f);
        } catch {}
        const inp = document.getElementById('agent-input') as HTMLTextAreaElement | null;
        if (inp) { _setInputText(inp, newText); autoResizeTextarea(inp); }
        agentSend();
    };

    saveBtn.onclick = (e) => { e.stopPropagation(); doSave(); };
    ta.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSave(); }
        if (e.key === 'Escape') { e.preventDefault(); cancelBtn.click(); }
    });
}

// ── Input state ────────────────────────────────────────────────────────────

function setInputState(enabled: boolean): void {
    const btn      = document.getElementById('agent-action-btn') as HTMLElement | null;
    const breakBtn = document.getElementById('agent-break-btn');
    const input    = document.getElementById('agent-input');
    if (btn) {
        btn.innerHTML = enabled
            ? `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5m0 0L5 12m7-7l7 7"/></svg>`
            : `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`;
        btn.title     = enabled ? 'Send (Enter)' : 'Stop now';
        btn.className = enabled ? 'send-btn send-btn-go' : 'send-btn send-btn-stop';
        btn.style.display = ''; // always show (stop always shown; send always shown for discoverability)
    }
    if (breakBtn) breakBtn.style.display = enabled ? 'none' : '';
    if (enabled) addVoiceButtons?.();
}

function _updateSendBtnVisibility(): void {
    const btn   = document.getElementById('agent-action-btn') as HTMLElement | null;
    const input = document.getElementById('agent-input') as HTMLElement | null;
    if (!btn || !btn.classList.contains('send-btn-go')) return;

    const hasModel = getActiveMainModelList().length > 0;

    // Always visible — hiding on empty input confused users into thinking send was broken.
    (btn as HTMLButtonElement).disabled = !hasModel;
    btn.title = hasModel ? 'Send' : 'No model configured — add one in Settings → Models';
    btn.style.opacity = hasModel ? '' : '0.35';

    if (input) {
        (input as HTMLElement).dataset.placeholder = hasModel
            ? 'Message…'
            : 'No model configured — open Settings → Models';
    }
}

// ── Input auto-resize (works for both textarea and contenteditable div) ────

function autoResizeTextarea(el: HTMLTextAreaElement): void {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

window._readInputText  = _readInputText;
window._setInputText   = _setInputText;
window._htmlToMarkdown = _htmlToMarkdown;

// ── Message queue ──────────────────────────────────────────────────────────────

// Re-render the WebUI queue panel whenever the queue changes, and auto-interrupt
// the current turn if the head of the queue is promoted to 'steering'.
MsgQueue.subscribe(() => {
    _renderQueuePanel();
    if (agentStreaming && MsgQueue.peek()?.mode === 'steering') {
        setSoftStopPending(true);
        activeAbortController?.abort();
    }
});

/** Rebuild the #msg-queue-panel DOM from current queue state (WebUI only). */
function _renderQueuePanel(): void {
    const panel = document.getElementById('msg-queue-panel');
    if (!panel) return;
    const items = MsgQueue.getAll();
    if (!items.length) { panel.style.display = 'none'; return; }
    panel.style.display = 'flex';
    panel.innerHTML = '';
    items.forEach((item, i) => {
        const row = document.createElement('div');
        row.className = `mq-item mq-${item.mode}`;

        // Mode badge — click to toggle steering ↔ queued
        const badge = document.createElement('button');
        badge.className = 'mq-badge';
        badge.title = item.mode === 'steering'
            ? 'Interrupts current turn — click to queue instead'
            : 'Waits for current turn — click to interrupt instead';
        badge.textContent = item.mode === 'steering' ? '⚡ Steer' : '⏎ Queue';
        badge.onclick = () => MsgQueue.setMode(item.id, item.mode === 'steering' ? 'queued' : 'steering');

        const txt = document.createElement('span');
        txt.className = 'mq-text';
        txt.textContent = item.text.length > 80 ? item.text.slice(0, 77) + '…' : item.text;

        const actions = document.createElement('span');
        actions.className = 'mq-actions';

        if (i > 0) {
            const up = document.createElement('button');
            up.className = 'mq-btn'; up.title = 'Move up'; up.textContent = '↑';
            up.onclick = () => MsgQueue.move(item.id, -1);
            actions.appendChild(up);
        }
        if (i < items.length - 1) {
            const dn = document.createElement('button');
            dn.className = 'mq-btn'; dn.title = 'Move down'; dn.textContent = '↓';
            dn.onclick = () => MsgQueue.move(item.id, 1);
            actions.appendChild(dn);
        }
        const del = document.createElement('button');
        del.className = 'mq-btn mq-cancel'; del.title = 'Cancel'; del.textContent = '✕';
        del.onclick = () => MsgQueue.cancel(item.id);
        actions.appendChild(del);

        row.appendChild(badge);
        row.appendChild(txt);
        row.appendChild(actions);
        panel.appendChild(row);
    });
}

/** Dequeue and send the next pending message, or interrupt if steering. */
async function _processQueue(): Promise<void> {
    if (agentStreaming) {
        // Already handled by the MsgQueue subscriber (auto-interrupt on steering head).
        return;
    }
    const msg = MsgQueue.shift();
    if (!msg) return;
    // A steer-interrupt sets softStopPending=true to abort the current turn; clear it so the
    // dequeued message actually runs instead of hitting the loop-entry guard in runTurn.
    setSoftStopPending(false);
    // Show a user-message bubble now that the queued message is actually being sent
    // (agentSend only enqueues the text; no bubble is appended at submit time).
    // Guard on getMessagesEl() returning a real element — it is null in TUI (JSDOM) and
    // appendMessage would throw trying to call .appendChild on null.
    const _qMsgsEl = getMessagesEl();
    if (_qMsgsEl) {
        const _bubble = appendMessage('user', renderMarkdown(msg.text));
        // Add ✎ edit button (same pattern as agentSend above).
        const _qEditBubble = _bubble.querySelector('.agent-msg-bubble') as HTMLElement | null;
        if (_qEditBubble) {
            const _qEditBtn = document.createElement('button');
            _qEditBtn.className = 'user-msg-edit-btn';
            _qEditBtn.dataset.action = 'edit-user-message';
            _qEditBtn.title = 'Edit message';
            _qEditBtn.textContent = '✎';
            _qEditBtn.addEventListener('click', (e: MouseEvent) => {
                e.stopPropagation();
                _startEditUserMsg?.(_bubble);
            });
            _qEditBubble.appendChild(_qEditBtn);
        }
    }
    // TUI side-effect: add the user message to the event log when it actually fires.
    window._onQueueDequeue?.(msg);
    try {
        await runAgentTurn(msg.text, null);
    } catch {
        // runAgentTurn catches and finalizes its own errors; nothing to surface here.
    }
}

// Task-intent detection (_isCompletionRequest) moved to turn-context.js, which owns
// per-turn trigger evaluation for both the interactive and headless entry points.

// ── Per-turn helpers ────────────────────────────────────────────────────────

// Reset per-turn bookkeeping. history is the conversation array for this session
// (openaiHistory for the default session, _s.history for isolated ones).
function _resetPerTurnState(history: any[]): void {
    if (history.length === 0) setReactiveFired(new Set());
    setFailureCounts({});
    setToolCallHistory([]);
}

// Shared teardown: clears placeholder/abort state, re-enables input.
// Pass the session object so its abortController field is also cleared.
function _tearDownTurn(session?: AgentSession): void {
    setActivePlaceholder(null);
    if (session) session.abortController = null;
    setActiveAbortController(null);
    setAgentStreaming(false);
    setInputState(true);
}

// Unified error handler for the turn catch block.
// Finalizes the placeholder, logs, and returns the display string.
function _handleTurnError(err: any, placeholder: RenderAdapter, logTag: string): string {
    if ((err as any).name === 'AbortError') {
        placeholder.finalize('*(stopped)*');
        return '*(stopped)*';
    }
    const msg = `**Error:** ${(err as any).message}`;
    console.error(`[${logTag}]`, err);
    placeholder.finalize(msg);
    return msg;
}

// Strip terminal escape sequences.
const _doStripTerminal = (text: string) => _stripTerminal(text);

// Fire-and-forget suggestion refresh. tag is used in the warning label.
function _fireSuggestion(tag: string): void {
    generateAndShowSuggestion().catch((e: any) => console.warn(`[suggest] ${tag}:`, e));
}

// ── Media routing helper ──────────────────────────────────────────────────

type _MediaRouting = {
    provider: string;
    mediaGeminiModel: string | null;
    mediaOAIEndpoint: { provider: string; model: string; url?: string; key?: string; proxy?: boolean } | null;
};

/**
 * Determine which provider/model should handle this turn based on attachment types.
 * Returns the (possibly overridden) provider, a Gemini model string if Google was
 * selected, or a custom-endpoint descriptor if an OAI-compat model was selected.
 */
function _resolveMediaRouting(
    defaultProvider: string,
    sendImages: any[],
    sendFiles: any[],
): _MediaRouting {
    let provider = defaultProvider;
    let mediaGeminiModel: string | null = null;
    let mediaOAIEndpoint: { provider: string; model: string; url?: string; key?: string; proxy?: boolean } | null = null;
    const _needed = new Set<string>();
    if (sendImages.length) _needed.add('image');
    sendFiles.filter((f: any) => f.contentType === 'binary').forEach((f: any) => {
        if (f.mimeType.startsWith('audio/'))  _needed.add('audio');
        if (f.mimeType.startsWith('video/'))  _needed.add('video');
        if (f.mimeType === 'application/pdf') _needed.add('pdf');
    });
    if (_needed.size && typeof getMediaCapableSpec === 'function') {
        const capSpec = getMediaCapableSpec([..._needed]);
        if (capSpec) {
            const bar = capSpec.indexOf('|');
            const capProvider = capSpec.slice(0, bar);
            const capModel    = capSpec.slice(bar + 1);
            provider = capProvider;
            if (capProvider === 'google') mediaGeminiModel = capModel;
            else mediaOAIEndpoint = specToEndpoint(capSpec);
        } else {
            // No capable model found — show a warning chip in the strip
            const _uncovered = [..._needed].filter(t => t !== 'pdf' && t !== 'file');
            if (_uncovered.length) {
                const strip = document.getElementById('img-strip');
                if (strip) {
                    const warn = document.createElement('div');
                    warn.className = 'file-chip media-warn-chip';
                    warn.title = `Add a ${_uncovered.join('/')} capable model to your model list (Gemini, Voxtral, etc.) or set one in Settings → Models → Media Model Routing`;
                    warn.textContent = `⚠ No ${_uncovered.join('/')} model — add Gemini or Voxtral`;
                    strip.appendChild(warn);
                    strip.style.display = 'flex';
                }
            }
        }
    }
    return { provider, mediaGeminiModel, mediaOAIEndpoint };
}

/**
 * Build and push the user turn's history message to `openaiHistory`.
 * Selects a multimodal content array when the active model supports audio/video/image,
 * or falls back to a plain text message annotating unsupported attachments.
 */
function _pushHistoryMessage(
    provider: string,
    mediaGeminiModel: string | null,
    mediaOAIEndpoint: _MediaRouting['mediaOAIEndpoint'],
    sendImages: any[],
    binaryFiles: any[],
    historyText: string,
): void {
    const _audioFiles = binaryFiles.filter((f: any) => f.mimeType.startsWith('audio/'));
    const _videoFiles = binaryFiles.filter((f: any) => f.mimeType.startsWith('video/'));
    const _otherBin   = binaryFiles.filter((f: any) => !f.mimeType.startsWith('audio/') && !f.mimeType.startsWith('video/'));

    // Resolve which media types are supported by the active model for this turn.
    let _supportsAudio = false, _supportsVideo = false;
    if (provider === 'google') {
        const _activeGeminiModel = mediaGeminiModel || getGeminiModel();
        const _googleEntry = getAllModels().find((m: any) => m.provider === 'google' && m.model === _activeGeminiModel);
        const _googleMedia = _googleEntry?.media || ['text'];
        _supportsAudio = _googleMedia.includes('audio');
        _supportsVideo = _googleMedia.includes('video');
    } else {
        // Only use input_audio / video_url content types for providers that implement
        // the OpenAI multimodal content-type spec. NVIDIA NIM, Groq, and Cerebras use
        // different API surfaces and silently drop unknown content types.
        const _OAI_MEDIA_PROVIDERS = new Set(['mistral', 'openrouter', 'custom', 'openai']);
        const _oaiSpec = mediaOAIEndpoint
            ? `${mediaOAIEndpoint.provider}|${mediaOAIEndpoint.model}`
            : (getActiveMainModelList()[0] || '');
        const _oaiEntry = getAllModels().find((m: any) => `${m.provider}|${m.model}` === _oaiSpec);
        const _oaiMedia = _oaiEntry?.media || ['text'];
        const _oaiProvider = (mediaOAIEndpoint ?? {}).provider || provider;
        _supportsAudio = _oaiMedia.includes('audio') && _OAI_MEDIA_PROVIDERS.has(_oaiProvider);
        _supportsVideo = _oaiMedia.includes('video') && _OAI_MEDIA_PROVIDERS.has(_oaiProvider);
    }

    const _modelLabel = provider === 'google' ? (mediaGeminiModel || getGeminiModel()) : provider;
    const _binaryNote = [
        ..._otherBin.map((f: any) => {
            const sz = _fmtSz(f.size);
            if (f.mimeType === 'application/pdf') return `[PDF attached: ${f.name}, ${sz}]`;
            return `[Binary file attached: ${f.name}, ${f.mimeType}, ${sz}]`;
        }),
        ...(!_supportsAudio ? _audioFiles.map((f: any) =>
            `[Audio attached: ${f.name}, ${_fmtSz(f.size)} — audio not supported by ${_modelLabel}]`
        ) : []),
        ...(!_supportsVideo ? _videoFiles.map((f: any) =>
            `[Video attached: ${f.name}, ${_fmtSz(f.size)} — video not supported by ${_modelLabel}]`
        ) : []),
    ].join('\n');

    const msgText = [_binaryNote, historyText].filter(Boolean).join('\n\n');
    const _hasNativeMedia = sendImages.length
        || (_supportsAudio && _audioFiles.length)
        || (_supportsVideo && _videoFiles.length);

    if (_hasNativeMedia) {
        const content: any[] = [];
        sendImages.forEach((img: any) => content.push({
            type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` }
        }));
        if (_supportsAudio) _audioFiles.forEach((f: any) => content.push({
            type: 'input_audio', input_audio: { data: f.content, format: _audioFmt(f.mimeType) }
        }));
        if (_supportsVideo) _videoFiles.forEach((f: any) => content.push({
            type: 'video_url', video_url: { url: `data:${f.mimeType};base64,${f.content}` }
        }));
        content.push({ type: 'text', text: msgText || 'Describe the attached content.' });
        openaiHistory.push({ role: 'user', content });
    } else {
        openaiHistory.push({ role: 'user', content: msgText || historyText });
    }
}

// ── Main send / abort / clear ──────────────────────────────────────────────

async function agentSend(container: HTMLElement | null = null): Promise<void> {
    if (agentStreaming) {
        // Agent busy — read text and enqueue as a pending message instead of sending now.
        const _qInput = document.getElementById('agent-input') as HTMLElement | null;
        const _qText  = _readInputText(_qInput);
        if (_qText) {
            MsgQueue.enqueue(_qText, 'queued');
            if (_qInput) { _qInput.innerHTML = ''; autoResizeTextarea(_qInput as any); }
        }
        return;
    }
    setSoftStopPending(false);
    _resetModelWarmup?.();
    clearSuggestion?.();

    let provider: string = getProvider();

    // Snapshot pending attachments early — used by media routing, early-return guard, and send.
    const { images: sendImages, files: sendFiles } = getPendingAttachments();

    // ── Media-capability routing ───────────────────────────────────────────
    // Check pending attachments before the key guard so we validate the right provider.
    const _routing = _resolveMediaRouting(provider, sendImages, sendFiles);
    provider = _routing.provider;
    let _mediaGeminiModel = _routing.mediaGeminiModel;
    let _mediaOAIEndpoint = _routing.mediaOAIEndpoint;

    // Key guard: check local key AND CF Worker shared key via specHasKey.
    // Pass provider-only spec (provider + '|') so specHasKey falls through to
    // provider-level checks without requiring a specific model name here.
    if (!specHasKey(provider + '|')) { showSettings(); return; }

    const input = document.getElementById('agent-input') as HTMLTextAreaElement | null;
    const rawText = _readInputText(input);
    if (!rawText && !sendImages.length && !sendFiles.length) return;

    // Slash command: detect /skill-name [args] and activate skill for this turn
    let text: string = rawText;

    // Reset reactive-trigger bookkeeping. _reactiveFired persists across turns within a task
    // (resets only when history is empty, i.e. at task/session start).  Once a skill fires as
    // either a turn-start prelude or a reactive nudge it won't re-inject in the same session —
    // the guidance is already in context.  Other counters reset each turn (per-turn health).
    _resetPerTurnState(openaiHistory);

    // Media attachment types present this turn (before clearImageAttachments()).
    const _msgMedia = new Set<string>();
    if (sendImages.length) _msgMedia.add('image');
    for (const f of sendFiles) {
        if (f.contentType === 'binary') {
            if (f.mimeType.startsWith('audio/'))  _msgMedia.add('audio');
            if (f.mimeType.startsWith('video/'))  _msgMedia.add('video');
            if (f.mimeType === 'application/pdf') _msgMedia.add('pdf');
        }
        if (f.contentType === 'text') _msgMedia.add('file');
    }

    // Skill triggers + tool-group gating — shared with runAgentTurn via turn-context.js so
    // headless runs evaluate exactly what the UI does.
    const _isFirstTurn = openaiHistory.length === 0;
    applyTurnTriggers({
        rawText,
        history:  openaiHistory,
        wsPaths:  await collectWorkspacePaths(),
        msgMedia: _msgMedia,
    });
    if (rawText.startsWith('/')) {
        const spaceIdx = rawText.indexOf(' ');
        const cmd = (spaceIdx === -1 ? rawText.slice(1) : rawText.slice(1, spaceIdx)).toLowerCase();
        if (cmd === 'model-update') {
            input.innerHTML = '';
            autoResizeTextarea(input);
            showModelUpdateModal?.();
            return;
        } else if (skillsRegistry.has(cmd)) {
            currentTurnSkills.add(cmd);
            text = spaceIdx === -1 ? `Invoke the /${cmd} skill.` : rawText.slice(spaceIdx + 1).trim();
        } else if (cmd === 'compact') {
            input.innerHTML = '';
            autoResizeTextarea(input);
            setAgentStreaming(true);
            setInputState(false);
            const _ph: RenderAdapter = workflowMode ? NULL_RENDER_ADAPTER : createResponsePlaceholder(container);
            setActivePlaceholder(_ph);
            setActiveAbortController(new AbortController());
            const ph = activePlaceholder;
            try {
                await compactHistory(ph);
                ph.finalize('Compacted.');
            } catch (e) {
                ph.finalize(`**Compaction error:** ${e.message}`);
                console.error('[compact]', e);
            }
            saveHistory();
            setActivePlaceholder(null);
            setActiveAbortController(null);
            setAgentStreaming(false);
            setInputState(true);
            input?.focus();
            return;
        }
    }

    const isFirstMessage = openaiHistory.length === 0;

    input.innerHTML = '';
    autoResizeTextarea(input);
    clearInputDraft?.();  // remove saved draft now that the message is sent
    lastUserMessageText = rawText;
    _currentUserIntent  = rawText; // used by intent validation in executeToolAsync
    if (rawText.trim()) _userInputHistory.push(rawText);
    setAgentStreaming(true);
    setInputState(false);

    // If the previous run for this chat was aborted or crashed (the run marker persists across
    // page reloads because cleanup never ran), prune its log entries before the new run starts.
    // This prevents the same failed attempt from accumulating repeatedly in sessionLogTurns.
    if (activeChatId) {
        const _prevRunCkpt = localStorage.getItem(chatKey.runCkpt(activeChatId));
        if (_prevRunCkpt) _pruneLogsFrom(parseInt(_prevRunCkpt, 10));
    }
    const ckptId = saveCheckpoint(rawText); // must come before clearImageAttachments
    // Mark this run as in-progress; cleared on completion so only crashed/aborted runs leave it set.
    if (activeChatId) localStorage.setItem(chatKey.runCkpt(activeChatId), ckptId);
    clearImageAttachments(); // clears both _pendingImages and _pendingFiles
    const _thumbsHtml = sendImages.map(img =>
        `<img src="data:${img.mimeType};base64,${img.base64}" class="chat-img-thumb" alt="image">`
    ).join('');
    const _fileChipsHtml = sendFiles.map(f =>
        `<span class="chat-file-chip">${_fileIcon(f.mimeType, f.name)} ${esc(f.name)}</span>`
    ).join('');
    const _attachHtml = [_thumbsHtml, _fileChipsHtml].filter(Boolean).join('');
    const _userMsgDiv = appendMessage('user', (_attachHtml ? _attachHtml + '<br>' : '') + (renderMarkdown ? renderMarkdown(rawText) : esc(rawText).replace(/\n/g, '<br>')), container);
    _userMsgDiv.dataset.checkpointId = ckptId;
    // Add a dedicated ✎ edit button inside the bubble (appears on hover, same as ⎘ copy).
    // Using a button avoids the copy-vs-edit event-propagation clash that a whole-bubble
    // click listener caused: the copy button's stopPropagation raced with the closest()
    // guard in unpredictable ways.  A button is unambiguous.
    const _editBubble = _userMsgDiv.querySelector('.agent-msg-bubble') as HTMLElement | null;
    if (_editBubble) {
        const _editBtn = document.createElement('button');
        _editBtn.className = 'user-msg-edit-btn';
        _editBtn.dataset.action = 'edit-user-message';
        _editBtn.title = 'Edit message';
        _editBtn.textContent = '✎';
        _editBtn.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            _startEditUserMsg(_userMsgDiv);
        });
        _editBubble.appendChild(_editBtn);
    }
    appendCheckpointRow(ckptId, container);
    await _saveCheckpointSnapshot(ckptId);

    // History is always in OAI format — no conversion needed when switching providers.
    repairOAIHistory();
    setLastProvider(provider);

    // Repair ledger before the agent runs so it starts from a clean state
    await repairLedgerIfBroken().catch(() => {});

    // Prepend keyword/role-triggered skill guidance to the message stored in history
    // (NOT the displayed bubble, which already used rawText above). This keeps the
    // system prompt stable for prefix caching and carries the guidance across all
    // tool-call steps of this turn. Always-on skills stay in the system prompt.
    // Build text-file attachment blocks (injected for all providers)
    const _attachText = sendFiles
        .filter(f => f.contentType === 'text')
        .map(f => {
            const lang = _LANG_MAP[f.name.split('.').pop()?.toLowerCase() || ''] || '';
            return `<file name="${f.name}">\n\`\`\`${lang}\n${f.content}\n\`\`\`\n</file>`;
        }).join('\n\n');

    // Guidance + memory/project context blocks (turn-context.js). Attached file names
    // enrich the semantic-recall query. Shared with runAgentTurn.
    const _prelude = await buildTurnPrelude({
        text,
        isFirstTurn: _isFirstTurn,
        fileNames:   sendFiles.map(f => f.name),
    });

    const historyText = [_prelude, _attachText, text].filter(Boolean).join('\n\n');

    const _binaryFiles = sendFiles.filter(f => f.contentType === 'binary');

    // History is always in OAI format. Media is stored as OAI content types
    // (image_url, input_audio, video_url) and sent directly to the OAI-compat endpoint.
    _pushHistoryMessage(provider, _mediaGeminiModel, _mediaOAIEndpoint, sendImages, _binaryFiles, historyText);

    const _ph: RenderAdapter = workflowMode ? NULL_RENDER_ADAPTER : createResponsePlaceholder(container);
    setActivePlaceholder(_ph);
    setActiveAbortController(new AbortController());
    const placeholder     = activePlaceholder;

    if (!mainAgentRole) setMainAgentRole('director');

    const _capturedChatId  = activeChatId;
    const _capturedMsgDiv  = placeholder.div;
    let _runCompleted = false;
    try {
        // When media routing redirects to a specialised model (audio/video/image),
        // suppress workspace tools — the model should just describe the media directly.
        // An explicit empty-Set toolFilterOverride is honoured by activeTools() regardless
        // of the active role, so no role change is needed here.
        const _mediaActive = !!((_mediaGeminiModel || _mediaOAIEndpoint));
        const _mediaToolFilter = _mediaActive ? new Set() : null;
        const _ep = provider === 'google'
            ? specToEndpoint(`google|${_mediaGeminiModel ?? getGeminiModel()}`)
            : (_mediaOAIEndpoint ?? null);
        const _histLenBefore = openaiHistory.length;
        let finalText = await runTurn(_ep, placeholder, { toolFilterOverride: _mediaToolFilter });

        placeholder.finalize(_doStripTerminal(finalText));
        _runCompleted = true;
    } catch (err) {
        // Roll back the user message pushed before the turn — failed/aborted turns
        // must leave no trace in history so the next attempt starts clean.
        {
            const last = openaiHistory[openaiHistory.length - 1];
            if (last?.role === 'user') openaiHistory.pop();
        }
        _handleTurnError(err, placeholder, 'agent');
    }

    // Await before saveHistory so the diff button is included in the saved HTML.
    // If fire-and-forget, the HTML snapshot captures the DOM before the button is appended,
    // causing the button to disappear after a page reload.
    await _appendDiffButton(_capturedMsgDiv, _capturedChatId).catch(() => {});

    // Clear the in-progress run marker only on successful completion; aborted/errored runs
    // leave it set so the next agentSend automatically prunes the stale log entries.
    if (_runCompleted && _capturedChatId) localStorage.removeItem(chatKey.runCkpt(_capturedChatId));

    try {
        updateChatMetaLastAt(activeChatId);
        saveHistory();
        if (isFirstMessage && activeChatId) autoNameChat(activeChatId, text);
    } finally {
        _tearDownTurn();
        input?.focus();
    }

    // Fire-and-forget post-turn agents (log review, memory, task extraction).
    runPostTurnAgents().catch(() => {});
    _fireSuggestion('post-turn');

    // Process next queued message (if any) after all synchronous post-turn work.
    setTimeout(() => _processQueue(), 0);
}

async function retryLastTurn(container: HTMLElement | null = null): Promise<void> {
    if (agentStreaming || !lastUserMessageText) return;
    const provider = getProvider();

    // Truncate to just after the last real user message
    {
        let i: number = openaiHistory.length - 1;
        while (i >= 0 && openaiHistory[i].role !== 'user') i--;
        if (i >= 0) openaiHistory.splice(i + 1);
    }
    // retryLastTurn has no checkpoint of its own, but agentSend() already created one
    // for the message being regenerated (saveCheckpoint, id = send timestamp) — the most
    // recent entry in fg_ckpt_list is that checkpoint, reused here as the prune anchor.
    let _regenCkptId: string | null = null;
    try {
        const _list = JSON.parse(localStorage.getItem(KEYS.CKPT_LIST) || '[]');
        _regenCkptId = _list[_list.length - 1] ?? null;
        _pruneLogsFrom(parseInt(_regenCkptId, 10));
    } catch {}
    // Mirror the run marker so a failed/aborted retry leaves the same trail that
    // agentSend's run-marker check will auto-prune on the next attempt.
    if (_regenCkptId && activeChatId) localStorage.setItem(chatKey.runCkpt(activeChatId), _regenCkptId);

    const msgs = getMessagesEl();
    if (msgs?.lastElementChild?.classList.contains('agent-msg-model'))
        msgs.lastElementChild.remove();

    setAgentStreaming(true);
    setInputState(false);
    const _ph: RenderAdapter = workflowMode ? NULL_RENDER_ADAPTER : createResponsePlaceholder(container);
    setActivePlaceholder(_ph);
    setActiveAbortController(new AbortController());
    const placeholder     = activePlaceholder;

    let _regenCompleted = false;
    try {
        const finalText = await runTurn(null, placeholder);
        placeholder.finalize(_doStripTerminal(finalText));
        _regenCompleted = true;
    } catch (err) {
        _handleTurnError(err, placeholder, 'agent');
    }

    if (_regenCompleted && activeChatId) localStorage.removeItem(chatKey.runCkpt(activeChatId));
    try {
        saveHistory();
    } finally {
        _tearDownTurn();
        if (!container) document.getElementById('agent-input')?.focus();
    }
    if (_regenCompleted) _fireSuggestion('retry');
}

function stopAfterStep(): void {
    setSoftStopPending(true);
    activeAbortController?.abort();
}

function stopNow(): void {
    setSoftStopPending(false);
    activeAbortController?.abort();
    setAgentStreaming(false);
    setInputState(true);
}

function handleSendButton(): void {
    if (agentStreaming) stopNow();
    else agentSend();
}

function createNewChat(): void {
    const id  = 'chat_' + Date.now();
    const now = Date.now();
    const list = getChatList();
    list.push({ id, name: 'New Chat', createdAt: now, lastAt: now });
    saveChatList(list);
    setActiveChatId(id);
    localStorage.setItem(KEYS.ACTIVE_CHAT, id);
    setOpenaiHistory([]);
    setLastProvider('');
    lastUserMessageText = '';
    if (typeof clearMainAgentRole === 'function') clearMainAgentRole();
    clearImageAttachments();
    // Cannot import clearSessionFallback/clearReplaceState directly — llm-loops.ts imports
    // agent-core.ts (circular). These calls go via the window bridge from llm-loops.ts.
    if (typeof clearSessionFallback === 'function') clearSessionFallback();
    if (typeof clearReplaceState   === 'function') clearReplaceState();
    // Reset tool filter so the new chat starts unclassified.
    setSessionToolFilter?.(null);
    const msgs = getMessagesEl();
    if (msgs) msgs.innerHTML = '';
    updateChatNameBar();
    updateRailRecentChats?.();
    updateTokenLabel();
    setInputState(true);
    // Clear the previous chat's stale suggestion immediately (shows blank),
    // then generate a fresh one for the new (empty) chat context.
    clearSuggestion?.();
    _fireSuggestion('new-chat');
}

function newChat(): void {
    if (agentStreaming) return;
    const hasHistory = openaiHistory.length > 0;
    if (!hasHistory) {
        const msgs = getMessagesEl();
        if (msgs) msgs.innerHTML = '';
        return;
    }
    saveHistory();
    createNewChat();
}

// Core turn driver: evaluate turn context, push prompt to history, call runTurn, return
// response text. No DOM reads or writes — callers supply the prompt directly and receive
// the response as a return value. This is the programmatic/headless entry point
// (benchmarks, TUI, agent-loop); agentSend() is the interactive wrapper that adds DOM
// input reading, attachments, and checkpoints. Both run the same per-turn evaluation via
// turn-context.js — see that module for why it has to be shared.
// `placeholder` lets a caller that already owns a render target reuse it across turns.
async function runAgentTurn(prompt: string, container: HTMLElement | null = null, session?: AgentSession,
                            { placeholder: _reusePh = null as RenderAdapter | null, forceToolCall = false } = {}): Promise<TurnResult> {
    const _s = session ?? defaultSession;

    // Reset reactive-trigger bookkeeping — see agentSend for rationale.
    _resetPerTurnState(_s.history);
    const _isFirstTurn = _s.history.length === 0;
    applyTurnTriggers({ rawText: prompt, history: _s.history, wsPaths: await collectWorkspacePaths() });
    const _prelude = await buildTurnPrelude({ text: prompt, isFirstTurn: _isFirstTurn });

    // increment turn counter and emit turn/start.
    const _evtSess = (_s as any)._session ?? registry.active();
    const _evtTurn = ((_s as any)._evtTurn ?? -1) + 1;
    (_s as any)._evtTurn = _evtTurn;
    const _t0Turn = Date.now();
    try {
        if (_evtSess) _evtSess.append('turn/start', { turn: _evtTurn, chatId: activeChatId ?? 'unknown' });
    } catch {}

    const _userContent = _prelude ? `${_prelude}\n\n${prompt}` : prompt;
    _s.history.push({ role: 'user', content: _userContent });
    // user/message event (after history push to match seq ordering).
    try {
        if (_evtSess) _evtSess.append('user/message', { role: 'user', content: _userContent }, { surfaceOp: 'append' } as any);
    } catch {}
    repairOAIHistory();

    const _ph: RenderAdapter = _reusePh
        ?? (_s.workflowMode ? NULL_RENDER_ADAPTER : createResponsePlaceholder(container));
    setActivePlaceholder(_ph);
    const _ctrl = new AbortController();
    _s.abortController = _ctrl;
    setAgentStreaming(true);
    setInputState(false);

    const placeholder = activePlaceholder;
    let finalText = '';
    let _turnEndReason: import('./session-event.ts').TurnEndReason = { kind: 'completed' };
    try {
        finalText = await runTurn(null, placeholder, { session: _s, forceToolCall });
        if (finalText === '*(break)*') _turnEndReason = { kind: 'soft-stop' };
        placeholder.finalize(_doStripTerminal(finalText));
    } catch (err) {
        const last = _s.history[_s.history.length - 1];
        if (last?.role === 'user') _s.history.pop();
        // also roll back the event-log user/message so the stale entry does
        // not create consecutive user messages in deriveMessages() on retry.
        // Mirrors the pop-tombstone pattern used by _replaceLastAssistantSurface —
        // content:null causes deriveMessages() to skip the event (session.ts:184).
        try {
            const _errLastSeq = _evtSess?.surface[_evtSess.surface.length - 1];
            if (_errLastSeq !== undefined && _evtSess?.events[_errLastSeq]?.type === 'user/message') {
                (_evtSess.append as any)('user/message',
                    { role: 'user', content: null },
                    { surfaceOp: { op: 'replace', start: _errLastSeq, end: _errLastSeq } });
            }
        } catch {}
        _turnEndReason = { kind: 'error', message: String((err as any)?.message ?? err) };
        finalText = _handleTurnError(err, placeholder, 'runAgentTurn');
    } finally {
        // emit turn/end regardless of how the turn finished.
        try {
            if (_evtSess) _evtSess.append('turn/end', { turn: _evtTurn, reason: _turnEndReason, durationMs: Date.now() - _t0Turn });
        } catch {}
    }

    try {
        saveHistory();
    } finally {
        _tearDownTurn(_s);
    }

    // Process next queued message after the turn fully tears down.
    setTimeout(() => _processQueue(), 0);

    // §4: build structured TurnResult. Read signal from module-level globals (the canonical
    // source post-turn for both defaultSession and dedicated sessions, since setLastTurnDoneToken
    // updates the global which defaultSession proxies, and dedicated sessions are single-threaded).
    const _finishSignal: FinishSignal =
        softStopPending              ? 'stopped'  :
        _lastTurnDoneToken           ? 'complete' :
        // _lastTurnBlockedToken: set in llm-loops before _stripTerminal removes "BLOCKED:" —
        // the only reliable way to detect a genuine model BLOCKED declaration at this point.
        // _BLOCKED_DECLARATION_RE on finalText catches _gracefulSynthesis returns (not stripped).
        _lastTurnBlockedToken        ? 'blocked'  :
        _BLOCKED_DECLARATION_RE.test(finalText) ? 'blocked' :
        'running';

    return {
        text:         finalText,
        finishSignal: _finishSignal,
        usage:        { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, // tokens tracked in runTurn; future §4 extension
        steps:        [],  // tool steps tracked in runTurn; future §4 extension
    };
}

// Window bridge for module consumers and inline handlers (ESM migration).
Object.assign(window, { _htmlToMarkdown, _readInputText, _setInputText, showCheckpointDiff, rewindToCheckpoint, rerunCheckpoint, clearCheckpoints, setInputState, _updateSendBtnVisibility, autoResizeTextarea, agentSend, runAgentTurn, retryLastTurn, stopAfterStep, stopNow, handleSendButton, createNewChat, newChat, _startEditUserMsg, msgQueue: MsgQueue, _userInputHistory });

// §7: named ES module exports alongside window bridge (headless / harness adapter paths).
export { runAgentTurn, stopNow, createNewChat };
