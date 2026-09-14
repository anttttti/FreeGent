// init.js — FreeGent: DOMContentLoaded bootstrap, wires all modules together
// Depends on: all other modules (loaded last)
import { KEYS } from './storage-keys.js';

// ── Dark mode ─────────────────────────────────────────────────────────────
// data-theme is set by an inline <script> in <head> (before styles.css) to
// avoid FOUC.  _applyTheme() is still used by the toggle button and by the
// DOMContentLoaded handler which wires up the hljs stylesheet pair.

function _applyTheme(dark: boolean): void {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    // hljs theme sheets
    const hljsLight = document.getElementById('hljs-theme-light') as HTMLLinkElement | null;
    const hljsDark  = document.getElementById('hljs-theme-dark')  as HTMLLinkElement | null;
    if (hljsLight) hljsLight.disabled = dark;
    if (hljsDark)  hljsDark.disabled  = !dark;
    // toggle button: moon in light mode, sun in dark mode
    const btn  = document.getElementById('dark-mode-btn');
    const icon = document.getElementById('dark-mode-icon');
    if (btn)  btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    if (icon) icon.innerHTML = dark
        // sun icon
        ? '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>'
        // moon icon
        : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
}

function toggleDarkMode(): void {
    const isDark = document.documentElement.dataset.theme === 'dark';
    localStorage.setItem('fg_dark_mode', isDark ? '0' : '1');
    _applyTheme(!isDark);
}
// Expose at module level so onclick="toggleDarkMode()" works even if the
// DOMContentLoaded async handler hasn't finished yet (e.g. an await threw).
(window as any).toggleDarkMode = toggleDarkMode;

// ── Model warmup ──────────────────────────────────────────────────────────
let _warmupDone = false;
let _warmupTimer: ReturnType<typeof setTimeout> | null = null;

function _setWarmupDisplay(state: 'warming' | 'warmed' | 'none'): void {
    const wrap = document.querySelector('.hdr-model-display-wrap') as HTMLElement | null;
    if (!wrap) return;
    wrap.classList.remove('hdr-model-warming', 'hdr-model-warmed');
    if (state === 'warming') wrap.classList.add('hdr-model-warming');
    else if (state === 'warmed') wrap.classList.add('hdr-model-warmed');
}

function _resetModelWarmup(): void {
    if (_warmupTimer) { clearTimeout(_warmupTimer); _warmupTimer = null; }
    _warmupDone = false;
    _setWarmupDisplay('none');
}

async function _tryWarmupEndpoint(ep: any): Promise<boolean> {
    const systemPrompt: string = buildSystemPrompt?.() ?? '';
    try {
        if (!ep?.url) return false;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (ep.key) headers['Authorization'] = `Bearer ${ep.key}`;
        const tools = buildOAITools?.(false) ?? null;
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: '.' },
        ];
        const payload = buildChatPayload?.(ep, {
            messages, tools,
            temperature: getTemperature?.() ?? 0.6,
            maxTokens: 1, stream: false, thinkingBudget: 0,
        }) ?? { model: ep.model, messages, tools, max_tokens: 1, stream: false };
        const proxyUrl: string = ep.proxy ? (getLocalApiProxy?.() ?? '') : '';
        let resp: Response;
        if (proxyUrl) {
            resp = await fetch(proxyUrl, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: ep.url, method: 'POST', headers, body: JSON.stringify(payload) }),
                signal: AbortSignal.timeout(20000),
            });
        } else {
            resp = await fetch(ep.url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
        }
        return resp.ok;
    } catch {
        return false;
    }
}

async function _doModelWarmup(): Promise<void> {
    const list: string[] = getActiveMainModelList?.() ?? [];
    if (!list.length) return;

    _setWarmupDisplay('warming');
    for (const spec of list) {
        if ((getCooldownRemaining?.(spec) ?? 0) > 0) continue;
        const ep = specToEndpoint?.(spec);
        if (!ep) continue;
        // Only warm up endpoints that are known to cache the KV prefix — sending a
        // max_tokens:1 probe to a non-caching provider wastes quota with no benefit.
        // isCacheCapable returns true for custom/vllm (always) and for any provider+model
        // that previously returned cached_tokens > 0 in usage.  Unknown endpoints return
        // false and are skipped until a real conversation response confirms their capability.
        if (!(isCacheCapable as any)?.(ep)) continue;

        const ok = await _tryWarmupEndpoint(ep);
        if (ok) {
            _setWarmupDisplay('warmed');
            _warmupTimer = setTimeout(() => _setWarmupDisplay('none'), 5500);
            return;
        }
        _markFlatCooldown?.(ep);
        updateActiveModelDisplay?.();
    }
    _setWarmupDisplay('none');
}

document.addEventListener('DOMContentLoaded', async () => {
    await loadServerKeys(); // load env-var keys from Python server before anything else

    // Init IndexedDB session adapter — no COOP/COEP headers required.
    // Must run before getChatList() so the warmed localStorage is available immediately.
    await initIDBSession?.().catch((e: Error) => console.warn('[idb-session]', e.message));

    // Warm localStorage chat list from SQLite when SQLite has data but localStorage doesn't
    // (e.g. after clearing localStorage, or on first load after the migration).
    if (typeof sessionLoadChatList === 'function') {
        try {
            const sqliteChats = await sessionLoadChatList();
            if (sqliteChats.length > 0 && getChatList().length === 0) {
                localStorage.setItem(KEYS.CHAT_LIST, JSON.stringify(sqliteChats));
            }
        } catch {}
    }

    // Guard against module-timing races: if critical globals are missing on first load
    // (can happen when module scripts execute asynchronously), wait one tick and retry.
    const _critFns = ['migrateOldStorage', 'getChatList', 'setActiveChatId', 'createNewChat'];
    const _missing = _critFns.filter(fn => typeof (window as any)[fn] !== 'function');
    if (_missing.length) {
        await new Promise((r: any) => setTimeout(r, 50));
    }

    if (typeof migrateOldStorage === 'function') migrateOldStorage();

    // Init active chat
    const list = typeof getChatList === 'function' ? getChatList() : [];
    if (typeof setActiveChatId === 'function') setActiveChatId(localStorage.getItem(KEYS.ACTIVE_CHAT));
    if (!activeChatId || !list.find((c: any) => c.id === activeChatId)) {
        if (list.length > 0) {
            if (typeof setActiveChatId === 'function') setActiveChatId(list[list.length - 1].id);
            localStorage.setItem(KEYS.ACTIVE_CHAT, activeChatId);
        } else {
            if (typeof createNewChat === 'function') createNewChat();
        }
    }

    // Seed director role before restoring chat-specific overrides.
    // clearMainAgentRole() sets the director object; restoreRoleForChat() then switches
    // to a non-director role only when one was explicitly saved for this chat.
    if (typeof clearMainAgentRole === 'function') clearMainAgentRole();
    if (activeChatId) {
        const loaded   = await loadChatHistory(activeChatId);
        const restored = await restoreChatMessages(activeChatId);
        if (!restored && loaded) renderHistoryFallback();
        if (typeof restoreRoleForChat === 'function') restoreRoleForChat(activeChatId);
    }

    initChatEmpty?.();
    updateInputModelBtn?.();

    loadAgentsContext(); // pre-populate AGENTS.md context

    // Restore project name
    const _pname = localStorage.getItem(KEYS.PROJECT_NAME);
    const _pinput = document.getElementById('project-name-input') as HTMLInputElement | null;
    if (_pinput && _pname) _pinput.value = _pname;
    loadSkills();
    loadRoles();
    setupSkillAutocomplete();

    updateChatNameBar();
    updateModelLabel();
    updateActiveModelDisplay();
    updateTokenLabel();
    initHdrPicker();

    // Restore persisted mode (Chat / Cowork) into the toolbar select.
    if (typeof getMode === 'function') setMode?.(getMode());

    // Auto-save settings on any input/change inside the settings panel
    const settingsPanel = document.querySelector('.settings-panel-scroll');
    if (settingsPanel) {
        const autoSave = e => {
            if (!_settingsPopulating &&
                e.target.matches('input.settings-input, select.settings-input, input[name="provider"]'))
                saveSettings();
        };
        settingsPanel.addEventListener('change', autoSave);
        settingsPanel.addEventListener('input',  autoSave);
    }

    setupChatDropZone();
    setInputState(true);

    // Generate initial input suggestion (returning session or workspace already set).
    // Fires after history is restored so _buildContext() has exchange + chat list data.
    generateAndShowSuggestion?.().catch(() => {});

    // Geo cache: fetch once at startup, fire-and-forget (location skill uses the result).
    prefetchGeoCache?.().catch(() => {});

    // Pyodide: start unless user explicitly disabled it, OR the device is touch-only
    // (phone/tablet without mouse/keyboard).  On constrained hardware like iPad Air 1
    // (A5 chip, 512 MB RAM, iOS 12), loading a 52 MB Python/WASM runtime causes severe
    // memory pressure and triggers Safari's "Time limit" script-timeout dialog.
    // Touch-only check: has touch AND no hover capability (rules out hybrid laptops).
    // NOTE: navigator.maxTouchPoints is undefined on iOS ≤12 (Safari 13+ only),
    // so we intentionally omit it and rely solely on ontouchstart + hover media query.
    const _isTouchOnly = 'ontouchstart' in window
        && !window.matchMedia('(hover: hover)').matches;
    if (localStorage.getItem(KEYS.PYODIDE_AUTOLOAD) !== '0' && !_isTouchOnly) startPyodide();

    // Local bash: auto-detect server.py on localhost. Only probe when on localhost and not
    // already configured, so we don't clobber a deliberate 'none' choice from a previous session.
    if (['localhost', '127.0.0.1'].includes(window.location.hostname) &&
        !localStorage.getItem(KEYS.SANDBOX_PROVIDER)) {
        fetch('http://localhost:5000/api/execute', { method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ language: 'python', code: 'print(1)' }) })
            .then(r => { if (r.ok) {
                localStorage.setItem(KEYS.SANDBOX_PROVIDER, 'local');
                const sel = document.getElementById('sandbox-provider') as HTMLInputElement | null;
                if (sel) sel.value = 'local';
                onSandboxProviderChange?.();
            }})
            .catch(() => {});
    }

    // ── Mobile hamburger button ────────────────────────────────────────────
    // Injected by JS so it only appears when the @media query hides the rail.
    if (!document.getElementById('mobile-menu-btn')) {
        const mBtn = document.createElement('button');
        mBtn.id = 'mobile-menu-btn'; mBtn.textContent = '☰'; mBtn.title = 'Open menu';

        // Start in minimized state — icon strip visible, hamburger hidden
        const _initRail = document.querySelector('.left-rail') as HTMLElement | null;
        if (_initRail) {
            _initRail.classList.add('mobile-open');
            mBtn.style.display = 'none';
        }

        mBtn.onclick = () => {
            const rail = document.querySelector('.left-rail') as HTMLElement | null;
            if (!rail) return;
            // Open as full expanded overlay; hide the hamburger
            rail.classList.add('mobile-open', 'expanded');
            mBtn.style.display = 'none';
            // Tap outside the overlay → collapse to minimized icon strip
            const onOutside = (ev: MouseEvent) => {
                if (!rail.contains(ev.target as Node)) {
                    rail.classList.remove('expanded');
                    document.removeEventListener('click', onOutside, true);
                }
            };
            setTimeout(() => document.addEventListener('click', onOutside, true), 0);
        };
        document.body.appendChild(mBtn);
    }

    // ── Populate recent chats in the rail and expand it on desktop ───────────
    updateRailRecentChats?.();
    // On desktop: expand the left rail so the chat titles are visible by default.
    // The sliding Chats panel (rail-sidebar) stays closed until the user clicks Chats.
    if (window.innerWidth > 700) {
        document.getElementById('left-rail')?.classList.add('expanded');
    }

    // ── Input keydown — send, Tab-complete, ↑/↓ history recall, Cmd+K ────
    let _historyIdx = -1; // -1 = not navigating history

    const input = document.getElementById('agent-input');
    if (input) {
        // keypress is a fallback for mobile soft-keyboards that skip keydown on contenteditable
        input.addEventListener('keypress', e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); agentSend(); }
        });
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); agentSend(); }
            if (e.key === 'Tab' && !e.shiftKey) {
                const accepted = acceptSuggestion?.();
                if (accepted) { e.preventDefault(); autoResizeTextarea(input); _updateSendBtnVisibility?.(); }
            }

            // ↑ / ↓ to walk through previous user messages (only when input is empty).
            // Uses _userInputHistory (filled at send time) instead of openaiHistory so that
            // compaction — which rebuilds openaiHistory from scratch — never erases recall.
            if (e.key === 'ArrowUp' && !(input.textContent?.trim())) {
                e.preventDefault();
                const hist: string[] = (_userInputHistory ?? []);
                if (!hist.length) return;
                _historyIdx = Math.min(hist.length - 1, _historyIdx + 1);
                _setInputText?.(input, hist[hist.length - 1 - _historyIdx] ?? '');
                autoResizeTextarea(input);
                _updateSendBtnVisibility?.();
            }
            if (e.key === 'ArrowDown' && _historyIdx >= 0) {
                e.preventDefault();
                _historyIdx--;
                if (_historyIdx < 0) {
                    _setInputText?.(input, '');
                } else {
                    const hist: string[] = (_userInputHistory ?? []);
                    _setInputText?.(input, hist[hist.length - 1 - _historyIdx] ?? '');
                }
                autoResizeTextarea(input);
                _updateSendBtnVisibility?.();
            }
        });
        // Click/tap on the ghost text accepts the suggestion.
        // Ghost text is rendered by ::before, so we measure its pixel width with Canvas
        // and only accept if the click landed within the text span (+ 12 px touch slop).
        input.addEventListener('click', (e: MouseEvent) => {
            const suggestion = input.getAttribute('data-suggestion');
            if (!suggestion || input.textContent?.trim()) return;
            const cs  = window.getComputedStyle(input);
            const ctx = document.createElement('canvas').getContext('2d')!;
            // Match the ::before italic style exactly
            ctx.font = `italic ${cs.fontSize} ${cs.fontFamily}`;
            const textWidth   = ctx.measureText(suggestion).width;
            const paddingLeft = parseFloat(cs.paddingLeft) || 0;
            // offsetX is relative to the padding edge (MDN), so content starts at paddingLeft
            if (e.offsetX <= paddingLeft + textWidth + 12) {
                if (acceptSuggestion?.()) {
                    autoResizeTextarea(input);
                    _updateSendBtnVisibility?.();
                }
            }
        });

        input.addEventListener('input', () => {
            _historyIdx = -1; // typing resets history navigation
            autoResizeTextarea(input);
            _updateSendBtnVisibility?.();
            const hasText = (input.textContent?.trim() || '').length > 0;
            if (hasText) {
                input.removeAttribute('data-suggestion');
                if (!_warmupDone) { _warmupDone = true; _doModelWarmup(); }
            } else {
                _warmupDone = false;
            }
            // Draft save — debounced so rapid typing doesn't thrash localStorage
            if (_draftTimer) clearTimeout(_draftTimer);
            _draftTimer = setTimeout(_saveDraft, 400);
        });
        // On paste: strip inline styles/spans so only semantic formatting survives.
        input.addEventListener('paste', e => {
            const html = e.clipboardData?.getData('text/html');
            if (!html) return; // plain-text paste — let browser handle it
            e.preventDefault();
            const clean = html
                .replace(/ (style|class|id|data-[^=]*|on\w+)="[^"]*"/gi, '') // strip style/class/id + on* handler attrs (XSS)
                .replace(/<\/?span[^>]*>/gi, '')                         // unwrap spans
                .replace(/<(script|style|head|meta|link)[^>]*>[\s\S]*?<\/\1>/gi, ''); // drop noise tags
            document.execCommand('insertHTML', false, clean);
            autoResizeTextarea(input);
        });
    }

    // ── Global keyboard shortcuts ──────────────────────────────────────────
    document.addEventListener('keydown', e => {
        // Escape → stop generation
        if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey) {
            if (agentStreaming) { stopNow?.(); return; }
            // Also close message search if open
            if (document.getElementById('msg-search-modal')?.style.display !== 'none') {
                closeMsgSearch(); return;
            }
        }
        // Cmd/Ctrl+K → open chat search
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
            e.preventDefault();
            focusChatSearch?.();
        }
        // Cmd/Ctrl+Shift+F → open message content search
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'f') {
            e.preventDefault();
            openMsgSearch();
        }
    });

    // ── Jump-to-latest button ──────────────────────────────────────────────
    const _scrollLatestBtn = document.getElementById('scroll-to-latest');
    const _msgEl = document.getElementById('agent-messages');
    function _updateScrollBtn(): void {
        if (!_scrollLatestBtn || !_msgEl) return;
        // Two conditions must both be true to show the button:
        // 1. The user has actually scrolled away from the bottom (scrollTop > 0 in a
        //    bottom-growing list means there IS content above; the "away from bottom"
        //    distance is what matters for a bottom-anchored chat).
        // 2. There is a meaningful amount of content hidden below (> 40px), so the
        //    button isn't shown for a few stray padding pixels.
        const distFromBottom = _msgEl.scrollHeight - _msgEl.scrollTop - _msgEl.clientHeight;
        const canScrollDown  = distFromBottom > 40;
        _scrollLatestBtn.style.display = canScrollDown ? '' : 'none';
    }
    _msgEl?.addEventListener('scroll', _updateScrollBtn, { passive: true });
    // Re-evaluate when the messages container's content changes size (new chat clears
    // content, streaming adds messages, window resize changes clientHeight) — without
    // this, a stale "Latest" button stays visible after the content shrinks.
    if (typeof ResizeObserver !== 'undefined' && _msgEl) {
        new ResizeObserver(_updateScrollBtn).observe(_msgEl);
    }

    // ── Input draft preservation ───────────────────────────────────────────
    let _draftTimer: ReturnType<typeof setTimeout> | null = null;
    function _saveDraft(): void {
        const chatId = activeChatId;
        if (!chatId) return;
        const text = (input as HTMLElement)?.innerText?.trim() ?? '';
        if (text) localStorage.setItem(`fg_draft_${chatId}`, text);
        else localStorage.removeItem(`fg_draft_${chatId}`);
    }
    function _restoreDraft(chatId: string): void {
        const draft = chatId ? localStorage.getItem(`fg_draft_${chatId}`) : null;
        if (!draft || !input) return;
        _setInputText?.(input, draft);
        autoResizeTextarea?.(input);
        _updateSendBtnVisibility?.();
    }
    function clearInputDraft(chatId?: string): void {
        const id = chatId ?? activeChatId;
        if (id) localStorage.removeItem(`fg_draft_${id}`);
    }

    // Restore draft for the current chat on page load
    _restoreDraft(activeChatId);

    // ── Message content search ─────────────────────────────────────────────
    let _msgSearchIdx = -1;

    function openMsgSearch(): void {
        const modal = document.getElementById('msg-search-modal');
        if (!modal) return;
        modal.style.display = 'flex';
        const inp = document.getElementById('msg-search-input') as HTMLInputElement | null;
        inp?.focus();
        inp && (inp.value = '');
        const results = document.getElementById('msg-search-results');
        if (results) results.innerHTML = '';
        _msgSearchIdx = -1;
    }

    function closeMsgSearch(): void {
        const modal = document.getElementById('msg-search-modal');
        if (modal) modal.style.display = 'none';
    }

    function runMsgSearch(query: string): void {
        const results = document.getElementById('msg-search-results');
        if (!results) return;
        _msgSearchIdx = -1;
        if (!query.trim()) { results.innerHTML = ''; return; }
        const hits = searchMessages?.(query) ?? [];
        if (!hits.length) {
            results.innerHTML = `<div class="msg-search-empty">No results for "${_esc(query)}"</div>`;
            return;
        }
        results.innerHTML = hits.map((h: any, i: number) => `
            <div class="msg-search-result" role="option" data-chat-id="${h.chatId}" data-idx="${i}"
                 onclick="msgSearchSelect('${h.chatId}')" tabindex="-1">
                <div class="msg-search-result-chat">${_esc(h.chatName)}</div>
                <div class="msg-search-result-role">${_esc(h.role)}</div>
                <div class="msg-search-result-excerpt">${h.excerptHtml}</div>
                <div class="msg-search-result-date">${_fmtDate(h.lastAt)}</div>
            </div>`).join('');
    }

    function msgSearchKeydown(e: KeyboardEvent): void {
        const results = document.getElementById('msg-search-results');
        if (!results) return;
        const items = [...results.querySelectorAll('.msg-search-result')] as HTMLElement[];
        if (!items.length) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            _msgSearchIdx = Math.min(_msgSearchIdx + 1, items.length - 1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            _msgSearchIdx = Math.max(_msgSearchIdx - 1, 0);
        } else if (e.key === 'Enter' && _msgSearchIdx >= 0) {
            const item = items[_msgSearchIdx];
            if (item) msgSearchSelect(item.dataset.chatId ?? '');
            return;
        } else { return; }
        items.forEach((el, i) => el.setAttribute('aria-selected', String(i === _msgSearchIdx)));
        items[_msgSearchIdx]?.scrollIntoView({ block: 'nearest' });
    }

    function msgSearchSelect(chatId: string): void {
        if (!chatId) return;
        closeMsgSearch();
        if (chatId !== activeChatId)
            switchToChat?.(chatId);
    }

    function _esc(s: string): string {
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function _fmtDate(ts: number): string {
        if (!ts) return '';
        return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function scrollToLatest(): void {
        const msgs = document.getElementById('agent-messages');
        if (!msgs) return;
        msgs.scrollTop = msgs.scrollHeight;
        _updateScrollBtn();
    }

    // Apply saved theme now that DOM is ready (wires icon + hljs sheets)
    _applyTheme(localStorage.getItem('fg_dark_mode') === '1');

    // Expose to HTML onclick handlers and window bridge (chat-render.ts uses _updateScrollBtn)
    Object.assign(window, { scrollToLatest, _updateScrollBtn, openMsgSearch, closeMsgSearch, runMsgSearch, msgSearchKeydown, msgSearchSelect, clearInputDraft, _restoreDraft, toggleDarkMode });

    // Close model picker when clicking outside
    document.addEventListener('click', e => {
        const picker = document.getElementById('input-model-picker');
        if (picker?.classList.contains('picker-open')) {
            const btn = document.getElementById('input-model-btn');
            if (!btn?.contains(e.target as Node) && !picker.contains(e.target as Node))
                picker.classList.remove('picker-open');
        }
    });

    // Checkpoint + response-action event delegation — handles:
    //   .agent-ckpt-row  (workflowMode)
    //   .agent-ckpt-group (normal flow, inlined into the model response)
    //   .agent-turn-diff-row (per-turn action row: Copy + optional Diff)
    // data-action and data-checkpoint-id survive HTML serialization so onclick
    // properties that are lost after innerHTML restore are covered by this handler.
    getMessagesEl()?.addEventListener('click', e => {
        const btn = (e.target as Element).closest('.agent-ckpt-btn');
        if (!btn) return;
        const action = btn.getAttribute('data-action');

        // "Copy response" — doesn't need checkpoint data; reads the response text directly.
        if (action === 'copy-response') {
            const responseEl = btn.closest('.agent-msg-bubble')?.querySelector('.agent-response-text') as HTMLElement | null;
            if (!responseEl) return;
            navigator.clipboard.writeText(responseEl.innerText ?? '').then(() => {
                (btn as HTMLElement).textContent = '✓';
                setTimeout(() => { (btn as HTMLElement).textContent = '⎘'; }, 1500);
            }).catch(() => {});
            return;
        }

        // "Copy user message" — reads bubble text, excluding the copy button itself.
        if (action === 'copy-user-message') {
            const bubble = btn.closest('.agent-msg-bubble') as HTMLElement | null;
            if (!bubble) return;
            const clone = bubble.cloneNode(true) as HTMLElement;
            clone.querySelector('[data-action="copy-user-message"]')?.remove();
            navigator.clipboard.writeText(clone.innerText.trim()).then(() => {
                (btn as HTMLElement).textContent = '✓';
                setTimeout(() => { (btn as HTMLElement).textContent = '⎘'; }, 1500);
            }).catch(() => {});
            return;
        }

        const row    = btn.closest('.agent-ckpt-row') ?? btn.closest('.agent-ckpt-group') ?? btn.closest('.agent-turn-diff-row');
        const ckptId = (row as HTMLElement)?.dataset.checkpointId;
        if (!ckptId) return;
        if (action === 'rerun') rerunCheckpoint(ckptId, row as HTMLElement);
        else if (action === 'diff') showCheckpointDiff(ckptId);
        else rewindToCheckpoint(ckptId, row as HTMLElement);
    });

    // User-message edit button delegation — handles clicks after page reload.
    // The addEventListener attached in agent-core.ts is lost when the page is restored
    // from saved HTML; data-action="edit-user-message" on the button survives, so this
    // delegation re-implements the trigger.
    getMessagesEl()?.addEventListener('click', e => {
        const editBtn = (e.target as Element).closest('.user-msg-edit-btn[data-action="edit-user-message"]') as HTMLElement | null;
        if (!editBtn) return;
        const msgEl = editBtn.closest('.agent-msg-user') as HTMLElement | null;
        if (msgEl) (window as any)._startEditUserMsg?.(msgEl);
    });

    // Code-block copy button delegation — re-implements onclick that is lost after
    // innerHTML restore. The button sits immediately after its <pre> sibling.
    getMessagesEl()?.addEventListener('click', e => {
        const btn = (e.target as Element).closest('.code-copy-btn[data-action="copy-code"]') as HTMLElement | null;
        if (!btn) return;
        const pre = btn.previousElementSibling as HTMLElement | null;
        const code = pre?.querySelector('code') ?? pre;
        if (!code) return;
        navigator.clipboard.writeText(code.textContent ?? '').then(() => {
            btn.textContent = '✓ Copied';
            setTimeout(() => { btn.textContent = '⎘ Copy'; }, 1500);
        }).catch(() => {
            btn.textContent = '✗ Failed';
            setTimeout(() => { btn.textContent = '⎘ Copy'; }, 1500);
        });
    });

    // Step-tab delegation — addEventListener handlers are lost when innerHTML is restored.
    // Re-implements the same toggle logic using only DOM structure.
    getMessagesEl()?.addEventListener('click', e => {
        const btn = e.target.closest('.step-tab-btn');
        if (!btn) return;
        const msgs2     = getMessagesEl();
        const scrollTop = msgs2?.scrollTop ?? 0;
        const tabsEl    = btn.closest('.step-tabs');
        const contentEl = tabsEl?.parentElement?.nextElementSibling;
        if (!contentEl || !contentEl.classList.contains('step-tab-content')) return;
        const tabName  = btn.textContent;
        const isActive = btn.classList.contains('step-tab-active');
        tabsEl.querySelectorAll('.step-tab-btn').forEach(b => b.classList.remove('step-tab-active'));
        contentEl.querySelectorAll('.step-content-pre').forEach(p => { p.style.display = 'none'; });
        if (isActive) {
            contentEl.style.display = 'none';
        } else {
            btn.classList.add('step-tab-active');
            const pre = [...contentEl.querySelectorAll('.step-content-pre')].find(p => p.dataset.tabName === tabName);
            if (pre) pre.style.display = '';
            contentEl.style.display = '';
        }
        btn.blur();
        if (msgs2) msgs2.scrollTop = scrollTop;
    });

    // Step-toggle delegation — collapse/expand buttons for the turn graph and event log.
    // Graph/agg rows are now inline in the turn-collapse row; check them first since
    // they are nested inside .agent-turn-collapse-row and would match that selector too.
    getMessagesEl()?.addEventListener('click', e => {
        const btn = e.target.closest('.step-toggle');
        if (!btn) return;
        if (btn.closest('.seq-graph-row')) {
            // Step graph toggle — closes event log when opening.
            const bubble      = btn.closest('.agent-msg-bubble');
            if (!bubble) return;
            const graphDetail = bubble.querySelector('.seq-graph-detail') as HTMLElement | null;
            const aggDetail   = bubble.querySelector('.seq-agg-detail')   as HTMLElement | null;
            const aggToggle   = bubble.querySelector('.seq-agg-row .step-toggle') as HTMLElement | null;
            if (!graphDetail) return;
            const collapsed = graphDetail.style.display === 'none';
            graphDetail.style.display = collapsed ? '' : 'none';
            btn.textContent = collapsed ? '▼' : '▶';
            if (collapsed && aggDetail && aggDetail.style.display !== 'none') {
                aggDetail.style.display = 'none';
                if (aggToggle) aggToggle.textContent = '▶';
            }
        } else if (btn.closest('.seq-agg-row')) {
            // Event log toggle — closes step graph when opening.
            const bubble      = btn.closest('.agent-msg-bubble');
            if (!bubble) return;
            const aggDetail   = bubble.querySelector('.seq-agg-detail')   as HTMLElement | null;
            const graphDetail = bubble.querySelector('.seq-graph-detail') as HTMLElement | null;
            const graphToggle = bubble.querySelector('.seq-graph-row .step-toggle') as HTMLElement | null;
            if (!aggDetail) return;
            const collapsed = aggDetail.style.display === 'none';
            aggDetail.style.display = collapsed ? '' : 'none';
            btn.textContent = collapsed ? '▼' : '▶';
            if (collapsed && graphDetail && graphDetail.style.display !== 'none') {
                graphDetail.style.display = 'none';
                if (graphToggle) graphToggle.textContent = '▶';
            }
        } else if (btn.closest('.agent-turn-collapse-row')) {
            // Main turn collapse/expand — hides/shows both detail sections.
            const bubble = btn.closest('.agent-msg-bubble');
            if (!bubble) return;
            const collapsing = btn.textContent !== '▶';
            ['.seq-graph-detail', '.seq-agg-detail'].forEach(sel => {
                const el = bubble.querySelector(sel) as HTMLElement | null;
                if (!el) return;
                if (collapsing && el.style.display !== 'none') { el.dataset.chidden = '1'; el.style.display = 'none'; }
                else if (!collapsing && el.dataset.chidden) { delete el.dataset.chidden; el.style.display = ''; }
            });
            btn.textContent = collapsing ? '▶' : '▼';
        }
    });

    // Cleanup dangling checkpoint snapshots from deleted chats
    try {
        const validIds = getChatList().map(c => c.id);
        cleanupDanglingCheckpoints(validIds).catch(() => {});
    } catch {}

    // ── Suspension detection — log only, do NOT abort ─────────────────────────
    // When the tab is hidden (tab switch, OS sleep, phone lock), in-flight SSE
    // streams may be throttled or killed by the browser. The SSE idle timeout in
    // stream-decode.ts (90 s) will detect the dead connection and withRetry will
    // retry automatically — no intervention needed here.
    //
    // Previously this called stopNow() on restore, which aborted the whole turn.
    // That was wrong: switching tabs should have no effect on a running turn.
    let _hiddenAtMs = 0;
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            _hiddenAtMs = Date.now();
        } else {
            const hiddenMs   = Date.now() - _hiddenAtMs;
            const _lastChunk = _lastStreamChunkAt ?? 0;
            const streamDied = _lastChunk <= _hiddenAtMs;
            if (hiddenMs > 5_000 && streamDied && agentStreaming) {
                // Log for diagnostics; withRetry + SSE idle timeout handle the retry.
                console.info('[init] tab restored after', hiddenMs, 'ms — stream may have died, SSE idle timeout will retry if needed');
            }
        }
    });
});

function _onAttachFiles(input: HTMLInputElement): void {
    if (!input.files) return;
    for (const file of Array.from(input.files)) {
        if (typeof addFileAttachment === 'function') addFileAttachment(file);
    }
    input.value = '';
}

// Expose functions called from inline HTML onclick attributes.
// Only classic-script functions go here — ES module functions are already on
// window via their own bridges (config.js, llm-shared.js, workers.js, etc.).
Object.assign(window, {
    _resetModelWarmup,
    agentSend, handleSendButton, newChat, retryLastTurn, stopAfterStep,
    showSettings, saveSettings, switchSettingsTab,
    applyHdrSearch, applyHdrReasoning, applyHdrCompactTokens,
    updateActiveModelDisplay,
    renderModelCatalogTable, renderMainModelList,
    showAddCustomModelForm, addCustomModel, deleteCustomModel,
    _movePriorityItem, _removePriorityItem, _addPriorityItem,
    activateTab, openFileTab, closeFileTab, notifyLocalFileChanged,
    toggleChatsDropdown, startInlineRenameCurrentChat, deleteCurrentChat,
    refreshTasks,
    loadSkills, toggleSkill, installSkillFromFiles, renderSkillsChecklist, renderToolsChecklist,
    switchSkillSubtab, createSkillFromForm, createRuleFromForm,
    toggleAutopilot, stopAutopilot,
    saveAgentSetting,
    renderProfilesTab, profileSaveCurrent, profileDelete, profileDownload, profileUpload, profilePreview,
    addFileAttachment, _onAttachFiles,
    saveMediaModel, renderMediaModelSelectors,
    toggleVoiceInput, speakText, stopSpeaking, addVoiceButtons,
    saveVoiceSettings, populateVoiceTab,
    _addVoiceItem, _removeVoiceItem, _moveVoiceItem,
});
