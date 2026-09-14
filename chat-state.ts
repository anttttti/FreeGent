// chat-state.js — FreeGent: chat list, history persistence, chat management UI
// Depends on: config.js, chat-render.js
import { KEYS, chatKey } from './storage-keys.js';

// ── Chat list helpers ──────────────────────────────────────────────────────

function getChatList() {
    try { return JSON.parse(localStorage.getItem(KEYS.CHAT_LIST) || '[]'); } catch { return []; }
}

function saveChatList(list) {
    localStorage.setItem(KEYS.CHAT_LIST, JSON.stringify(list));
    // Additive: also mirror to the session-store adapter (SQLite in daemon/headless mode).
    // No-op when no adapter is injected — behavior for plain browser mode is unchanged.
    sessionSyncChatList?.(list);
}

function fmtTime(ts) {
    if (!ts) return '';
    const d   = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return time;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
}

function updateChatMetaLastAt(id) {
    const list  = getChatList();
    const entry = list.find(c => c.id === id);
    if (entry) { entry.lastAt = Date.now(); saveChatList(list); }
}

function migrateOldStorage() {
    if (getChatList().length > 0) return;
    const hasOld = localStorage.getItem(KEYS.LEGACY_GH) || localStorage.getItem(KEYS.LEGACY_OH) || localStorage.getItem(KEYS.LEGACY_MSGS);
    if (!hasOld) return;
    const id  = 'chat_' + Date.now();
    const now = Date.now();
    localStorage.setItem(chatKey.gh(id),   localStorage.getItem(KEYS.LEGACY_GH)   || '[]');
    localStorage.setItem(chatKey.oh(id),   localStorage.getItem(KEYS.LEGACY_OH)   || '[]');
    localStorage.setItem(chatKey.msgs(id), localStorage.getItem(KEYS.LEGACY_MSGS) || '');
    saveChatList([{ id, name: 'Previous Chat', createdAt: now, lastAt: now }]);
    localStorage.setItem(KEYS.ACTIVE_CHAT, id);
    [KEYS.LEGACY_GH, KEYS.LEGACY_OH, KEYS.LEGACY_MSGS].forEach(k => localStorage.removeItem(k));
}

// ── Chat HTML persistence — server > IndexedDB > localStorage ─────────────
// Chat HTML snapshots are stored browser-side only: localStorage (synchronous, always current)
// and IndexedDB (durable, survives localStorage clear, no hard size limit).
// No data is sent to the local dev server.

const _IDB_NAME  = 'fg_msgs_store';
const _IDB_STORE = 'html';
let   _idb       = null;

function _openIDB() {
    if (_idb) return Promise.resolve(_idb);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(_IDB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(_IDB_STORE);
        req.onsuccess  = () => { _idb = req.result; resolve(_idb); };
        req.onerror    = () => reject(req.error);
    });
}

async function _idbPut(chatId, html) {
    try {
        const db = await _openIDB();
        await new Promise((resolve, reject) => {
            const tx  = db.transaction(_IDB_STORE, 'readwrite');
            tx.objectStore(_IDB_STORE).put(html, chatId);
            tx.oncomplete = resolve;
            tx.onerror    = () => reject(tx.error);
        });
        return true;
    } catch (e) { console.warn('[idb] put failed:', e); return false; }
}

async function _idbGet(chatId) {
    try {
        const db = await _openIDB();
        return await new Promise(resolve => {
            const tx  = db.transaction(_IDB_STORE, 'readonly');
            const req = tx.objectStore(_IDB_STORE).get(chatId);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror   = () => resolve(null);
        });
    } catch (e) { console.warn('[idb] get failed:', e); return null; }
}

async function _idbDelete(chatId) {
    try {
        const db = await _openIDB();
        await new Promise(resolve => {
            const tx = db.transaction(_IDB_STORE, 'readwrite');
            tx.objectStore(_IDB_STORE).delete(chatId);
            tx.oncomplete = resolve;
            tx.onerror    = resolve;
        });
    } catch {}
}

async function _saveHtml(chatId, html) {
    // Persist to IDB — durable local store with no hard size limit.
    // localStorage is written synchronously by saveHistory() before this is called.
    await _idbPut(chatId, html);
}

async function _loadHtml(chatId) {
    // localStorage first: written synchronously by saveHistory() so it always reflects the most
    // recent turn, even when the async IDB save was interrupted by a screen lock or browser suspension.
    const fromLs = localStorage.getItem(chatKey.msgs(chatId));
    if (fromLs) return fromLs;
    // IDB: durable fallback (survives localStorage clear, holds large snapshots).
    return await _idbGet(chatId) ?? null;
}

async function _deleteHtml(chatId) {
    await _idbDelete(chatId);
    localStorage.removeItem(chatKey.msgs(chatId));
}

// ── History persistence ────────────────────────────────────────────────────

function saveHistory() {
    if (!activeChatId) return;
    // A8: in headless/bench mode, SQLite (sessionSaveHistory) is authoritative.
    // Skip the localStorage JSON write and the DOM HTML snapshot — both are
    // browser-only concerns and wasteful/meaningless in a headless JSDOM environment.
    if (typeof workflowMode !== 'undefined' && workflowMode) {
        try { sessionSaveHistory?.(activeChatId, openaiHistory); } catch {}
        return;
    }
    // Browser UI path: write localStorage for fast reload access.
    try {
        let oh: string = JSON.stringify(openaiHistory);
        if (oh.length >= 3_500_000) {
            // Too large to persist whole. Persist a trimmed snapshot (first message +
            // recent tail starting on a user turn) instead of silently skipping the
            // save — skipping left a STALE history that restored as mysterious context
            // loss after reload. In-memory history is untouched.
            let tail: any[] = openaiHistory.slice(-Math.max(20, Math.floor(openaiHistory.length / 2)));
            while (tail.length && tail[0].role !== 'user') tail = tail.slice(1);
            const head = tail[0] === openaiHistory[0] ? [] : [openaiHistory[0]];
            oh = JSON.stringify([...head, ...tail]);
            console.warn(`[saveHistory] history exceeds 3.5MB — persisted trimmed snapshot (${head.length + tail.length}/${openaiHistory.length} msgs)`);
        }
        // Try to write; if quota exceeded, evict the oldest OTHER chat's history and retry once.
        const _lsSet = (key: string, val: string) => {
            try { localStorage.setItem(key, val); return true; } catch { return false; }
        };
        if (!_lsSet(chatKey.oh(activeChatId), oh)) {
            // Evict oldest chat histories (not the active one) to free space.
            const _allChats = getChatList();
            const _others = _allChats.filter((c: any) => c.id !== activeChatId)
                .sort((a: any, b: any) => (a.lastAt || 0) - (b.lastAt || 0));
            for (const old of _others) {
                localStorage.removeItem(chatKey.oh(old.id));
                localStorage.removeItem(chatKey.msgs(old.id));
                if (_lsSet(chatKey.oh(activeChatId), oh)) break;
            }
            // Last resort: save an even smaller snapshot (last 10 messages only)
            if (!localStorage.getItem(chatKey.oh(activeChatId))) {
                const _mini = openaiHistory.slice(-10);
                try { localStorage.setItem(chatKey.oh(activeChatId), JSON.stringify(_mini)); } catch {}
            }
        }
        // Additive: also persist the full (untrimmed) history to the session-store adapter.
        sessionSaveHistory?.(activeChatId, openaiHistory);
    } catch (e) { console.warn('[saveHistory] LLM history persist failed:', (e as any)?.message); }
    // Messages HTML — browser only (requires a real DOM element).
    try {
        const el = typeof getMessagesEl === 'function' ? getMessagesEl() : null;
        if (el) {
            const id   = activeChatId;
            const html = el.innerHTML;
            // Write to localStorage synchronously — same pattern as openaiHistory above.
            // This ensures the snapshot survives a screen-lock/browser-suspension that kills
            // the async server/IDB saves before they complete.
            if (html.length < 2_000_000) {
                try { localStorage.setItem(chatKey.msgs(id), html); } catch {}
            }
            // Fire-and-forget to server (no size limit) and IDB (durable, survives server restarts).
            _saveHtml(id, html).catch((e: any) => console.warn('[saveHistory] html save failed:', e?.message));
        }
    } catch {}
}

async function loadChatHistory(id: string): Promise<boolean> {
    try {
        // Try SQLite session store first (available when an adapter is injected).
        const sqliteHistory = await sessionLoadHistory?.(id);
        if (sqliteHistory && sqliteHistory.length > 0) {
            openaiHistory = sqliteHistory;
            return true;
        }
        // Fall back to localStorage (always written alongside SQLite via saveHistory()).
        const oh = localStorage.getItem(chatKey.oh(id));
        if (oh) { openaiHistory = JSON.parse(oh); return openaiHistory.length > 0; }
    } catch (e) { console.warn('[loadChatHistory] restore failed:', e?.message); }
    return false;
}

// Re-attach step-graph interactive handlers lost when HTML is serialised / deserialised.
// addEventListener listeners are never preserved in innerHTML; this restores them.
function _reattachStepGraphHandlers(msgs: HTMLElement) {
    // Re-attach tab button click handlers within any container that has .step-tabs /
    // .step-tab-content siblings (covers both .seq-agg-entry and .seq-detail-col shapes).
    function _reattachTabs(root: Element) {
        root.querySelectorAll<HTMLElement>('.step-tabs').forEach(tabsEl => {
            // .step-tab-content is the next sibling of the tabs' parent element
            // (.seq-agg-entry-row or .seq-col-header → sibling is .step-tab-content).
            const contentEl = tabsEl.parentElement?.nextElementSibling as HTMLElement | null;
            if (!contentEl || !contentEl.classList.contains('step-tab-content')) return;
            // Infer currently active tab from inline display style (survives serialisation).
            let active: string | null = null;
            contentEl.querySelectorAll<HTMLElement>('.step-content-pre').forEach(pre => {
                if (pre.style.display !== 'none') active = pre.dataset.tabName || null;
            });
            tabsEl.querySelectorAll<HTMLButtonElement>('.step-tab-btn').forEach(btn => {
                const name = btn.textContent || '';
                btn.addEventListener('click', e => {
                    e.stopPropagation();
                    if (active === name) {
                        // Toggle off — clicking the active tab deactivates it.
                        btn.classList.remove('step-tab-active');
                        contentEl.querySelectorAll<HTMLElement>('.step-content-pre').forEach(p => { p.style.display = 'none'; });
                        contentEl.style.display = 'none';
                        active = null;
                    } else {
                        tabsEl.querySelectorAll<HTMLElement>('.step-tab-btn').forEach(b => b.classList.remove('step-tab-active'));
                        contentEl.querySelectorAll<HTMLElement>('.step-content-pre').forEach(p => { p.style.display = 'none'; });
                        btn.classList.add('step-tab-active');
                        const pre = contentEl.querySelector<HTMLElement>(`.step-content-pre[data-tab-name="${name}"]`);
                        if (pre) { pre.style.display = ''; contentEl.style.display = ''; }
                        active = name;
                    }
                });
            });
        });
    }

    msgs.querySelectorAll<HTMLElement>('.agent-msg-model .agent-bubble').forEach(bubble => {
        // With the new layout, graph/agg rows live inline in the turn-collapse row;
        // graphDetailEl and aggDetail are direct children of the bubble.
        const turnCollapseRow = bubble.querySelector<HTMLElement>('.agent-turn-collapse-row');
        const turnCollapseBtn = turnCollapseRow?.querySelector<HTMLButtonElement>(':scope > .step-toggle');
        const graphRowEl    = turnCollapseRow?.querySelector<HTMLElement>('.seq-graph-row') ?? null;
        const graphDetailEl = bubble.querySelector<HTMLElement>('.seq-graph-detail') ?? null;
        const graphToggle   = graphRowEl?.querySelector<HTMLButtonElement>('.step-toggle') ?? null;
        const aggRowEl      = turnCollapseRow?.querySelector<HTMLElement>('.seq-agg-row') ?? null;
        const aggDetail     = bubble.querySelector<HTMLElement>('.seq-agg-detail') ?? null;
        const aggToggle     = aggRowEl?.querySelector<HTMLButtonElement>('.step-toggle') ?? null;

        // ── Turn collapse row ──────────────────────────────────────────────
        if (turnCollapseRow && (graphDetailEl || aggDetail)) {
            // Initialize from DOM state, not a hardcoded false.
            // createResponsePlaceholder() hides all previous turns' details and sets
            // the turn-collapse button to '▶' before starting a new turn. On reload,
            // _reattachStepGraphHandlers runs after the HTML is deserialized, so
            // collapsed=false would be wrong — first click would be a no-op, requiring
            // two clicks to expand. Derive the actual state from the button text.
            let collapsed = turnCollapseBtn?.textContent?.trim() === '▶';
            turnCollapseRow.addEventListener('click', e => {
                e.stopPropagation();
                collapsed = !collapsed;
                const targets = [graphDetailEl, aggDetail].filter(Boolean) as HTMLElement[];
                if (collapsed) {
                    targets.forEach(el => { if (el.style.display !== 'none') { el.dataset.chidden = '1'; el.style.display = 'none'; } });
                    if (turnCollapseBtn) turnCollapseBtn.textContent = '▶';
                } else {
                    targets.forEach(el => { if (el.dataset.chidden) { delete el.dataset.chidden; el.style.display = ''; } });
                    if (turnCollapseBtn) turnCollapseBtn.textContent = '▼';
                }
            });
        }

        // ── Step graph section — mutual exclusion with event log ───────────
        if (graphRowEl && graphDetailEl && graphToggle) {
            graphRowEl.addEventListener('click', e => {
                e.stopPropagation();
                const open = graphDetailEl.style.display === 'none';
                graphDetailEl.style.display = open ? '' : 'none';
                graphToggle.textContent = open ? '▼' : '▶';
                if (open && aggDetail && aggDetail.style.display !== 'none') {
                    aggDetail.style.display = 'none';
                    if (aggToggle) aggToggle.textContent = '▶';
                }
            });

            const graphEl    = graphDetailEl.querySelector<HTMLElement>('.seq-graph');
            const selectedEl = graphDetailEl.querySelector<HTMLElement>('.seq-selected-detail');
            const aggContent = aggDetail?.querySelector<HTMLElement>('.seq-agg-content');

            if (graphEl && selectedEl) {
                // Build title → aggEntry queue so we can match badges to event-log entries.
                // Both are created in the same step order; the [N] prefix in stepTitle makes
                // titles unique within a turn, so the match is exact even with duplicate roles.
                const _aggQueues = new Map<string, HTMLElement[]>();
                aggContent?.querySelectorAll<HTMLElement>('.seq-agg-entry').forEach(entry => {
                    const hdr   = entry.querySelector('.seq-agg-step-header');
                    // hdr firstChild is the stepTitle text node (model/time spans follow it).
                    const title = hdr?.firstChild?.textContent?.trim() || '';
                    if (!_aggQueues.has(title)) _aggQueues.set(title, []);
                    _aggQueues.get(title)!.push(entry);
                });

                let selectedBadge: HTMLElement | null = null;
                graphEl.querySelectorAll<HTMLElement>('.seq-task').forEach(badge => {
                    const labelEl  = badge.querySelector<HTMLElement>('.seq-task-label');
                    const stepTitle = labelEl?.textContent?.trim() || '';
                    // Consume from the queue so duplicate-titled steps map in order.
                    const aggEntry = _aggQueues.get(stepTitle)?.shift() || null;

                    badge.addEventListener('click', () => {
                        if (selectedBadge === badge) {
                            badge.classList.remove('seq-selected');
                            selectedEl.innerHTML = '';
                            selectedBadge = null;
                        } else {
                            if (selectedBadge) selectedBadge.classList.remove('seq-selected');
                            selectedEl.innerHTML = '';
                            if (aggEntry) {
                                // Show a clone of the event-log entry (same tab structure, same content).
                                const clone = aggEntry.cloneNode(true) as HTMLElement;
                                _reattachTabs(clone);
                                selectedEl.appendChild(clone);
                                requestAnimationFrame(() => selectedEl.scrollIntoView({ block: 'nearest' }));
                            }
                            badge.classList.add('seq-selected');
                            selectedBadge = badge;
                        }
                    });
                });
            }
        }

        // ── Event log section — mutual exclusion with step graph ───────────
        if (aggRowEl && aggDetail && aggToggle) {
            aggRowEl.addEventListener('click', e => {
                e.stopPropagation();
                const open = aggDetail.style.display === 'none';
                aggDetail.style.display = open ? '' : 'none';
                aggToggle.textContent = open ? '▼' : '▶';
                if (open && graphDetailEl && graphDetailEl.style.display !== 'none') {
                    graphDetailEl.style.display = 'none';
                    if (graphToggle) graphToggle.textContent = '▶';
                }
            });
            // Re-attach tab buttons within the preserved event-log entries.
            aggDetail.querySelectorAll<HTMLElement>('.seq-agg-entry').forEach(entry => _reattachTabs(entry));
        }
    });
}

async function restoreChatMessages(id) {
    try {
        const saved = await _loadHtml(id);
        if (!saved) return false;
        // If the active chat changed while the HTML was loading (e.g. user clicked
        // "+ New Chat" during the async fetch), discard the stale result so we don't
        // overwrite the now-current chat's empty UI with the old chat's messages.
        if (activeChatId !== id) return false;
        const msgs = getMessagesEl();
        if (!msgs) return false;
        msgs.innerHTML = saved;
        msgs.querySelectorAll('.seq-selected-detail').forEach(el => { el.innerHTML = ''; });
        msgs.querySelectorAll('.seq-live-detail').forEach(el => { el.innerHTML = ''; });
        msgs.querySelectorAll('.seq-task.seq-selected').forEach(el => el.classList.remove('seq-selected'));
        msgs.querySelectorAll('.seq-task.seq-running').forEach(el => { el.classList.remove('seq-running'); el.classList.add('seq-stopped'); });
        // Re-attach onclick handlers to checkpoint buttons — not preserved in serialized HTML.
        // Buttons may live in .agent-ckpt-row (workflowMode) or .agent-ckpt-group (normal flow,
        // where createResponsePlaceholder moves them into the model response div).
        msgs.querySelectorAll('.agent-ckpt-row, .agent-ckpt-group').forEach((row: Element) => {
            const ckptId = (row as HTMLElement).dataset.checkpointId;
            if (!ckptId) return;
            row.querySelectorAll('.agent-ckpt-btn').forEach((btn: Element) => {
                const b = btn as HTMLButtonElement;
                const action = b.dataset.action;
                if (action === 'rewind' || !action) {
                    b.onclick = (e) => { e.stopPropagation(); rewindToCheckpoint?.(ckptId, row); };
                } else if (action === 'rerun') {
                    b.onclick = (e) => { e.stopPropagation(); rerunCheckpoint?.(ckptId, row); };
                }
            });
        });
        // Re-attach click-to-edit listener on restored user message divs.
        msgs.querySelectorAll('.agent-msg-user[data-checkpoint-id]').forEach((el: Element) => {
            const msgEl = el as HTMLElement;
            msgEl.style.cursor = 'text';
            // Use onclick assignment (not addEventListener) — same pattern as checkpoint buttons
            // above; signals explicitly that no accumulation is possible on these elements.
            msgEl.onclick = () => _startEditUserMsg?.(msgEl);
        });
        // Re-attach step-graph interactive handlers (addEventListener is not serialised).
        _reattachStepGraphHandlers(msgs);
        msgs.scrollTop = msgs.scrollHeight;
        return true;
    } catch (e) { console.warn('[restoreChatMessages] failed:', e); }
    return false;
}

function clearChatStorage(id) {
    chatKey.all(id).forEach(k => localStorage.removeItem(k));
    _deleteHtml(id);
    sessionDeleteChat?.(id);
    // Do NOT call clearCheckpoints() here — it wipes ALL checkpoints across every chat,
    // breaking Rewind/Rerun in any chat that was loaded after a delete.
    // IDB checkpoint data is cleaned up per-chat via deleteCheckpointData.
    if (typeof deleteCheckpointData === 'function') deleteCheckpointData(id).catch(() => {});
}

function renderHistoryFallback() {
    const msgs = getMessagesEl();
    if (!msgs) return;
    const notice = document.createElement('div');
    notice.className = 'agent-history-notice';
    notice.textContent = '↩ Reconstructed from saved context.';
    msgs.appendChild(notice);
    const history = openaiHistory;
    for (const msg of history) {
        const role = msg.role === 'model' ? 'model' : msg.role;
        if (role === 'user' && typeof msg.content === 'string') {
            // Strip injected prefixes (skill guidance, handover context) so raw XML isn't shown.
            const cleaned = msg.content
                .replace(/^<active_guidance>[\s\S]*?<\/active_guidance>\n*/, '')
                .replace(/^<handover_context>[\s\S]*?<\/handover_context>\n*/, '')
                .replace(/<relevant_memory>[\s\S]*?<\/relevant_memory>\n*/, '');
            const noteMatch = cleaned.match(/^<nudge>([\s\S]*)<\/nudge>$/);
            if (noteMatch) {
                if (typeof getShowNudges === 'function' && getShowNudges()) {
                    emitNudge?.('history', noteMatch[1], { suppressHistory: true, suppressLog: true });
                }
            } else if (cleaned.startsWith('<tool_response>')) {
                // Text-tag tool-calling path's synthetic result message — raw JSON tool output,
                // not user input. Skip (it renders as noise).
            } else if (cleaned.trim()) {
                appendMessage('user', renderMarkdown ? renderMarkdown(cleaned) : esc(cleaned).replace(/\n/g,'<br>'));
            }
        }
        else if (role === 'assistant') {
            // Show any text content in the assistant message.
            if (typeof msg.content === 'string' && msg.content) {
                const t = cleanResponse(msg.content);
                if (t) { const el = appendMessage('model', renderMarkdown(t)); processImgSlots?.(el); }
            }
            // Show tool calls as a compact summary so the conversation thread is readable.
            if (msg.tool_calls?.length) {
                const _esc = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                const summaries = msg.tool_calls.map((tc: any) => {
                    const name = tc.function?.name ?? tc.name ?? '?';
                    let args = '';
                    try {
                        const parsed = JSON.parse(tc.function?.arguments ?? '{}');
                        // Show 1-2 key args inline; truncate the rest
                        const entries = Object.entries(parsed).slice(0, 2);
                        args = entries.map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`).join(', ');
                        if (Object.keys(parsed).length > 2) args += ', …';
                    } catch { args = (tc.function?.arguments ?? '').slice(0, 80); }
                    return `<span class="agent-history-tool-call">${_esc(name)}(${_esc(args)})</span>`;
                }).join(' ');
                const el = document.createElement('div');
                el.className = 'agent-msg agent-msg-model';
                el.innerHTML = `<div class="agent-msg-bubble agent-history-tool-row">${summaries}</div>`;
                msgs.appendChild(el);
            }
        } else if (role === 'model') {
            const parts = (msg.parts || []).filter((p: any) => p.text && !p.thought);
            if (parts.length) {
                const t = cleanResponse(parts.map((p: any) => p.text).join(''));
                if (t) { const el = appendMessage('model', renderMarkdown(t)); processImgSlots?.(el); }
            }
        }
        // role='tool' / 'function' results are skipped — they're raw JSON and add noise.
    }
    msgs.scrollTop = msgs.scrollHeight;
}

// ── Chat management ────────────────────────────────────────────────────────

function updateChatNameBar() {
    const el    = document.getElementById('chat-name-display');
    if (!el) return;
    const list  = getChatList();
    const entry = list.find(c => c.id === activeChatId);
    const name  = entry ? entry.name : 'New Chat';
    el.textContent = name;
    el.title       = name;
}

function setChatName(id, name) {
    const list  = getChatList();
    const entry = list.find(c => c.id === id);
    if (entry) { entry.name = name; saveChatList(list); }
    if (id === activeChatId) updateChatNameBar();
    renderChatsDropdown();
}

function promptRenameChat(id) {
    const list  = getChatList();
    const entry = list.find(c => c.id === id);
    const cur   = entry?.name || '';
    const next  = prompt('Rename chat:', cur);
    if (next !== null && next.trim()) setChatName(id, next.trim());
}

function startInlineRenameCurrentChat() {
    if (!activeChatId) return;
    const nameEl = document.getElementById('chat-name-display');
    if (!nameEl || nameEl.tagName === 'INPUT') return;
    const entry = getChatList().find(c => c.id === activeChatId);
    const currentName = entry?.name || nameEl.textContent;

    const input = document.createElement('input');
    input.type      = 'text';
    input.value     = currentName;
    input.className = 'chat-inline-rename';
    nameEl.parentNode.insertBefore(input, nameEl);
    nameEl.style.display = 'none';
    input.focus();
    input.select();

    let done: boolean = false;
    function commit() {
        if (done) return; done = true;
        const newName = input.value.trim();
        nameEl.style.display = '';
        input.remove();
        if (newName && newName !== currentName) setChatName(activeChatId, newName);
    }
    function cancel() {
        if (done) return; done = true;
        nameEl.style.display = '';
        input.remove();
    }
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', commit);
}

function deleteCurrentChat() {
    if (activeChatId) deleteChat(activeChatId);
}

function renderChatsDropdown() {
    const el = document.getElementById('chats-dropdown');
    if (!el) return;
    const list = getChatList().slice().reverse();
    el.innerHTML = '';

    // Search box + import button at the top of the list
    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--border)';
    const searchInput = document.createElement('input');
    searchInput.type = 'text'; searchInput.placeholder = 'Search chats…';
    searchInput.style.cssText = 'flex:1;font-size:13px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:var(--input-bg);color:var(--text);min-width:0';
    searchInput.id = 'chat-search-input';
    searchInput.oninput = () => _filterChatsDropdown(searchInput.value);
    const importBtn = document.createElement('button');
    importBtn.className = 'chat-act-btn'; importBtn.textContent = '⬆'; importBtn.title = 'Import chat JSON';
    importBtn.onclick = () => importChat();
    toolbar.append(searchInput, importBtn);
    el.appendChild(toolbar);

    if (!list.length) {
        el.innerHTML += '<div style="padding:10px 12px;color:var(--muted);font-size:13px">No saved chats</div>';
        return;
    }
    for (const chat of list) {
        const item = document.createElement('div');
        item.className = 'chat-list-item' + (chat.id === activeChatId ? ' current' : '');

        const info = document.createElement('div');
        info.className = 'chat-list-info';
        info.onclick   = () => { closeChatsDropdown(); activateTab?.('chat'); switchToChat(chat.id); };

        const nameEl = document.createElement('div');
        nameEl.className   = 'chat-list-name';
        nameEl.textContent = chat.name || 'Untitled Chat';

        const metaEl = document.createElement('div');
        metaEl.className = 'chat-list-meta';
        const parts = [];
        if (chat.createdAt) parts.push('Started ' + fmtTime(chat.createdAt));
        if (chat.lastAt && chat.lastAt !== chat.createdAt) parts.push('Last ' + fmtTime(chat.lastAt));
        metaEl.textContent = parts.join('  ·  ');

        info.append(nameEl, metaEl);

        const actions = document.createElement('div');
        actions.className = 'chat-list-actions';

        const renBtn = document.createElement('button');
        renBtn.className   = 'chat-act-btn';
        renBtn.textContent = '✏';
        renBtn.title       = 'Rename';
        renBtn.onclick     = e => { e.stopPropagation(); closeChatsDropdown(); promptRenameChat(chat.id); };

        const dlBtn = document.createElement('button');
        dlBtn.className   = 'chat-act-btn';
        dlBtn.textContent = '⬇';
        dlBtn.title       = 'Download JSON';
        dlBtn.onclick     = e => { e.stopPropagation(); exportChat(chat.id); };

        const mdBtn = document.createElement('button');
        mdBtn.className   = 'chat-act-btn';
        mdBtn.textContent = '📄';
        mdBtn.title       = 'Download Markdown';
        mdBtn.onclick     = e => { e.stopPropagation(); exportChatMarkdown(chat.id); };

        const delBtn = document.createElement('button');
        delBtn.className   = 'chat-act-btn chat-act-btn-del';
        delBtn.textContent = '🗑';
        delBtn.title       = 'Delete';
        delBtn.onclick     = e => { e.stopPropagation(); deleteChat(chat.id); };

        actions.append(renBtn, dlBtn, mdBtn, delBtn);
        item.append(info, actions);
        el.appendChild(item);
    }
    updateRailRecentChats();
}

// Render the 2 most recent chat titles directly in the left rail, below the Chats button.
function updateRailRecentChats() {
    const el = document.getElementById('rail-recent-chats');
    if (!el) return;
    const recent = getChatList().slice().reverse();
    el.innerHTML = '';
    for (const chat of recent) {
        const isActive    = chat.id === activeChatId;
        const isStreaming = isActive && agentStreaming;
        const btn = document.createElement('button');
        btn.className = 'rail-btn rail-recent-chat'
            + (isActive    ? ' active'    : '')
            + (isStreaming ? ' streaming' : '');
        btn.title = chat.name || 'Untitled Chat';
        btn.onclick = () => { closeChatsDropdown(); activateTab?.('chat'); switchToChat(chat.id); };
        const span = document.createElement('span');
        span.className = 'rail-label';
        span.textContent = chat.name || 'Untitled Chat';
        btn.appendChild(span);
        el.appendChild(btn);
    }
}

function toggleChatsDropdown() {
    const sidebar = document.getElementById('rail-sidebar');
    if (!sidebar) return;
    chatsDropdownOpen = !chatsDropdownOpen;
    if (chatsDropdownOpen) { renderChatsDropdown(); sidebar.classList.add('open'); }
    else                   { sidebar.classList.remove('open'); }
}

function closeChatsDropdown() {
    chatsDropdownOpen = false;
    document.getElementById('rail-sidebar')?.classList.remove('open');
}

async function switchToChat(id) {
    if (id === activeChatId || agentStreaming) return;
    saveHistory();
    activeChatId        = id;
    localStorage.setItem(KEYS.ACTIVE_CHAT, id);
    openaiHistory       = [];
    lastProvider        = '';
    lastUserMessageText = '';
    if (typeof clearMainAgentRole === 'function') clearMainAgentRole();
    if (typeof restoreRoleForChat === 'function') restoreRoleForChat(id);
    const msgs = getMessagesEl();
    if (msgs) msgs.innerHTML = '';
    const loaded   = await loadChatHistory(id);
    // Restore the per-chat turn log alongside the LLM history so the log viewer and exports
    // reflect the exact session history, not just what survived in the ephemeral sessionStorage.
    loadChatLog?.(id);
    const restored = await restoreChatMessages(id);
    // Guard: if another chat switch (or createNewChat) fired during the async restore,
    // this switchToChat is now stale — don't touch UI or state further.
    if (activeChatId !== id) return;
    if (!restored && loaded) renderHistoryFallback();
    updateChatNameBar();
    updateRailRecentChats();
    updateTokenLabel();
    setInputState(true);
    // Restore composer draft for this chat (set by init.ts _saveDraft)
    _restoreDraft?.(id);
}

function deleteChat(id) {
    const list = getChatList().filter(c => c.id !== id);
    saveChatList(list);
    clearChatStorage(id);
    if (id === activeChatId) {
        activeChatId = null;
        if (list.length > 0) {
            switchToChat(list[list.length - 1].id);
        } else {
            createNewChat();
        }
    }
    renderChatsDropdown();
}

// Three-band check for autoNameChat: reject model outputs that echo the instruction
// or are too long to be a real title.  Used by validateOutput (step-validator.ts).
const _NAME_ECHO_RE = /^(the (user|context|assistant|conversation|exchange|following)|this (is|seems|looks|session)|based on|since (there|the)|it (looks|seems|appears)|i (see|notice|would|think|can)|looking at|given the|from the|here'?s?|next message|we (need|have|should|can)|you (need|want|should)|to (predict|generate|output|complete|determine))/i;
const _NAME_CHECKS = [{
    name: 'meta-echo',
    re_pass: (t: string) => t.split(/\s+/).length <= 8 && !_NAME_ECHO_RE.test(t),
    re_fail: (t: string) => t.split(/\s+/).length > 8  ||  _NAME_ECHO_RE.test(t),
    llmPrompt: 'Is this text a meta-commentary or rephrasing of a task instruction rather than a proper short chat title? Answer YES if it is not a valid title.',
}];

async function autoNameChat(chatId, firstUserMessage) {
    if (!firstUserMessage || !chatId) return;
    // Immediately set a draft name from the first words — guarantees naming even if the API call fails.
    const draft = firstUserMessage.trim().replace(/\s+/g, ' ').split(' ').slice(0, 7).join(' ');
    setChatName(chatId, draft.length > 60 ? draft.slice(0, 60) + '…' : draft);

    if (typeof isUtilityDisabled === 'function' && isUtilityDisabled()) return;
    const msg = `Chat title (2-5 words, no punctuation): "${firstUserMessage.slice(0, 200)}"`;
    // Explicit utility endpoint: this is a lightweight UI call, not a worker/reasoning task.
    // Falls back to firstFreeEndpoint when no utility model is configured.
    const _uep = typeof utilityEndpoint === 'function' ? utilityEndpoint() : null;
    try {
        let name: string | null = await callLLMComplete(msg, { temperature: 0.3, maxTokens: 16, maxAttempts: 3, endpoint: _uep });
        if (name) {
            name = name.replace(/^["'\s]+|["'\s]+$/g, '').trim();
            if (name.length > 60) return; // definitely not a title
            // Three-band validation: fast regex for clear cases, LLM for ambiguous middle.
            const fired = typeof validateOutput === 'function'
                ? await validateOutput(name, _NAME_CHECKS, { llm: typeof callLLMComplete === 'function' ? callLLMComplete : null })
                : (_NAME_ECHO_RE.test(name) || name.split(/\s+/).length > 8) || null;
            if (!fired) setChatName(chatId, name);
        }
    } catch (e) { console.warn('[autoNameChat]', e.message); }
}

// ── Chat search (Cmd+K) ───────────────────────────────────────────────────

function _filterChatsDropdown(query: string) {
    const el = document.getElementById('chats-dropdown');
    if (!el) return;
    const q = query.trim().toLowerCase();
    const items = el.querySelectorAll('.chat-list-item');
    items.forEach((item: Element) => {
        const name = (item.querySelector('.chat-list-name') as HTMLElement | null)?.textContent ?? '';
        (item as HTMLElement).style.display = (!q || name.toLowerCase().includes(q)) ? '' : 'none';
    });
}

// Open the chats dropdown and focus the search box (Cmd/Ctrl+K).
function focusChatSearch() {
    if (!chatsDropdownOpen) {
        toggleChatsDropdown();
    }
    setTimeout(() => {
        const inp = document.getElementById('chat-search-input') as HTMLInputElement | null;
        inp?.focus();
        inp?.select();
    }, 30);
}

// ── Message content search ─────────────────────────────────────────────────

// Search all chat histories for messages containing `query`.
// Returns up to 30 results sorted newest-first with an HTML excerpt snippet.
function searchMessages(query: string): any[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const list = getChatList();
    const results: any[] = [];
    for (const chat of list) {
        const raw = localStorage.getItem(chatKey.oh(chat.id));
        if (!raw) continue;
        let history: any[];
        try { history = JSON.parse(raw); } catch { continue; }
        for (const msg of history) {
            const content = typeof msg.content === 'string' ? msg.content
                : Array.isArray(msg.content) ? msg.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join(' ')
                : '';
            if (!content) continue;
            const lower = content.toLowerCase();
            const idx = lower.indexOf(q);
            if (idx === -1) continue;
            const start = Math.max(0, idx - 60);
            const end   = Math.min(content.length, idx + q.length + 80);
            const raw   = (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '');
            // Highlight the match term in the excerpt
            const safeQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const excerptHtml = raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                .replace(new RegExp(safeQ, 'gi'), m => `<mark>${m}</mark>`);
            results.push({ chatId: chat.id, chatName: chat.name, role: msg.role, excerptHtml, lastAt: chat.lastAt ?? 0 });
            break; // one match per chat per search
        }
        if (results.length >= 30) break;
    }
    return results.sort((a, b) => b.lastAt - a.lastAt);
}

// ── Window bridge ─────────────────────────────────────────────────────────

// Window bridge for classic scripts and inline handlers (ESM migration).
Object.assign(window, { getChatList, saveChatList, updateChatMetaLastAt, migrateOldStorage, saveHistory, loadChatHistory, restoreChatMessages, renderHistoryFallback, updateChatNameBar, startInlineRenameCurrentChat, deleteCurrentChat, toggleChatsDropdown, closeChatsDropdown, switchToChat, autoNameChat, focusChatSearch, _filterChatsDropdown, searchMessages, updateRailRecentChats });

// Attach the inline-rename click handler programmatically so it works even if
// the inline onclick fires before the window bridge is seen by the browser.
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('chat-name-display')
        ?.addEventListener('click', startInlineRenameCurrentChat);
});
