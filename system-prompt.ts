// system-prompt.js — FreeGent: main-agent system prompt builder
// Depends on config.js globals (agentsContext, skillsRegistry, activeSkills, _hasBashOrCode,
//   getSearchProvider, getSandboxProvider, getAgentConcisePrompts,
//   getAgentPlanMode, getAgentPromptTemplate, getContextThreshold,
//   getImageModel, getAudioModel, getVideoModel) and state.js (mainAgentRole).
import { mainAgentRole, _sessionToolFilter } from './state.js';

// Shared environment detection helpers — called by buildSystemPrompt and exported for workers.ts.

export function _buildWorkspaceDesc(): string {
    const _n = typeof nativeExec === 'function';
    if (_n && typeof fgTargetContainer !== 'undefined' && fgTargetContainer) {
        return `Files are in the task container filesystem. \`read_file\`, \`write_file\`, and \`execute_code\` all operate inside the container — use paths as-is (e.g. \`/testbed/file.py\`, \`repo/main.py\`). No "local/" prefix.`;
    }
    if (_n) {
        return `Files are on the native filesystem at relative paths from the workspace root. \`read_file\`, \`write_file\`, and \`execute_code\` access the real filesystem directly. No "local/" prefix needed.`;
    }
    // "local/" paths only exist while a folder is synced via the File System Access API —
    // instructing the prefix unconditionally sent models writing to local/… and failing
    // with "No local folder open" when nothing was synced (fg-chat 2026-07-16).
    const _localSynced = typeof hasLocalFolder === 'function' && hasLocalFolder();
    if (_localSynced) {
        return `Files live in the user's browser (IndexedDB). "local/" files are in a folder from the user's filesystem — changes write to disk. Use "local/" prefix for all local paths (e.g. "local/src/main.js").`;
    }
    // WASM bash: workspace files are pre-loaded at /workspace; bash is the primary file tool.
    if (typeof getSandboxProvider === 'function' && getSandboxProvider() === 'wasm') {
        return 'Files are pre-loaded at `/workspace` — use `execute_code` (bash) with absolute paths (e.g. `/workspace/src/main.js`). Files written under /workspace sync back to the browser workspace automatically. **Important:** `read_file`/`write_file` tools use plain relative paths without the `/workspace/` prefix (e.g. `game.html`, not `/workspace/game.html`) — the prefix is bash-internal only.';
    }
    // Check if the individual file tools are enabled (they're OPT_IN, off by default).
    if (enabledTools.has('read_file')) {
        return `Files live in the user's browser workspace (IndexedDB) — list_files, read_file, and write_file operate on it with plain relative paths (e.g. "src/main.js", "index.html"). No local folder is synced: "local/…" paths do not exist and will fail.`;
    }
    return `Files live in the user's browser workspace (IndexedDB) at plain relative paths (e.g. "src/main.js"). No local folder is synced: "local/…" paths do not exist and will fail.`;
}

export function _buildLangsDesc(): string {
    if (typeof _hasBashOrCode !== 'function' || !_hasBashOrCode()) return '';
    const _n = typeof nativeExec === 'function';
    const _inContainer = _n && typeof fgTargetContainer !== 'undefined' && fgTargetContainer;
    if (_inContainer) return 'Languages: **python**, **bash**, **javascript** (Node.js). All run inside a task container — execute_code bash commands and file operations (read_file, write_file) route to the container filesystem.';
    if (_n) return 'Languages: **python** (python3, pip3), **bash** (shell + npm), **javascript** (Node.js) — all run in the workspace with real filesystem access.';
    const _l = typeof getSandboxProvider === 'function' && getSandboxProvider() === 'local';
    if (_l) return 'Languages: **python**, **bash**, **javascript** — run via local sandbox with workspace files at relative paths.';
    const _p = typeof pyodideStatus !== 'undefined' && (pyodideStatus === 'ready' || pyodideStatus === 'loading');
    const _wasm = typeof getSandboxProvider === 'function' && getSandboxProvider() === 'wasm';
    if (_wasm && _p) return 'Languages: **bash** (musl-static Unix tools via WASM; workspace at /workspace — use absolute paths), **python** (Pyodide via execute_code — files pre-loaded, writes sync back, micropip for extras), **javascript** (browser sandbox — fs.readFileSync/writeFileSync, no npm). Note: `python3` inside bash is also Pyodide — use relative paths or `/workspace/…`. Never use `/shiro/workspace/…` (internal path; `os.getcwd()` may print it but it is not a usable path from inside scripts — use `open(\'/workspace/foo\')` or `open(\'foo\')` instead).';
    if (_wasm)       return 'Languages: **bash** (musl-static Unix tools via WASM; workspace at /workspace — use absolute paths), **javascript** (browser sandbox — fs.readFileSync/writeFileSync, no npm).';
    if (_p) return 'Languages: **python** (Pyodide — files pre-loaded, writes sync back, micropip for extras) and **javascript** (browser sandbox — fs.readFileSync/writeFileSync/existsSync, no npm).';
    return 'Languages: **javascript** (browser sandbox — fs.readFileSync/writeFileSync/existsSync/readdirSync, no npm). Written files sync back to workspace.';
}

export function _buildEnvContext(): string {
    const _n = typeof nativeExec === 'function';
    if (!_n) return '';
    const _inContainer = typeof fgTargetContainer !== 'undefined' && fgTargetContainer;
    const _langs = _buildLangsDesc();
    return _inContainer
        ? `\n## Environment\nRunning inside a Docker task container. \`read_file\`/\`write_file\`/\`execute_code\` operate on container paths — no "local/" prefix.${_langs ? `\n${_langs}` : ''}`
        : `\n## Environment\nRunning headless with native filesystem access. Use relative workspace paths.${_langs ? `\n${_langs}` : ''}`;
}

// Detect device input capabilities from browser media queries and navigator APIs.
// Called at prompt-build time so it reflects the actual device accessing the WebUI.
export function _buildDeviceContext(): string {
    // Only relevant in the browser (system-prompt.ts is also imported by headless workers).
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return '';

    const _mq = (q: string) => { try { return window.matchMedia(q).matches; } catch { return false; } };

    // Touch screen present?
    const _hasTouch = (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
        || _mq('(pointer: coarse)');

    // Primary pointer type: fine = mouse/trackpad/stylus; coarse = finger touch.
    const _pointerFine   = _mq('(pointer: fine)');
    const _pointerCoarse = _mq('(pointer: coarse)');

    // Hover capability: hover = mouse/trackpad present; none = touch-only.
    const _canHover = _mq('(hover: hover)');

    // Screen size category (logical pixels).
    const _w = typeof screen !== 'undefined' ? screen.width : 0;
    const _h = typeof screen !== 'undefined' ? screen.height : 0;
    const _short = Math.min(_w, _h);  // shorter dimension = device width in portrait
    const _screenCat = _short < 600 ? 'phone' : _short < 1024 ? 'tablet' : 'desktop';

    // Synthesise a human-readable device summary.
    // A touch device with no hover = no physical keyboard or mouse.
    // A touch device that also has hover = tablet/laptop with attached input.
    const _inputParts: string[] = [];
    if (_hasTouch) _inputParts.push('touch screen');
    if (_pointerFine && _canHover) _inputParts.push('mouse or trackpad');
    else if (_pointerFine) _inputParts.push('stylus or fine pointer');
    const _inputDesc = _inputParts.join(' + ') || 'unknown input';

    const _kbNote = (_hasTouch && !_canHover)
        ? 'No physical keyboard or mouse detected — touch-only device.'
        : (_hasTouch && _canHover)
            ? 'Touch screen and pointing device (keyboard likely present).'
            : 'Mouse/trackpad input (keyboard assumed present).';

    const _screenDesc = `${_screenCat} screen (${_w}×${_h} logical px)`;

    return `\n## User's device\nInput: ${_inputDesc}. ${_kbNote} Screen: ${_screenDesc}.\n`
        + `When building apps or tools: use touch-friendly tap targets (≥44 px) on touch-only devices, `
        + `avoid keyboard shortcuts or hover-only interactions as the primary interface on touch-only devices.`;
}

export function buildSystemPrompt(): string {
    // Date-only (no time) — placed at the END of the prompt so all preceding static content
    // stays in the vLLM prefix cache. Current time is injected on-demand by the 'datetime' rule
    // when the user's message contains time-related words.
    const _date = new Date().toISOString().slice(0, 10);
    const _dateCtx = `\nCurrent date: ${_date}\n`;
    if (!mainAgentRole) return '';
    const _imgM = typeof getImageModel === 'function' ? getImageModel() : '';
    const _audM = typeof getAudioModel === 'function' ? getAudioModel() : '';
    const _vidM = typeof getVideoModel === 'function' ? getVideoModel() : '';
    // Only advertise run_workers model routing when run_workers is actually available —
    // the guidance is meaningless (and potentially confusing) when the tool is disabled.
    const _mediaCtx = (enabledTools.has('run_workers') && (_imgM || _audM || _vidM))
        ? `\n## Configured media models\n${_imgM ? `- Image: \`${_imgM}\`\n` : ''}${_audM ? `- Audio: \`${_audM}\`\n` : ''}${_vidM ? `- Video: \`${_vidM}\`\n` : ''}Use these as the \`model\` field in \`run_workers\` to route media-processing tasks to the right model.\n`
        : '';
    // Effective tool set = role.tools ∩ enabledTools.  Passed to _filterRoleBody so that a
    // role whose .tools ceiling excludes a tool gets its body filtered even if that tool is
    // globally enabled — the model should only see tools it can actually call.
    const _effectiveToolSet: Set<string> | undefined = mainAgentRole.tools
        ? new Set([...mainAgentRole.tools].filter((t: string) => enabledTools.has(t)))
        : undefined;
    // Precedence: saved JS source > saved plain text > built-in body_fn > static body.
    const _savedFnSrc = typeof getRoleBodyFn === 'function' ? getRoleBodyFn(mainAgentRole.name) : null;
    const _rawRoleBody = (_savedFnSrc
        ? (() => {
            try {
                const _b = _savedFnSrc.indexOf('{');
                const _e = _savedFnSrc.lastIndexOf('}');
                const _body = (_b !== -1 && _e > _b) ? _savedFnSrc.slice(_b + 1, _e) : _savedFnSrc;
                // eslint-disable-next-line no-new-func
                return new Function(_body)() as string;
            } catch (err) {
                console.warn('[FreeGent] saved role body_fn eval failed — falling back:', err);
                return null;
            }
          })()
        : null)
        || (typeof getRoleBody === 'function' ? getRoleBody(mainAgentRole.name) : null)
        || (typeof mainAgentRole.body_fn === 'function' ? mainAgentRole.body_fn() : (mainAgentRole.body || ''));
    const _mrBody = (typeof _filterRoleBody === 'function' ? _filterRoleBody : (b: string) => b)(_rawRoleBody, _effectiveToolSet);
    const _envCtx = _buildEnvContext();
    // Browser path (_buildEnvContext returns ''): still include workspace location and langs.
    // _buildLangsDesc is called inside _buildEnvContext for native paths, so only call it
    // here in the browser path (where _envCtx is '') to avoid a redundant second call.
    const _langsDesc = !_envCtx ? _buildLangsDesc() : '';
    const _wsCtx = !_envCtx
        ? `\n\n${_buildWorkspaceDesc()}${_langsDesc ? `\n${_langsDesc}` : ''}`
        : '';
    // Search-provider note — lets the model know which backend is active.
    const _sp  = typeof getSearchProvider === 'function' ? getSearchProvider() : 'auto';
    const _spNote = enabledTools.has('web_search') && _sp !== 'auto'
        ? `\n\n${_sp === 'wikipedia' ? 'web_search is Wikipedia only — no live web access.'
           : _sp === 'tavily'     ? 'web_search uses Tavily.'
           : _sp === 'brave'      ? 'web_search uses Brave Search.'
           : ''}`
        : '';
    const _honesty = '\n## Honesty\nOnly report what your tools actually return. Never fabricate file contents, search results, or code output.';
    const _deviceCtx = _buildDeviceContext();
    const _skillsCtx = (() => {
        const parts = [];
        for (const s of skillsRegistry.values()) {
            if (!activeSkills.has(s.name)) continue;
            if (s.requires_tools && s.requires_tools.split(',').some(t => !isToolActive(t.trim()))) continue;
            const _sb = (typeof _filterRoleBody === 'function' ? _filterRoleBody : (b: string) => b)(s.body, _effectiveToolSet);
            if (!_sb.trim()) continue; // dynamic (body_fn) rules have body:''; skip rather than emit an empty header
            parts.push(`\n### Always-on ${s.type === 'rule' ? 'rule' : 'skill'}: ${s.name}\n${_sb}`);
        }
        return parts.join('\n');
    })();
    // Cowork mode: inject task-management context into the system prompt.
    // The detailed tasks skill body is injected turn-by-turn as triggered guidance
    // (turn-context.ts seeds it unconditionally). This block establishes the always-present
    // intent: for complex requests, break work into task files before starting.
    // Skip if the user has manually added the tasks skill to activeSkills — it already
    // appears in the system prompt via the always-on skill loop above.
    const _tasksSkillAlwaysOn = typeof activeSkills !== 'undefined' && activeSkills.has('tasks');
    const _coworkCtx = (typeof getMode === 'function' && getMode() === 'cowork' && !_tasksSkillAlwaysOn)
        ? '\n## Cowork mode\nFor complex or multi-step requests (building an app, a game, a large refactor), break the work into task files **before** starting implementation. Create one `fg-tasks/NNN-slug.md` file per major step, then work through them in order.\nUse `update_task_status(path, status)` to track progress: call with `"in-progress"` when starting a task, `"done"` or `"failed"` when finishing.\nRead `fg-tasks/ledger.md` to see the current board.'
        : '';
    return `${_mrBody}${_envCtx}${_wsCtx}${_spNote}${_mediaCtx}${_honesty}${_deviceCtx}${_skillsCtx}${_coworkCtx}${_dateCtx}`;
}

// Window bridge for classic scripts.
Object.assign(window, { buildSystemPrompt, _buildWorkspaceDesc, _buildLangsDesc, _buildEnvContext, _buildDeviceContext });
