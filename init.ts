// init.js — FreeGent: DOMContentLoaded bootstrap, wires all modules together
// Depends on: all other modules (loaded last)
import { sanitizePastedHtml } from './paste-sanitize.js';
import { installPassHeader, installPrivacyGuard } from './proxy.js';
import { getPrivacyLevel } from './privacy.js';
import { installDevLog } from './dev-log.js';
import { KEYS, chatKey } from './storage-keys.js';
import { escapeHtml } from './html-escape.js';
import { lease, revokeLeases } from './lease.js';

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
// Sidebar Privacy button: a menu of the three levels (privacy.ts); the choice is the same as Settings → Privacy.
function _closePrivacyMenu(): void {
    const m = document.getElementById('privacy-menu'), b = document.getElementById('privacy-btn');
    if (m) m.hidden = true;
    if (b) b.setAttribute('aria-expanded', 'false');
}
function togglePrivacyMenu(ev?: Event): void {
    ev?.stopPropagation();
    const m = document.getElementById('privacy-menu'), b = document.getElementById('privacy-btn');
    if (!m || !b) return;
    if (!m.hidden) { _closePrivacyMenu(); return; }
    (window as any)._applyPrivacyLevelUI?.(getPrivacyLevel());
    const r = b.getBoundingClientRect();
    m.hidden = false;
    m.style.left = `${Math.round(r.right + 8)}px`;
    m.style.top = `${Math.max(8, Math.round(Math.min(r.bottom - m.offsetHeight, window.innerHeight - m.offsetHeight - 8)))}px`;
    b.setAttribute('aria-expanded', 'true');
}
function pickPrivacyLevel(level: string): void {
    _closePrivacyMenu();
    (window as any).onPrivacyLevelChange?.(level);
}
document.addEventListener('click', e => { if (!(e.target as Element)?.closest?.('#privacy-menu, #privacy-btn')) _closePrivacyMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') _closePrivacyMenu(); });
(window as any).togglePrivacyMenu = togglePrivacyMenu;
(window as any).pickPrivacyLevel = pickPrivacyLevel;

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

installDevLog();   // capture errors/warnings from the start; sends only while a Developer key is saved

document.addEventListener('DOMContentLoaded', async () => {
    installPassHeader();
    installPrivacyGuard();
    await loadServerKeys(); // load env-var keys from Python server before anything else
    // Query the CF Worker for shared provider keys (non-blocking — re-renders model lists when done)
    loadCfWorkerKeys?.().catch(() => {});

    // Init IndexedDB session adapter — no COOP/COEP headers required.
    // Must run before getChatList() so the warmed localStorage is available immediately.
    await initIDBSession?.().catch((e: Error) => console.warn('[idb-session]', e.message));
    // Move turn logs, raw captures and checkpoint attachments that older versions kept in
    // localStorage into IndexedDB (background; readers fall back to localStorage meanwhile).
    sessionMigrateLocalStorage?.().catch((e: Error) => console.warn('[idb-session] migration:', e.message));
    migrateCheckpointAttachments?.().catch((e: Error) => console.warn('[checkpoint] migration:', e.message));

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
        const endLoad = beginChatLoad(activeChatId);   // no Send, and no save of the still-empty history, until the chat is restored
        try {
            // The saved markup is drawn first; the history read from the session store (slow while it opens) runs meanwhile.
            const historyP = loadChatHistory(activeChatId);
            const restored = await restoreChatMessages(activeChatId);
            const loaded   = await historyP;
            if (!restored && loaded) renderHistoryFallback();
            if (typeof restoreRoleForChat === 'function') restoreRoleForChat(activeChatId);
        } finally { endLoad(); }
    }
    (window as any).refreshGoalStatus?.();   // a /goal left over from an earlier visit is shown (paused); it never restarts by itself

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
        // Model combo-box search fields are excluded: they save through their own handlers, and
        // saveSettings() re-renders Model Priority, replacing the search field on every keystroke.
        const autoSave = e => {
            // Draft forms (Add custom model, Add MCP server, profile name …) are submitted by their own
            // button. Autosaving on their keystrokes re-rendered the catalog and wiped the half-typed form.
            if (!_settingsPopulating && !e.target.closest('#add-custom-model-form, [id^="new-"], #profile-name-input') &&
                e.target.matches('input.settings-input:not(.model-combo-input), select.settings-input, input[name="provider"]'))
                saveSettings();
        };
        settingsPanel.addEventListener('change', autoSave);
        settingsPanel.addEventListener('input',  autoSave);
    }

    initModalA11y();
    setupChatDropZone();
    setInputState(true);

    // Generate initial input suggestion (returning session or workspace already set).
    // Fires after history is restored so _buildContext() has exchange + chat list data.
    generateAndShowSuggestion?.().catch(() => {});

    // Geo cache: fetch once at startup, fire-and-forget (location skill uses the result).
    prefetchGeoCache?.().catch(() => {});

    // Pyodide: start unless the user disabled auto-load.
    // runAgentTurn repeats this check before each turn.
    autoloadPyodideIfEnabled?.();

    // Local bash: auto-detect the dev server's /api/execute on localhost. Only probe when on localhost and not
    // already configured, so we don't clobber a deliberate 'none' choice from a previous session.
    if (['localhost', '127.0.0.1'].includes(window.location.hostname) &&
        !localStorage.getItem(KEYS.SANDBOX_PROVIDER)) {
        fetch('/api/execute', { method: 'POST',
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

    applyToolbarDefault?.();

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
    let _recalledText: string | null = null; // the message ↑/↓ last put in the composer

    const input = document.getElementById('agent-input');
    if (input) {
        // keypress is a fallback for mobile soft-keyboards that skip keydown on contenteditable
        input.addEventListener('keypress', e => {
            // Enter that confirms an IME composition (Japanese, Chinese, Korean; keyCode 229 on older engines) is not a send.
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); userSend(); }
        });
        input.addEventListener('keydown', e => {
            // Enter that confirms an IME composition (Japanese, Chinese, Korean; keyCode 229 on older engines) is not a send.
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); userSend(); }
            if (e.key === 'Tab' && !e.shiftKey) {
                const accepted = acceptSuggestion?.();
                if (accepted) { e.preventDefault(); autoResizeTextarea(input); _updateSendBtnVisibility?.(); }
            }

            // ↑ / ↓ to walk through previous user messages: from an empty composer, and from a recalled message that has
            // not been edited (so repeated ↑ goes further back; before, the first recalled message ended the walk).
            // Uses _userInputHistory (filled at send time) instead of the chat history so that
            // compaction — which rebuilds the history from scratch — never erases recall.
            const _text = () => (input.innerText ?? input.textContent ?? '').trim();
            const _recalling = () => _historyIdx >= 0 && _recalledText !== null && _text() === _recalledText.trim();
            // A recalled multi-line message keeps ↑ for moving inside it, until the caret is at its very start.
            const _caretAtStart = () => {
                const sel = window.getSelection();
                if (!sel?.rangeCount || !sel.isCollapsed || !input.contains(sel.anchorNode)) return false;
                const r = sel.getRangeAt(0).cloneRange();
                r.selectNodeContents(input); r.setEnd(sel.anchorNode!, sel.anchorOffset);
                return r.toString().length === 0;
            };
            if (e.key === 'ArrowUp' && (!input.textContent?.trim() || (_recalling() && (!_recalledText!.includes('\n') || _caretAtStart())))) {
                if (!input.textContent?.trim()) _historyIdx = -1;   // an emptied composer starts again from the latest message
                e.preventDefault();
                const hist: string[] = (_userInputHistory ?? []);
                if (!hist.length) return;
                _historyIdx = Math.min(hist.length - 1, _historyIdx + 1);
                _recalledText = hist[hist.length - 1 - _historyIdx] ?? '';
                _setInputText?.(input, _recalledText);
                autoResizeTextarea(input);
                _updateSendBtnVisibility?.();
            }
            if (e.key === 'ArrowDown' && _historyIdx >= 0 && _recalling()) {
                e.preventDefault();
                _historyIdx--;
                if (_historyIdx < 0) {
                    _recalledText = null;
                    _setInputText?.(input, '');
                } else {
                    const hist: string[] = (_userInputHistory ?? []);
                    _recalledText = hist[hist.length - 1 - _historyIdx] ?? '';
                    _setInputText?.(input, _recalledText);
                }
                autoResizeTextarea(input);
                _updateSendBtnVisibility?.();
            }
        });
        // Click/tap on the ghost text accepts the suggestion.
        // Ghost text is rendered by ::before, so we measure its pixel width with Canvas
        // and only accept if the click landed within the text span (+ 12 px touch slop).
        // The click that merely focuses the input must not accept it (typing would append to it).
        let _wasFocusedOnDown = false;
        input.addEventListener('mousedown', () => { _wasFocusedOnDown = document.activeElement === input; });
        input.addEventListener('click', (e: MouseEvent) => {
            if (!_wasFocusedOnDown) return;
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
            // Allowlist rebuild, not regex stripping: unquoted on* handlers and other tags used to survive.
            const clean = sanitizePastedHtml(html);
            document.execCommand('insertHTML', false, clean);
            autoResizeTextarea(input);
        });
    }

    // ── Global keyboard shortcuts ──────────────────────────────────────────
    let _steerChordAt = 0;
    document.addEventListener('keydown', e => {
        // Escape → stop generation
        if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey) {
            // An open picker or search is dismissed first: the key was aimed at it, not at the reply running behind it.
            const _pick = document.querySelector<HTMLElement>('.ws-pick-overlay');
            if (_pick) { e.preventDefault(); _pick.querySelector<HTMLElement>('.ws-pick-footer button')?.click(); return; }
            const _search = document.getElementById('msg-search-modal');
            if (_search && _search.style.display !== 'none' && _search.style.display !== '') { closeMsgSearch(); return; }
            // So is an open popup (model list, attach menu): Escape closes it and leaves the reply running.
            if (e.defaultPrevented) return;
            const _models = document.getElementById('input-model-picker');
            if (_models?.classList.contains('picker-open')) { _models.classList.remove('picker-open'); document.getElementById('input-model-btn')?.focus(); return; }
            const _attach = document.getElementById('attach-menu');
            if (_attach?.classList.contains('open')) { _attach.classList.remove('open'); return; }
            if (agentStreaming) { stopNow?.(); return; }
            if ((window as any).cancelSendPreparation?.()) return;   // a send still waiting for its attachments
        }
        // Ctrl+X then Ctrl+S (within 2 s): send the next waiting message into the running work now, as coding-agent terminals do.
        // Ctrl+X is claimed only while something runs and nothing is selected, so Cut keeps working the rest of the time.
        if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'x') {
            const busy = agentStreaming || !!(window as any).aiJob || (window as any).msgQueue?.size?.() > 0;
            if (busy && window.getSelection()?.isCollapsed !== false) { e.preventDefault(); _steerChordAt = Date.now(); }
            return;
        }
        if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's' && Date.now() - _steerChordAt < 2000) {
            e.preventDefault(); _steerChordAt = 0;
            const inp = document.getElementById('agent-input');
            const r = (window as any).steerNextQueued?.((window as any)._readInputText?.(inp) ?? '');
            if (r?.did === 'composer' || r?.did === 'goal') { if (inp) { inp.innerHTML = ''; (window as any).autoResizeTextarea?.(inp); } }
            const short = (r?.text ?? '').length > 80 ? r.text.slice(0, 77) + '…' : (r?.text ?? '');
            (window as any).appendMessage?.('model', `<em style="color:var(--muted)">${r?.did === 'none' ? 'Nothing waiting to steer. Type a message while the agent works, then press Ctrl+X Ctrl+S.' : `Steering now: ${esc(short)}`}</em>`);
            return;
        }
        // Cmd/Ctrl+K → open chat search
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            focusChatSearch?.();
        }
        // Cmd/Ctrl+Shift+F → open message content search
        // A file editor that already took the key for its own Find (CodeMirror prevents the default) keeps it: one key opened two searches.
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f' && !e.defaultPrevented) {
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
        // Sit just above the message list, whatever height the input area has: a fixed 72 px put it on top of
        // the message box on a phone, where the input area is two rows tall, and it swallowed taps there.
        const panel = _scrollLatestBtn.offsetParent as HTMLElement | null;
        if (canScrollDown && panel)
            _scrollLatestBtn.style.bottom = Math.max(8, Math.round(panel.getBoundingClientRect().bottom - _msgEl.getBoundingClientRect().bottom) + 12) + 'px';
    }
    _msgEl?.addEventListener('scroll', () => {
        // The reader's position, for scrollBottom(): pinned = at (or within 80 px of) the newest content.
        (_msgEl as any)._fgPinned = _msgEl.scrollHeight - _msgEl.scrollTop - _msgEl.clientHeight < 80;
        _updateScrollBtn();
    }, { passive: true });
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
        try {
            if (text) localStorage.setItem(chatKey.draft(chatId), text);
            else localStorage.removeItem(chatKey.draft(chatId));
        } catch (e) {
            // QuotaExceededError: localStorage full — draft is convenience-only, silently skip.
            if (!(e instanceof DOMException && e.name === 'QuotaExceededError')) console.warn('[init] _saveDraft localStorage failed:', e);
        }
    }
    // Save the open chat's draft now (and cancel the pending debounce) — called before the active chat
    // changes, so the text is stored under the chat it was typed in, not under the next one.
    function _flushDraft(): void {
        if (_draftTimer) { clearTimeout(_draftTimer); _draftTimer = null; }
        _saveDraft();
    }
    // The composer shows the destination chat's draft — or nothing: another chat's text must not stay.
    function _restoreDraft(chatId: string): void {
        if (!input) return;
        const draft = chatId ? localStorage.getItem(chatKey.draft(chatId)) : null;
        _setInputText?.(input, draft || '');
        autoResizeTextarea?.(input);
        _updateSendBtnVisibility?.();
    }
    function clearInputDraft(chatId?: string): void {
        const id = chatId ?? activeChatId;
        if (id) localStorage.removeItem(chatKey.draft(id));
    }

    // Restore draft for the current chat on page load
    _restoreDraft(activeChatId);
    window.refreshStorageUsage?.();

    // ── Message content search ─────────────────────────────────────────────
    let _msgSearchIdx = -1;

    // Where the reader was typing or reading when search opened: closing the search returns there (a hidden modal's
    // focused input leaves focus on BODY, and typing then goes nowhere until the composer is clicked).
    let _msgSearchOpener: HTMLElement | null = null;
    function openMsgSearch(): void {
        const modal = document.getElementById('msg-search-modal');
        if (!modal) return;
        const inp = document.getElementById('msg-search-input') as HTMLInputElement | null;
        // Pressed again inside the open search: stay in it. Recording the search's own input as the opener replaced the
        // real one with null, and Escape then left focus on BODY (codex report 8, cases 271/272).
        if (modal.style.display === 'flex') { inp?.focus(); inp?.select(); return; }
        const a = document.activeElement as HTMLElement | null;
        _msgSearchOpener = a && a !== document.body && !modal.contains(a) ? a : null;
        revokeLeases('msg-search');   // a search still reading from storage belongs to the previous opening
        modal.style.display = 'flex';
        inp?.focus();
        inp && (inp.value = '');
        const results = document.getElementById('msg-search-results');
        if (results) results.innerHTML = '';
        _msgSearchIdx = -1;
    }

    function closeMsgSearch(restoreFocus = true): void {
        const modal = document.getElementById('msg-search-modal');
        if (modal) modal.style.display = 'none';
        const back = _msgSearchOpener; _msgSearchOpener = null;
        revokeLeases('msg-search');   // its pending results must not appear in a modal opened later (cases 269/270)
        if (!restoreFocus) return;
        const target = back && document.contains(back) ? back : document.getElementById('agent-input');
        (target as HTMLElement | null)?.focus?.();
    }

    async function runMsgSearch(query: string): Promise<void> {
        const results = document.getElementById('msg-search-results');
        if (!results) return;
        _msgSearchIdx = -1;
        const t = lease('msg-search', { latest: true });   // a newer keystroke supersedes this search; open/close revoke it
        if (!query.trim()) { t.finish(); results.innerHTML = ''; return; }
        // Async: chats without a localStorage cache are read from IndexedDB.
        const hits = (await searchMessages?.(query)) ?? [];
        if (!t.finish()) return;
        if (!hits.length) {
            results.innerHTML = `<div class="msg-search-empty">No results for "${escapeHtml(query)}"</div>`;
            return;
        }
        results.innerHTML = hits.map((h: any, i: number) => `
            <div class="msg-search-result" role="option" data-chat-id="${h.chatId}" data-idx="${i}"
                 onclick="msgSearchSelect('${h.chatId}')" tabindex="-1">
                <div class="msg-search-result-chat">${escapeHtml(h.chatName)}</div>
                <div class="msg-search-result-role">${escapeHtml(h.role)}</div>
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
        } else if (e.key === 'Enter' && _msgSearchIdx >= 0 && !e.isComposing && e.keyCode !== 229) {
            const item = items[_msgSearchIdx];
            e.preventDefault();   // else the keypress lands in the composer that search focuses, and sends its draft
            if (item) msgSearchSelect(item.dataset.chatId ?? '');
            return;
        } else { return; }
        items.forEach((el, i) => el.setAttribute('aria-selected', String(i === _msgSearchIdx)));
        items[_msgSearchIdx]?.scrollIntoView({ block: 'nearest' });
    }

    function msgSearchSelect(chatId: string): void {
        if (!chatId) return;
        // The result may name a chat another tab deleted since the search ran: opening it showed an empty unlisted chat
        // (codex 341). Say so and search again instead.
        if (typeof getChatList === 'function' && !getChatList().some((c: any) => c.id === chatId)) {
            const q = (document.getElementById('msg-search-input') as HTMLInputElement | null)?.value ?? '';
            void runMsgSearch(q).then(() => {
                const results = document.getElementById('msg-search-results');
                if (results) results.insertAdjacentHTML('afterbegin', '<div class="msg-search-empty" role="status">That chat was deleted in another tab. Results refreshed.</div>');
            });
            return;
        }
        closeMsgSearch(false);
        // The result is a conversation: show it, also when search was opened from Settings, Tasks or a file tab.
        activateTab?.('chat');
        const done = chatId !== activeChatId ? switchToChat?.(chatId) : undefined;
        Promise.resolve(done).then(() => document.getElementById('agent-input')?.focus());
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
    // No saved choice yet: follow the system setting (a Mac or phone in dark mode opened FreeGent in light).
    (window as any)._applyPrivacyLevelUI?.(getPrivacyLevel());
    { const saved = localStorage.getItem('fg_dark_mode'); _applyTheme(saved === '1' || (saved === null && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches)); }

    // Expose to HTML onclick handlers and window bridge (chat-render.ts uses _updateScrollBtn)
    Object.assign(window, { scrollToLatest, _updateScrollBtn, openMsgSearch, closeMsgSearch, runMsgSearch, msgSearchKeydown, msgSearchSelect, clearInputDraft, _restoreDraft, _flushDraft, toggleDarkMode, togglePrivacyMenu, pickPrivacyLevel });

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
            copyChatText((window as any).plainTextOf(responseEl, 'button, [data-action], .artifact-run-btn, .agent-turn-diff-row')).then(() => {
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
        else (window as any).rewindWithConfirm(ckptId, row as HTMLElement);
    });

    // Each turn's changed-file list refits to its width (see fitChangedFiles), also after a reload.
    if (typeof ResizeObserver === 'function' && typeof MutationObserver === 'function') {
        const msgsEl = getMessagesEl();
        const ro = new ResizeObserver(entries => entries.forEach(en => (window as any).fitChangedFiles?.(en.target)));
        const watch = (root: Element) => root.querySelectorAll('.agent-turn-files').forEach(l => ro.observe(l));
        if (msgsEl) {
            watch(msgsEl);
            new MutationObserver(muts => muts.forEach(m => m.addedNodes.forEach(n => {
                if (!(n instanceof Element)) return;
                if (n.matches('.agent-turn-files')) ro.observe(n);
                watch(n);
            }))).observe(msgsEl, { childList: true, subtree: true });
        }
    }

    // A file in a turn's changed-file list: modified opens its diff, added opens the file. Delegated
    // because the list is plain saved HTML after a reload.
    getMessagesEl()?.addEventListener('click', e => {
        const span = (e.target as Element).closest('.agent-turn-files > span[data-name]') as HTMLElement | null;
        if (!span || span.dataset.op === 'delete') return;
        const ckptId = (span.closest('.agent-turn-diff-row') as HTMLElement | null)?.dataset.checkpointId;
        if (ckptId) (window as any).showCheckpointFileDiff?.(ckptId, span.dataset.name);
    });

    // "Copy user message" delegation. The button is .user-msg-copy-btn, not .agent-ckpt-btn, so the handler above never saw it:
    // after a reload, an Edit → Cancel or a return to the chat (the bubble is rebuilt from saved HTML and loses its onclick) the
    // button did nothing, and the click reached the bubble's click-to-edit instead (codex 380).
    getMessagesEl()?.addEventListener('click', e => {
        const btn = (e.target as Element).closest('.user-msg-copy-btn[data-action="copy-user-message"]') as HTMLElement | null;
        if (!btn) return;
        e.stopPropagation();
        const bubble = btn.closest('.agent-msg-bubble') as HTMLElement | null;
        if (!bubble) return;
        copyChatText((window as any).plainTextOf(bubble)).then(() => {
            btn.textContent = '✓';
            setTimeout(() => { btn.textContent = '⎘'; }, 1500);
        }).catch(() => {});
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
        copyChatText(code.textContent ?? '').then(() => {
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
        if (typeof addFileAttachment === 'function') void addFileAttachment(file).catch(() => {});
    }
    input.value = '';
}

// Expose functions called from inline HTML onclick attributes.
// Only classic-script functions go here — ES module functions are already on
// window via their own bridges (config.js, llm-shared.js, workers.js, etc.).
Object.assign(window, {
    _resetModelWarmup,
    agentSend, userSend, handleSendButton, newChat, retryLastTurn, stopAfterStep,
    showSettings, saveSettings, switchSettingsTab,
    applyHdrReasoning, applyHdrCompactTokens,
    updateActiveModelDisplay,
    renderModelCatalogTable, renderMainModelList,
    showAddCustomModelForm, addCustomModel, deleteCustomModel,
    _movePriorityItem, _removePriorityItem, _addPriorityItem,
    activateTab, openFileTab, closeFileTab, notifyLocalFileChanged, scheduleArtifactRefresh,
    toggleChatsDropdown, startInlineRenameCurrentChat, deleteCurrentChat,
    refreshTasks,
    loadSkills, toggleSkill, installSkillFromFiles, renderSkillsChecklist, renderToolsChecklist,
    switchSkillSubtab, createSkillFromForm, createRuleFromForm,
    runnerAutopilot,
    saveAgentSetting,
    renderProfilesTab, profileSaveCurrent, profileDelete, profileDownload, profileUpload, profilePreview,
    addFileAttachment, _onAttachFiles,
    saveMediaModel, renderMediaModelSelectors,
    toggleVoiceInput, speakText, stopSpeaking, addVoiceButtons,
    saveVoiceSettings, populateVoiceTab,
    _addVoiceItem, _removeVoiceItem, _moveVoiceItem,
});

// ── Modal dialogs: role, labels, focus trap, Escape ────────────────────────
// Every dialog is a `.fg-modal-overlay` appended to <body>. One observer and one key handler make them
// accessible instead of each creator doing it: dialog role + name, labelled fields, focus moved in (and
// restored to the opener on close), Tab kept inside, Escape = the dialog's own Close/Cancel (so cleanup
// handlers run).
const _FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
// Every dialog layer. The workspace file picker is one: it opens above the task form and needs the same role, name and focus return.
const _MODAL_SEL = '.fg-modal-overlay, .ws-pick-overlay';
const _modalOpeners = new Map<HTMLElement, HTMLElement | null>();
// The last element focused outside any dialog. A dialog that focuses its own first field while it is being built (the task
// and model-edit dialogs do) has already moved focus by the time _enhanceModal runs, so "the element focused now" would
// record a field inside the dialog as its opener, and closing the dialog left focus on <body>.
// The last few elements that held focus. A dialog opened from another dialog (the file picker over the task form) returns focus to
// the control in the dialog below, not to the page behind both (codex 384-386: focus went to the board's Add button, and Enter there
// replaced the unsaved form).
const _focusTrail: HTMLElement[] = [];
const _openerFor = (ov: HTMLElement): HTMLElement | null => {
    for (let i = _focusTrail.length - 1; i >= 0; i--) {
        const el = _focusTrail[i];
        if (el.isConnected && !ov.contains(el) && el.getClientRects().length > 0) return el;
    }
    return null;
};

// Name every form control that has no accessible name. The source order of the existing forms gives
// the label: an associated <label>, the first cell of its table row, the closest preceding
// `.settings-label` of its section, then title / placeholder / the id as words.
function labelControls(root: ParentNode = document): void {
    root.querySelectorAll<HTMLInputElement>('input, select, textarea').forEach(el => {
        if (el.type === 'hidden' || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return;
        if (el.closest('label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`))) return;
        // The first cell with text: a leading checkbox cell (the skills table) has none.
        let name = [...(el.closest('tr')?.querySelectorAll('td') ?? [])].map(td => td.textContent?.trim() ?? '').find(t => t);
        if (!name) {
            const section = el.closest('.settings-section');
            const lab = section?.querySelector('.settings-label');
            if (lab && (lab.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) name = lab.textContent?.trim();
        }
        name = name || el.getAttribute('title') || el.getAttribute('placeholder') || el.id.replace(/[-_]+/g, ' ').trim();
        if (name) el.setAttribute('aria-label', name.slice(0, 120));
    });
}

function _enhanceModal(ov: HTMLElement) {
    if (_modalOpeners.has(ov)) return;
    const _now = document.activeElement as HTMLElement | null;
    _modalOpeners.set(ov, _now && _now !== document.body && !ov.contains(_now) ? _now : _openerFor(ov));
    const box = (ov.querySelector('.fg-modal, .ws-pick-box') as HTMLElement) || ov;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const title = ov.querySelector('.fg-modal-title, .ws-pick-title') as HTMLElement | null;
    if (title) {
        if (!title.id) title.id = `fg-modal-title-${_modalOpeners.size}-${Date.now().toString(36)}`;
        box.setAttribute('aria-labelledby', title.id);
    }
    ov.querySelectorAll('.fg-modal-close').forEach(b => { if (!b.getAttribute('aria-label')) b.setAttribute('aria-label', 'Close'); });
    labelControls(ov);
    if (!ov.contains(document.activeElement))
        (ov.querySelector<HTMLElement>('input:not([type=hidden]):not([type=checkbox]), textarea, select')
            || ov.querySelector<HTMLElement>(_FOCUSABLE))?.focus();
}

function _modalKeydown(e: KeyboardEvent) {
    // The workspace file picker sits above whatever opened it (the task form), so it takes part in the same stack: with only
    // .fg-modal-overlay counted, Tab and Escape aimed at the picker were handled by the dialog behind it.
    const all = document.querySelectorAll<HTMLElement>(_MODAL_SEL);
    const ov = all[all.length - 1];          // only the topmost dialog reacts
    if (!ov) return;
    if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        const btn = ov.querySelector<HTMLElement>('.fg-modal-close, .fg-modal-btn-cancel, .ws-pick-footer button');
        if (btn) btn.click(); else ov.remove();
    } else if (e.key === 'Tab') {
        const f = Array.from(ov.querySelectorAll<HTMLElement>(_FOCUSABLE)).filter(x => x.offsetParent !== null || x === document.activeElement);
        if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && (i === f.length - 1 || i < 0)) { e.preventDefault(); f[0].focus(); }
    }
}

function initModalA11y() {
    // Settings and toolbar controls are static markup that populate/re-render in place: label them once the
    // page is up and again (debounced) when their containers change.
    labelControls(document);
    let _lblTimer: any = null;
    const relabel = () => { clearTimeout(_lblTimer); _lblTimer = setTimeout(() => labelControls(document), 250); };
    for (const sel of ['#tab-content [data-panel="settings"]', '.chat-toolbar', '#hdr-bar'])
        document.querySelectorAll(sel).forEach(el => new MutationObserver(relabel).observe(el, { childList: true, subtree: true }));
    document.querySelectorAll<HTMLElement>(_MODAL_SEL).forEach(_enhanceModal);
    document.addEventListener('keydown', _modalKeydown, true);
    document.addEventListener('focusin', e => {
        const t = e.target as HTMLElement | null;
        if (t && t !== document.body) { const i = _focusTrail.indexOf(t); if (i >= 0) _focusTrail.splice(i, 1); _focusTrail.push(t); if (_focusTrail.length > 8) _focusTrail.shift(); }
    }, true);
    new MutationObserver(muts => {
        for (const m of muts) {
            m.addedNodes.forEach(n => {
                if (!(n instanceof HTMLElement)) return;
                if (n.matches(_MODAL_SEL)) _enhanceModal(n);
                else n.querySelectorAll?.(_MODAL_SEL).forEach(o => _enhanceModal(o as HTMLElement));
            });
            m.removedNodes.forEach(n => {
                if (!(n instanceof HTMLElement) || !_modalOpeners.has(n)) return;
                const opener = _modalOpeners.get(n); _modalOpeners.delete(n);
                try { opener?.focus?.(); } catch {}
            });
        }
    }).observe(document.body, { childList: true });
}
