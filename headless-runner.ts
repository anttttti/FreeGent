// headless-runner.js — runs the FreeGent agent loop in Node.js without a browser.
//
// Import order matters: bootstrap-jsdom.js MUST be the first import in the parent
// entry point (fg-run.js) so globalThis.window = dom.window is set before any ES
// module body runs. The ES module imports below then set properties on dom.window,
// which the classic scripts (loaded via dom.window.eval) see as globals.
//
// Never imported by browser code — Node.js only.

import { dom, virtualConsole } from './bootstrap-jsdom.js';
import { KEYS } from './storage-keys.js';
import { readFileSync, appendFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { NodeSqliteAdapter } from './node-sqlite-adapter.js';

// ── ES modules (same set as tests/setup.js) ──────────────────────────────────
// These run their module body, setting window.X properties via Object.assign(window,{}).
// Each property also lands on globalThis.window = dom.window, so the classic scripts
// (evaluated in dom.window context below) can access them as free variables.
import { createSession } from './state.js';
import './config.js';
import './model-caps.js';
import './ast.js';
import './history-util.js';
import './fetch-blacklist.js';
import { parseFetchAllow, setFetchAllow } from './fetch-allow.js';
import { scrubEnv } from './secret-env.js';
import './search-providers.js';
import './skill-guidance.js';
import './turn-context.js';
import './step-validator.js';
import './nudge-emitter.js';
import './payload-builder.js';
import './detectors.js';
import './tool-call-repair.js';
import './history.js';
import './model-router.js';
import './stream-decode.js';
import './retry.js';
import './turn-protocol.js';
import './system-prompt.js';
import './tool-schemas.js';
import './deep-research.js';
import './post-turn.js';
import './llm-shared.js';
import './tools.js';
import './chat-render.js';
import { setDirectorHeadlessTools } from './workers.js';
import './workspace.js';
import './qa.js';
// Former classic scripts — now ES modules imported like the rest. Their window bridges
// run through the bootstrap windowProxy, so their exports land on BOTH dom.window and
// globalThis. The old dom.window.eval() loading left their functions invisible to module
// free-variable reads: run_workers was silently broken headless since the R1 refactor
// ("_updateBlankSteps is not defined") because workers.js could not see llm-loops' helpers.
import './chat-state.js';
import './session-store.js';
import { setConvoLogWriter, convoLogTurn, setMetricsWriter } from './convo-log.js';
import './llm-loops.js';
import './chat-attachments.js';
import './agent-core.js';
import './skills.js'; // populates BUILTIN_RULES/BUILTIN_SKILLS; loadSkills() called in run()

import { NodeFsAdapter, DockerFsAdapter } from './node-fs-adapter.js';
import { registry, initPersistence } from './session-registry.js';
import { NULL_TASK_HANDLE } from './render-adapter.js';
import { directorLoop } from './loop-director.js';
import { runAgentTurn } from './agent-core.js';

const __dir  = dirname(fileURLToPath(import.meta.url));
const _ls    = dom.window.localStorage; // shorthand used throughout
// Signal to model-router._customEndpoint that we're running headless (no CORS proxy server).
dom.window._fgHeadless = true;

// Stub UI functions that agent-core.js or skills.js may call but don't matter headlessly.
const _noop = () => {};
for (const fn of ['showSettings', 'renderModelCatalogTable', 'loadRoles',
                   'loadAgentsContext', 'refreshTasks', 'notifyLocalFileChanged',
                   'maybeRunInitAgent', 'openArtifactTab',
                   'renderSkillsList', 'renderSkillsChecklist', 'addVoiceButtons']) {
    // Assign through globalThis (not dom.window directly) so ES-module code that
    // resolves these as bare free variables (via the windowProxy mirror) sees the stub too —
    // writing straight to dom.window bypasses the proxy's mirroring set trap.
    (globalThis as any)[fn] = _noop;
    dom.window[fn] = _noop;
}

function _makeCapturingPlaceholder(onFinalize) {
    return {
        div:             dom.window.document.createElement('div'),
        addThinkingTask: ()       => NULL_TASK_HANDLE,
        addToolStep:     (labels) => (Array.isArray(labels) ? labels : [labels]).map(() => NULL_TASK_HANDLE),
        addCompactStep:  ()       => NULL_TASK_HANDLE,
        addSystemStep:   _noop,
        finalize:        (text)   => onFinalize(text ?? ''),
    };
}

// ── Provider / model configuration ───────────────────────────────────────────
// Config getters read from localStorage (not DOM inputs), so we write there.

const _KEY_MAP = {
    google:       'fg_gemini_key',
    mistral:      'fg_mistral_key',
    groq:         'fg_groq_key',
    cerebras:     'fg_cerebras_key',
    nvidia:       'fg_nvidia_key',
    openrouter:   'fg_openrouter_key',
    tokenharbor:  'fg_tokenharbor_key',
};

// All known env-var → localStorage-key mappings, applied at startup so
// multi-provider model lists work without specifying a single --provider.
const _ENV_KEY_MAP: Record<string, string> = {
    GEMINI_API_KEY:        'fg_gemini_key',
    OPENAI_API_KEY:        'fg_openai_key',
    ANTHROPIC_API_KEY:     'fg_openai_key',  // Anthropic uses openai-compat endpoint
    MISTRAL_API_KEY:       'fg_mistral_key',
    GROQ_API_KEY:          'fg_groq_key',
    CEREBRAS_API_KEY:      'fg_cerebras_key',
    NVIDIA_API_KEY:        'fg_nvidia_key',
    OPENROUTER_API_KEY:    'fg_openrouter_key',
    TOKENHARBOR_API_KEY:   'fg_tokenharbor_key',
    NOUSPORTAL_API_KEY:  'fg_nous_key',
    NOUS_API_KEY:        'fg_nous_key',  // alias
    TAVILY_API_KEY:        'fg_tavily_key',
    HF_API_KEY:            'fg_hf_key',
    BRAVE_API_KEY:         'fg_brave_key',
    STACKEXCHANGE_API_KEY: 'fg_stackexchange_key',
};

function _configureHeadless(provider, model, apiKey, apiUrl, contextWindow, compactionLimit, temperature, thinkingLevel, preserveThinking, retryMode, retryFixedMs) {
    // QA lifecycle gates default OFF headless. In the browser they default ON, but each
    // gate run costs 3 callMainModelText() calls plus 2 execute_code shell-outs and can
    // BLOCK the transition (qa.ts transitionTask) — silently changing agent behaviour and
    // cost in benchmark runs that only touch update_task_status incidentally.
    // loadProfile() has already run by this point, so an explicit fg_qa_enabled in
    // fg-current-profile.json wins; this only fills in the default when nothing set it.
    if (!_ls.getItem('fg_qa_enabled')) _ls.setItem('fg_qa_enabled', 'false');

    // Apply all known env-var API keys so multi-provider model lists work.
    // A single --api-key / FREEGENT_API_KEY flag still overrides the detected provider's slot below.
    for (const [envVar, lsKey] of Object.entries(_ENV_KEY_MAP)) {
        const v = process.env[envVar];
        // Don't overwrite a key that was already set (e.g. from the loaded profile)
        if (v && !_ls.getItem(lsKey)) _ls.setItem(lsKey, v);
    }

    // Explicit --api-key or FREEGENT_API_KEY always wins for the selected provider
    const keyName = _KEY_MAP[provider] || 'fg_openai_key';
    if (apiKey) _ls.setItem(keyName, apiKey);

    // Endpoint URL (openai-compatible providers)
    if (apiUrl) _ls.setItem('fg_openai_url', apiUrl);

    // Context window: compaction handles headroom, input and output share the full window.
    // The runtime loop already clamps max_tokens to (contextWindow - estimatedInput - 512) per-turn.
    if (contextWindow > 0) {
        _ls.setItem('fg_openai_context', String(contextWindow));
    }
    // Compaction limit: compact history before hitting the context wall.
    // Cap the limit so the compact call itself has room for a quality summary.
    // At compaction time: input ≈ (history + sysPrompt + compactInstruction) * 1.1 estimation buffer.
    // We want at least MIN_SUMMARY tokens of output headroom.
    // Safe limit = (contextWindow - MIN_SUMMARY - 512) / 1.1 - SYS_OVERHEAD
    // where SYS_OVERHEAD ≈ 6500 (system prompt ~6k + compact instruction ~300 + margin).
    if (compactionLimit > 0) {
        const MIN_SUMMARY  = 4000;
        const SYS_OVERHEAD = 6500;
        const safeLimit = contextWindow > 0
            ? Math.max(4000, Math.min(compactionLimit,
                Math.floor((contextWindow - MIN_SUMMARY - 512) / 1.1) - SYS_OVERHEAD))
            : compactionLimit;
        _ls.setItem('fg_agent_compact_tokens',    String(safeLimit));
        _ls.setItem('fg_agent_proactive_compact', 'true');
    }
    if (temperature != null)     _ls.setItem('fg_temperature',       String(temperature));
    if (thinkingLevel)           _ls.setItem('fg_thinking_level',    thinkingLevel);
    if (preserveThinking != null) _ls.setItem('fg_preserve_thinking', preserveThinking ? 'true' : 'false');
    if (retryMode)               _ls.setItem('fg_retry_mode',        retryMode);
    if (retryFixedMs > 0)    _ls.setItem('fg_retry_fixed_ms', String(retryFixedMs));

    if (!model) return; // no model override — leave existing config

    // Ensure the model spec passes getAllModels() validation by registering it
    // as a custom model if it isn't already in the built-in catalog.
    const spec   = `${provider}|${model}`;
    let   custom = [];
    try   { custom = JSON.parse(_ls.getItem('fg_custom_models') || '[]'); } catch {}
    if (!custom.find(m => `${m.provider}|${m.model}` === spec)) {
        custom.push({ provider, model, label: model, released: '', contextK: 128,
                      params: 0, media: ['text'], tools: true, thinking: false, note: 'headless' });
        _ls.setItem('fg_custom_models', JSON.stringify(custom));
    }
    _ls.setItem('fg_main_models', JSON.stringify([spec]));
}

// ── .env file loading ─────────────────────────────────────────────────────────
// Mirrors vite.config.ts loadDotenv() so keys in .env are visible to _configureHeadless
// without requiring tsx --env-file or shell sourcing.
//
// Precedence (shell env always wins; .env files fill in gaps):
//   1. <cwd>/.env                    — project-local; gitignored; legacy/override path
//   2. ~/.config/freegent/credentials — user-global; outside any repo, cannot be committed
function _parseDotenvFile(envPath: string): void {
    try {
        if (!existsSync(envPath)) return;
        for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
            const t = line.trim();
            if (!t || t.startsWith('#') || !t.includes('=')) continue;
            const idx = t.indexOf('=');
            const key = t.slice(0, idx).trim();
            let val = t.slice(idx + 1).trim();
            if (val.length >= 2 && val[0] === val.at(-1) && (val[0] === '"' || val[0] === "'"))
                val = val.slice(1, -1);
            if (key && !(key in process.env)) process.env[key] = val;
        }
    } catch { /* unreadable — silent */ }
}

function _loadDotenv(): void {
    _parseDotenvFile(join(process.cwd(), '.env'));
    const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    _parseDotenvFile(join(xdgConfig, 'freegent', 'credentials'));
}

// ── Profile file (fg-current-profile.json in repo root) ──────────────────────
// Shares the same JSON format as the browser's profileDownload():
//   { name, version, savedAt, settings: { fg_*: value, ... } }
// API keys are never written (blocklist below).
export const PROFILE_PATH = join(__dir, 'fg-current-profile.json');
const _KEY_BLOCKLIST = /key|token|secret|password/i;

export function loadProfile(): void {
    try {
        const raw      = readFileSync(PROFILE_PATH, 'utf8');
        const profile  = JSON.parse(raw);
        const settings = profile.settings ?? profile;
        for (const [k, v] of Object.entries(settings)) {
            if (typeof v === 'string')              _ls.setItem(k, v);
            else if (v !== null && v !== undefined) _ls.setItem(k, JSON.stringify(v));
        }
        // PRIMARY_MODELS is the profile key; the runtime reads MAIN_MODELS
        const primaryModels = _ls.getItem(KEYS.PRIMARY_MODELS);
        if (primaryModels && !_ls.getItem(KEYS.MAIN_MODELS))
            _ls.setItem(KEYS.MAIN_MODELS, primaryModels);
    } catch { /* file absent or malformed — silent */ }
}

export function saveProfile(): void {
    const settings: Record<string, string> = {};
    for (let i = 0; i < _ls.length; i++) {
        const k = _ls.key(i)!;
        if (k.startsWith('fg_') && !_KEY_BLOCKLIST.test(k))
            settings[k] = _ls.getItem(k)!;
    }
    try {
        writeFileSync(PROFILE_PATH,
            JSON.stringify({ name: 'current', version: 1, savedAt: new Date().toISOString(), settings }, null, 2));
    } catch { /* read-only fs or permissions — ignore */ }
}

// ── Logging ───────────────────────────────────────────────────────────────────
// Installed once per process when the first run() / setup() call has a logFile.
let _loggingInstalled = false;
let _sessionAdapter: NodeSqliteAdapter | null = null;
let _workspacePrefix = '';   // 16-char hex prefix for the active workspace

// ── Shared opts parsing ───────────────────────────────────────────────────────
function _parseOpts(opts: any) {
    const e = process.env;
    return {
        workspaceRoot   : opts.workspaceRoot   ?? (e.WORKSPACE_ROOT || process.cwd()),
        provider        : opts.provider        ?? (e.FREEGENT_PROVIDER || 'openai'),
        model           : opts.model           ?? (e.FREEGENT_MODEL    || ''),
        apiKey          : opts.apiKey          ?? (e.FREEGENT_API_KEY  || ''),
        apiUrl          : opts.apiUrl          ?? (e.FREEGENT_API_URL  || ''),
        timeoutMs       : opts.timeoutMs       ?? (parseInt(e.FREEGENT_TIMEOUT_MS ?? '') || 30 * 60 * 1000),
        logFile         : opts.logFile         ?? e.FREEGENT_LOG_FILE ?? '/tmp/fg-agent.log',
        sidecarDir      : opts.sidecarDir      ?? e.FREEGENT_SIDECAR_DIR ?? '',
        contextWindow   : opts.contextWindow   ?? (parseInt(e.FREEGENT_CONTEXT_WINDOW  ?? '') || 0),
        compactionLimit : opts.compactionLimit ?? (parseInt(e.FREEGENT_COMPACTION_LIMIT ?? '') || 0),
        disabledTools   : opts.disabledTools   ?? e.FREEGENT_DISABLED_TOOLS ?? '',
        mainRole        : opts.mainRole        ?? e.FREEGENT_MAIN_ROLE       ?? '',
        workflowMode    : opts.workflowMode    ?? (e.FREEGENT_WORKFLOW_MODE === '1') ?? false,
        resumeSessionId : opts.resumeSessionId ?? '',
        sessionDbPath   : opts.sessionDbPath   ?? e.FREEGENT_SESSION_DB ?? join(homedir(), '.freegent', 'sessions.db'),
        temperature     : opts.temperature     ?? (e.FREEGENT_TEMPERATURE != null ? parseFloat(e.FREEGENT_TEMPERATURE) : null),
        thinkingLevel   : opts.thinkingLevel   ?? e.FREEGENT_THINKING_LEVEL  ?? '',
        preserveThinking: opts.preserveThinking ?? (e.FREEGENT_PRESERVE_THINKING != null ? e.FREEGENT_PRESERVE_THINKING !== '0' : null),
        retryMode       : opts.retryMode       ?? e.FREEGENT_RETRY_MODE       ?? '',
        retryFixedMs    : opts.retryFixedMs    ?? (parseInt(e.FREEGENT_RETRY_FIXED_MS ?? '') || 0),
        maxRounds: opts.maxRounds ?? (parseInt(e.FREEGENT_MAX_ROUNDS ?? '') || 0),
        harness:   opts.harness   ?? e.FREEGENT_HARNESS ?? 'freegent',
        fetchAllow:      opts.fetchAllow      ?? e.FREEGENT_FETCH_ALLOW      ?? '',
        enableTools:     opts.enableTools     ?? e.FREEGENT_ENABLE_TOOLS     ?? '',
    };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Bootstrap the agent environment (workspace, config, skills) without running a task.
 * Idempotent — safe to call multiple times; only executes on the first call.
 * Used by fg-tui.tsx to prepare for an interactive session before the first user message.
 */
let _setupDone = false;
export async function setup(opts: Record<string, any> = {}): Promise<void> {
    if (_setupDone) return;
    _setupDone = true;
    _loadDotenv();  // load .env keys into process.env before profile or config reads
    loadProfile();  // populate JSDOM localStorage from fg-current-profile.json before config write
    const {
        workspaceRoot, provider, model, apiKey, apiUrl, logFile, sidecarDir,
        contextWindow, compactionLimit, disabledTools, mainRole, workflowMode, resumeSessionId, sessionDbPath,
        temperature, thinkingLevel, preserveThinking, retryMode, retryFixedMs, maxRounds, harness, fetchAllow, enableTools,
    } = _parseOpts(opts);

    // ── Startup timing instrumentation ────────────────────────────────────────
    // Logs elapsed ms at each checkpoint to logFile so we can identify freezes.
    // Each line: {"timing":{"step":"...","ms":<elapsed>}}
    const _t0 = Date.now();
    const _t = (step: string) => {
        const ms = Date.now() - _t0;
        try { appendFileSync(logFile || '/tmp/fg-tui.log',
            JSON.stringify({ timing: { step, ms } }) + '\n', 'utf8'); } catch {}
    };
    _t('setup:start');

    const targetContainer = process.env.FG_TARGET_CONTAINER || '';
    if (targetContainer) {
        dom.window.fgTargetContainer = targetContainer;
        globalThis.fgTargetContainer = targetContainer;
    }
    dom.window.setWorkspaceAdapter(targetContainer
        ? new DockerFsAdapter(targetContainer)
        : new NodeFsAdapter(workspaceRoot, sidecarDir
            ? { sidecarRoot: sidecarDir, sidecarPrefixes: ['fg-tasks/', 'memory/'] }
            : {}));
    _t('setup:setWorkspaceAdapter');

    // Pre-warm the workspace path cache — collectWorkspacePaths() walks the entire
    // workspace (stat() per file) and is called at the start of every agent turn.
    // Kicking it off here means the walk runs concurrently with loadSkills() (async)
    // and any other awaitable setup below; by the time the TUI renders the cache is
    // already hot, so the first user message dispatches without the visible freeze.
    (dom.window as any).collectWorkspacePaths?.()
        .then(() => _t('prewarm:collectWorkspacePaths:done'))
        .catch(() => {});

    // Mirror to globalThis so ES-module free-variable reads in tools.ts see it
    // (dom.window.x = y bypasses the windowProxy set-trap; globalThis.nativeExec stays
    // undefined otherwise and execute_code bash falls through to the "Local sandbox" error).
    // Snapshot workspace files (path → mtimeMs) for detecting writes during execute_code.
    // Only used for local (non-Docker) execution where we can stat the filesystem directly.
    const _snapWorkspace = (dir: string): Map<string, number> => {
        const snap = new Map<string, number>();
        const walk = (d: string, depth: number) => {
            if (depth > 8) return; // guard against deeply nested repos
            try {
                for (const ent of readdirSync(d, { withFileTypes: true })) {
                    if (ent.name.startsWith('.git')) continue; // skip git internals (large + uninteresting)
                    const full = join(d, ent.name);
                    if (ent.isFile()) {
                        try { snap.set(full, statSync(full).mtimeMs); } catch {}
                    } else if (ent.isDirectory()) walk(full, depth + 1);
                }
            } catch {}
        };
        if (dir) walk(dir, 0);
        return snap;
    };

    const _nativeExecFn = (language, code) => new Promise((resolve) => {
        const _dc = (bin: string, flag: string) => ['docker', ['exec', '-i', targetContainer, bin, flag, code]] as const;
        const LANG_CMD = targetContainer
            ? { bash: _dc('bash', '-c'), python: _dc('python3', '-c'), javascript: _dc('node', '-e') }
            : { bash: ['bash', ['-c', code]], python: ['python3', ['-c', code]], javascript: ['node', ['-e', code]] };
        const entry = LANG_CMD[language];
        if (!entry) { resolve({ error: `nativeExec: unsupported language '${language}'` }); return; }
        const [cmd, cmdArgs] = entry;
        const MAX_OUTPUT = 200_000, MAX_RETURN = 5_000, TIMEOUT_MS = 120_000;
        // Snapshot workspace before execution (local only — Docker workspace is on the container).
        const preSnap = (!targetContainer && workspaceRoot) ? _snapWorkspace(workspaceRoot) : null;
        // Snapshot .git/hooks to detect hook-injection attempts (non-.sample files planted by the agent).
        const hooksDir = (!targetContainer && workspaceRoot) ? join(workspaceRoot, '.git', 'hooks') : null;
        const preHooks: Set<string> | null = hooksDir ? (() => {
            try { return new Set(readdirSync(hooksDir).filter(f => !f.endsWith('.sample'))); }
            catch { return null; }
        })() : null;
        let stdout = '', stderr = '', done = false;
        const _done = (val) => { if (done) return; done = true; clearTimeout(timer); resolve(val); };
        // The runner's environment holds the provider keys (loaded from the credentials file);
        // agent commands get it without them. (docker exec doesn't forward it either way.)
        const child = execFile(cmd, cmdArgs, { cwd: workspaceRoot, maxBuffer: MAX_OUTPUT, detached: true, env: scrubEnv(process.env) });
        child.unref();
        // No interactive input: close stdin so a program that reads it gets EOF at once instead of
        // blocking until the timeout (read, input(), vim prompts, menu-driven binaries).
        child.stdin?.end();
        child.stdout?.on('data', d => { stdout += d; if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(-MAX_OUTPUT); });
        child.stderr?.on('data', d => { stderr += d; if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(-MAX_OUTPUT); });
        child.on('close', (exitCode) => {
            const result: Record<string, any> = {
                stdout: stdout.length > MAX_RETURN ? `…[truncated]\n` + stdout.slice(-MAX_RETURN) : stdout,
                stderr: stderr.length > MAX_RETURN ? `…[truncated]\n` + stderr.slice(-MAX_RETURN) : stderr,
                exit_code: exitCode ?? 0,
            };
            // Detect files written/modified during execution via post-snapshot diff.
            // Populate files_written so llm-loops.ts can set _editsThisRun for the completion gate.
            if (preSnap && (exitCode ?? 0) === 0 && workspaceRoot) {
                const written: string[] = [];
                try {
                    const postSnap = _snapWorkspace(workspaceRoot);
                    for (const [p, mtime] of postSnap) {
                        if (!preSnap.has(p) || preSnap.get(p) !== mtime)
                            written.push(p.startsWith(workspaceRoot + '/') ? p.slice(workspaceRoot.length + 1) : p);
                    }
                } catch {}
                if (written.length > 0) result.files_written = written;
            }
            // Detect .git/hooks planted by the executed code (hook-injection guard).
            if (hooksDir && preHooks !== null) {
                try {
                    const postHooks = readdirSync(hooksDir).filter(f => !f.endsWith('.sample'));
                    const planted = postHooks.filter(h => !preHooks.has(h));
                    if (planted.length > 0) {
                        for (const h of planted) { try { unlinkSync(join(hooksDir, h)); } catch {} }
                        result.warning = `execute_code planted .git/hooks — removed: ${planted.join(', ')}. Check for other .git/ writes.`;
                    }
                } catch {}
            }
            _done(result);
        });
        child.on('error', (e) => _done({ error: `${cmd}: ${e.message}`, stdout, stderr, exit_code: 1 }));
        const timer = setTimeout(() => {
            try { process.kill(-child.pid, 'SIGKILL'); } catch {}
            _done({ stdout: stdout.length > MAX_RETURN ? `…[truncated]\n` + stdout.slice(-MAX_RETURN) : stdout,
                    stderr: stderr.length > MAX_RETURN ? `…[truncated]\n` + stderr.slice(-MAX_RETURN) : stderr,
                    exit_code: 124, error: 'Command timed out after 120s. If it was waiting for input, pass input through a pipe or file (stdin is closed); run long jobs in the background.' });
        }, TIMEOUT_MS);
    });
    dom.window.nativeExec = _nativeExecFn;
    globalThis.nativeExec = _nativeExecFn;

    _configureHeadless(provider, model, apiKey, apiUrl, contextWindow, compactionLimit, temperature, thinkingLevel, preserveThinking, retryMode, retryFixedMs);
    if (maxRounds > 0) _ls.setItem('fg_agent_max_rounds', String(maxRounds));
    let _disabledList = disabledTools ? disabledTools.split(',').map(t => t.trim()).filter(Boolean) : [];
    // --fetch-allow: fetch_url may only reach the listed origins (parseFetchAllow throws on a
    // malformed entry, failing the run before the agent starts). Other tools that make their own
    // outbound requests are switched off so fetch_url is the only HTTP tool. Request policy only —
    // containment is the caller's job (network isolation around this process).
    if (fetchAllow) {
        setFetchAllow(parseFetchAllow(fetchAllow));
        const _netTools = ['web_search', 'deep_research', 'academic_search', 'package_search', 'context7_docs', 'generate_image'];
        _disabledList = [...new Set([..._disabledList, ..._netTools])];
    }
    // --enable-tools: make tools available and add them to the director's headless ceiling.
    const _enableList = enableTools ? enableTools.split(',').map(t => t.trim()).filter(Boolean) : [];
    for (const t of _enableList) {
        if (!(dom.window.ALL_TOOL_NAMES as string[]).includes(t)) throw new Error(`--enable-tools: unknown tool "${t}"`);
        if (_disabledList.includes(t)) throw new Error(`--enable-tools: "${t}" is also disabled (--disable-tools or --fetch-allow)`);
    }
    if (disabledTools || fetchAllow) dom.window.setDisabledTools(_disabledList);
    for (const t of _enableList) dom.window.enabledTools.add(t);
    setDirectorHeadlessTools(_enableList);
    // Enable file-write tools for worker roles. setDisabledTools() skips OPT_IN_TOOLS
    // (write_file, replace_in_file, apply_patch) by design, but workers need them to make
    // code edits without falling back to error-prone bash redirection. The director's
    // headless ceiling ({read_file, search_workspace, list_files, run_workers, execute_code,
    // run_git, ast_query}) still excludes write tools — so enabling them here only benefits
    // workers whose ceiling includes them (coder). Explicit --disable-tools entries win.
    ['write_file', 'replace_in_file', 'apply_patch']
        .filter(t => !_disabledList.includes(t))
        .forEach(t => dom.window.enabledTools.add(t));
    // Benchmark runs must not call external APIs — lock utility model to 'none' so
    // autoNameChat and any future utility callers fall back to firstFreeEndpoint (vLLM).
    // TUI runs omit harness and should behave like WebUI: use the configured utility
    // model (google|gemma default) if a key is available. Profile can override either way.
    if (harness && !_ls.getItem('fg_utility_model')) _ls.setItem('fg_utility_model', 'none');
    _t('setup:configureHeadless');

    // Fire the endpoint context-window probe in the background — don't block startup.
    // A live local vLLM /models call answers in <1 s once the model is loaded; a stuck
    // or unreachable endpoint would previously freeze setup() (and therefore render())
    // for many seconds. We still need the result before the first LLM call, but the
    // user typically takes several seconds to type a first message, so the background
    // probe will have settled by then. AbortSignal.timeout caps the damage if the
    // endpoint is completely unreachable.
    if (apiUrl) {
        (async () => {
            try {
                const modelsResp = await fetch(`${apiUrl}/models`,
                    { signal: AbortSignal.timeout(10_000) });
                if (!modelsResp.ok) return;
                const modelsData = await modelsResp.json();
                const modelEntry = modelsData.data?.find((m: any) => !model || m.id === model) ?? modelsData.data?.[0];
                const endpointLimit = modelEntry?.max_model_len;
                if (endpointLimit) {
                    if (contextWindow > 0 && contextWindow > endpointLimit) {
                        console.error(`[headless] contextWindow=${contextWindow} exceeds endpoint max_model_len=${endpointLimit} — clamping`);
                        _ls.setItem('fg_openai_context', String(endpointLimit));
                    } else if (contextWindow === 0) {
                        console.log(`[headless] auto-detected context window from endpoint: max_model_len=${endpointLimit}`);
                        _ls.setItem('fg_openai_context', String(endpointLimit));
                        if (!compactionLimit) {
                            const MIN_SUMMARY = 4000, SYS_OVERHEAD = 6500;
                            const safeLimit = Math.max(4000, Math.floor((endpointLimit - MIN_SUMMARY - 512) / 1.1) - SYS_OVERHEAD);
                            _ls.setItem('fg_agent_compact_tokens',    String(safeLimit));
                            _ls.setItem('fg_agent_proactive_compact', 'true');
                        }
                    }
                }
            } catch {}
        })();
    }

    // Detect installed pip packages for execute_code's package hints.
    // Run in the background — this is purely advisory and must not delay startup.
    execFile('pip3', ['list', '--format=columns'], { timeout: 10_000 }, (err, stdout) => {
        if (!err && stdout) {
            dom.window.fgPipPackages = new Set(
                stdout.split('\n').slice(2).map(l => l.split(/\s+/)[0]?.toLowerCase()).filter(Boolean)
            );
        }
    });

    _t('setup:before_loadSkills');
    await dom.window.loadSkills();
    _t('setup:after_loadSkills');

    if (typeof dom.window.setMainAgentRole === 'function') {
        // NOTE v0.24: pass the role NAME string (not the role object) — window.setMainAgentRole
        // is workers.ts's version which resolves the name→object via rolesRegistry internally.
        // v0.23 passed the role object here, but workers.ts then called rolesRegistry.get(object)
        // which returned undefined, leaving mainAgentRole null and the tool filter inactive.
        dom.window.setMainAgentRole(mainRole || 'director');
    }
    if (typeof dom.window.setWorkflowMode === 'function')
        dom.window.setWorkflowMode(workflowMode);

    // Session persistence: wire NodeSqliteAdapter so chat history, turn logs, and
    // compaction lineage are persisted to SQLite — same behaviour as the browser's
    // BrowserSqliteAdapter injected by initBrowserSqlite().
    _t('setup:before_sqlite');
    try {
        const adapter = new NodeSqliteAdapter(sessionDbPath);
        _t('setup:sqlite_new');
        if (typeof dom.window.setSessionStore === 'function')
            dom.window.setSessionStore(adapter);

        // Workspace prefix: first 16 hex chars of SHA256(workspaceRoot) — stable per
        // workspace, used to filter sessions belonging to this directory.
        // Old sessions used the full 32-char hash as ID, so startsWith(prefix) catches both.
        const _wsPrefix = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16);
        _sessionAdapter  = adapter;
        _workspacePrefix = _wsPrefix;
        const _dirName  = workspaceRoot.split('/').filter(Boolean).pop() ?? 'headless';

        // Determine active chat ID:
        //   resumeSessionId — explicit session to restore (from --resume or /resume N)
        //   workflowMode    — bench runs always get a fresh unique ID, never resume
        //   default         — new interactive session, unique per launch
        // Random suffix: concurrent benchmark containers share workspaceRoot (/workspace) and can
        // start in the same millisecond; identical IDs made their event logs share one file.
        const chatId = resumeSessionId || `${_wsPrefix}${Date.now().toString(36).padStart(9, '0')}${randomBytes(3).toString('hex')}`;
        const chatName = resumeSessionId
            ? undefined  // don't overwrite existing name of a resumed session
            : `${_dirName} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;

        if (typeof dom.window.setActiveChatId === 'function')
            dom.window.setActiveChatId(chatId);

        // Register/update the chat row. For a resumed session we only bump lastAt.
        if (typeof dom.window.sessionSyncChatList === 'function') {
            const existing = chatName ? null
                : (await adapter.loadChatList?.()).find(c => c.id === chatId);
            dom.window.sessionSyncChatList([{
                id: chatId,
                name: chatName ?? existing?.name ?? _dirName,
                createdAt: existing?.createdAt ?? Date.now(),
                lastAt: Date.now(),
            }]);
        }
        _t('setup:sqlite_syncChatList_fired');

        // Load history only when resuming an existing session.
        // Bench runs (workflowMode) and fresh sessions always start empty.
        if (resumeSessionId && !workflowMode) {
            const history = await adapter.loadHistory(chatId);
            _t('setup:sqlite_loadHistory_done');
            if (history?.length && typeof dom.window.setOpenaiHistory === 'function')
                dom.window.setOpenaiHistory(history);
        }
    } catch (e: any) {
        console.warn('[headless] session store init failed:', e?.message);
    }
    _t('setup:after_sqlite');

    if (logFile && !_loggingInstalled) {
        _loggingInstalled = true;
        setConvoLogWriter(record => {
            if ((record as any)?.type === 'validation') return;
            try { appendFileSync(logFile, JSON.stringify(record) + '\n', 'utf8'); } catch {}
        });
        virtualConsole.on('error', (...args) => {
            try { appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: args.join(' ') }) + '\n', 'utf8'); } catch {}
        });
        virtualConsole.on('warn', (...args) => {
            try { appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg: args.join(' ') }) + '\n', 'utf8'); } catch {}
        });
    }

    // initialize event-log persistence alongside the convoLog writer.
    // Events are written to logDir/events/<sessionId>.jsonl — one JSONL file per session.
    if (logFile) {
        try {
            const evtLogDir = join(dirname(logFile), 'events');
            initPersistence(evtLogDir);
        } catch (e: any) {
            console.warn('[headless] session-event persistence init failed:', e?.message);
        }
    }
    _t('setup:done');
}

/** Export dom so fg-tui can install its own placeholder factory after setup(). */
export { dom };

/** List sessions belonging to this workspace, newest first. */
export async function listWorkspaceSessions(): Promise<
    { id: string; name: string; createdAt: number; lastAt: number }[]
> {
    if (!_sessionAdapter || !_workspacePrefix) return [];
    try {
        const all = await _sessionAdapter.loadChatList();
        return all
            .filter(s => s.id.startsWith(_workspacePrefix))
            .sort((a, b) => b.lastAt - a.lastAt);
    } catch { return []; }
}

/**
 * Switch the running session to an existing chat: update the active chat ID
 * and restore its history into the agent state. Call after setup() has run.
 */
export async function resumeSession(chatId: string): Promise<boolean> {
    if (!_sessionAdapter) return false;
    try {
        const history = await _sessionAdapter.loadHistory(chatId);
        if (!history?.length) return false;
        if (typeof dom.window.setActiveChatId === 'function')
            dom.window.setActiveChatId(chatId);
        if (typeof dom.window.setOpenaiHistory === 'function')
            dom.window.setOpenaiHistory(history);
        // Update lastAt so this session sorts first next time.
        const all = await _sessionAdapter.loadChatList();
        const entry = all.find(c => c.id === chatId);
        if (entry && typeof dom.window.sessionSyncChatList === 'function')
            dom.window.sessionSyncChatList([{ ...entry, lastAt: Date.now() }]);
        return true;
    } catch { return false; }
}

/**
 * Run a single direct LLM call (no agent loop, no tools).
 * Profile and .env keys are loaded just as for run().
 */
export async function prompt(text: string, opts: Record<string, any> = {}): Promise<{ output: string; error: any }> {
    if (!text?.trim()) return { output: '', error: 'empty prompt' };
    await setup(opts);
    try {
        const result = await (dom.window as any).callLLMComplete(text, { maxTokens: 4096 });
        return { output: typeof result === 'string' ? result : '', error: null };
    } catch (e: any) {
        return { output: '', error: e?.message || String(e) };
    }
}

/** Per-task metrics accumulated by the metrics writer installed in run(). */
export interface RunMetrics {
    elapsed_s:     number;
    steps:         number;
    input_tokens:  number;
    output_tokens: number;
    compactions:   number;
}

/**
 * Run the FreeGent agent on a task.
 */
export async function run(task: any, opts: Record<string, any> = {}): Promise<{ output: string; error: any; metrics: RunMetrics }> {
    if (typeof task !== 'string' || task.trim().length < 8)
        return { output: '', error: `empty or trivial task input (${JSON.stringify(String(task ?? '').slice(0, 60))}) — refusing to start the agent`, metrics: { elapsed_s: 0, steps: 0, input_tokens: 0, output_tokens: 0, compactions: 0 } };
    const { timeoutMs } = _parseOpts(opts);
    await setup(opts);

    const origCreatePH = dom.window.createResponsePlaceholder;
    const _noPH = (_container?: any) => _makeCapturingPlaceholder(_noop);
    dom.window.createResponsePlaceholder = _noPH;
    globalThis.createResponsePlaceholder = _noPH;

    // Per-task metrics accumulator — installed before runAgentTurn, cleared in finally.
    const _t0 = Date.now();
    const _metrics: RunMetrics = { elapsed_s: 0, steps: 0, input_tokens: 0, output_tokens: 0, compactions: 0 };
    setMetricsWriter((record: any) => {
        if (record.type === 'history_snapshot') { _metrics.compactions++; return; }
        if (record.type) return; // skip history_final, validation, etc.
        _metrics.steps++;
        if (record.promptTokens)   _metrics.input_tokens  += record.promptTokens;
        if (record.responseTokens) _metrics.output_tokens += record.responseTokens;
    });

    // Fire a hard abort after timeoutMs so the agent doesn't hang in retry loops.
    // Guard: setTimeout(fn, undefined) is equivalent to setTimeout(fn, 0) and fires
    // on the next tick, immediately setting softStopPending before any LLM call starts.
    const _abortTimer = timeoutMs != null
        ? setTimeout(() => { try { dom.window.stopAfterStep?.(); } catch {} }, timeoutMs)
        : null;

    const session = createSession({ workflowMode });  // §2: session owns workflowMode

    // create an event-log session for this task run and set it active.
    // ID is based on the activeChatId so it matches what agent-core's turn events use.
    const _evtChatId = (dom.window as any).activeChatId ?? `task-${Date.now()}`;
    const _evtSessionId = `${_evtChatId}-${Date.now()}`;
    try {
        const _evtSession = registry.create({ id: _evtSessionId, chatId: _evtChatId });
        session._session = _evtSession;
        registry.setActive(_evtSession);
    } catch (e: any) {
        console.warn('[headless] session event-log create failed:', e?.message);
    }

    const _flushFinalHistory = () => {
        try {
            // _s.history is empty for native sessions; read from event log instead.
            const _evtSess = session._session ?? null;
            const _finalHist = _evtSess ? _evtSess.deriveMessages() : session.history.slice();
            convoLogTurn({ type: 'history_final', history: _finalHist });
        } catch {}
    };
    const _sigtermHandler = () => { _flushFinalHistory(); void registry.flush(); process.exit(1); };
    process.once('SIGTERM', _sigtermHandler);

    let output = '';
    let error: Error | null = null;
    try {
        // §3: Director loop is now delegated to loop-director.ts directorLoop().
        // runAgentTurn returns TurnResult; directorLoop drives continuations.
        const _isDirector = globalThis.mainAgentRole?.name === 'director';
        const _dirPH = _makeCapturingPlaceholder(_noop);
        setActivePlaceholder(_dirPH);

        const _runOne = (prompt: string, sess: any, opts?: any) =>
            runAgentTurn(prompt, null, sess, { placeholder: _dirPH, ...opts });

        const _dirResult = await directorLoop(
            _runOne,
            session,
            task,
            _isDirector
                ? { maxContinuations: 4, forceFirstToolCall: true }
                : { maxContinuations: 0 },  // non-director: single turn only
        );

        output = typeof _stripTerminal === 'function'
            ? _stripTerminal(_dirResult.text) : _dirResult.text;
    } catch (e) {
        if (process.env.FG_DEBUG_STACK) console.error('[debug stack]', e.stack);
        error = e?.message || String(e);
    } finally {
        _metrics.elapsed_s = (Date.now() - _t0) / 1000;
        setMetricsWriter(null);
        process.off('SIGTERM', _sigtermHandler);
        _flushFinalHistory();
        // flush any buffered event-log writes before the task result is returned.
        await registry.flush().catch(e => console.warn('[headless] event-log flush failed:', e?.message));
        if (_abortTimer != null) clearTimeout(_abortTimer);
        dom.window.createResponsePlaceholder = origCreatePH;
        globalThis.createResponsePlaceholder = origCreatePH;
    }

    // When the timeout fires mid-LLM-call, runTurn returns '*(break)*' instead of the
    // actual response text. Recover the last meaningful assistant text from session history
    // so callers get a real answer rather than a sentinel string.

    if (output === '*(break)*') {
        const _strip: (t: string) => string =
            typeof _stripTerminal === 'function' ? _stripTerminal : (t: string) => t;
        // _s.history is empty for native sessions; read from event log instead.
        const _evtSess = session._session ?? null;
        const _hist: any[] = _evtSess ? _evtSess.deriveMessages() : (session?.history ?? []);
        for (let _i = _hist.length - 1; _i >= 0; _i--) {
            const _m = _hist[_i];
            if (_m?.role !== 'assistant') continue;
            const _raw = typeof _m.content === 'string' ? _m.content
                : Array.isArray(_m.content) ? (_m.content as any[]).map((p: any) => p.text || '').join('') : '';
            if (!_raw || /<original_request>/.test(_raw)) continue;
            const _t = _strip(_raw).trim();
            if (_t && _t !== '*(break)*' && !/^\s*\{/.test(_t)) {
                output = _t;
                break;
            }
        }
    }

    return { output, error, metrics: _metrics };
}

