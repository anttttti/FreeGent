// fg-tui.tsx — interactive TUI entry point for FreeGent.
// Run with:  npx tsx fg-tui.tsx [--provider openai] [--model gpt-4o] ...
//
// Boots the same agent core as fg-run.ts (via headless-runner side effects),
// installs a TUI placeholder factory, then enters an interactive Ink session.

// bootstrap-jsdom MUST be the first import: it sets globalThis.window = dom.window
// before any other module body runs. headless-runner re-exports dom for us.
import { setup, dom, saveProfile, PROFILE_PATH, listWorkspaceSessions, resumeSession } from './headless-runner.js';
import { isCacheCapable, oaiEndpoint, _markFlatCooldown } from './model-router.js';
export { listWorkspaceSessions, resumeSession };
import { makeTuiPlaceholder } from './tui-placeholder.js';
import * as Store from './tui-store.js';
import React from 'react';
import { render } from 'ink';
import { Transform } from 'node:stream';
import { TuiApp } from './tui-app.js';

// ── Mouse support ─────────────────────────────────────────────────────────────
// X10 mouse protocol: ESC [ ? 1000 h enables click events.
// The terminal sends ESC [ M <btn+32> <col+32> <row+32> (6 bytes) on each press.
// We filter these out of stdin before Ink's keypress parser sees them, then
// dispatch to a handler registered by tui-app.

let _mouseHandler:       ((row: number, col: number) => void)          | null = null;
let _scrollHandler:      ((row: number, col: number, dir: 1|-1) => void) | null = null;
let _heartbeatInterval:  ReturnType<typeof setInterval> | null = null;
export function setMouseHandler (fn: (row: number, col: number) => void): void          { _mouseHandler  = fn; }
export function setScrollHandler(fn: (row: number, col: number, dir: 1|-1) => void): void { _scrollHandler = fn; }

// Transform that strips X10 mouse events from the byte stream before Ink reads.
// Non-mouse bytes pass through unchanged.
export const stdinFilter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
        const parts: Buffer[] = [];
        let i = 0;
        while (i < chunk.length) {
            if (chunk.length - i >= 6 &&
                chunk[i] === 0x1b && chunk[i+1] === 0x5b && chunk[i+2] === 0x4d) {
                // X10 mouse event — dispatch by button byte
                const col = chunk[i+4] - 33;   // 1-indexed → 0-indexed
                const row = chunk[i+5] - 33;
                if (chunk[i+3] === 32) {
                    // left-press
                    _mouseHandler?.(row, col);
                } else if (chunk[i+3] === 96 || chunk[i+3] === 97) {
                    // scroll wheel: 96 = up, 97 = down  →  dir +1 = up, -1 = down
                    _scrollHandler?.(row, col, chunk[i+3] === 96 ? 1 : -1);
                }
                i += 6;
            } else {
                const start = i++;
                while (i < chunk.length &&
                       !(chunk.length - i >= 6 && chunk[i] === 0x1b &&
                         chunk[i+1] === 0x5b && chunk[i+2] === 0x4d)) i++;
                parts.push(chunk.slice(start, i));
            }
        }
        cb(null, parts.length ? Buffer.concat(parts) : undefined);
    },
});
// Mirror TTY identity + socket lifecycle methods so Ink treats the filtered
// stream identically to the real stdin.
(stdinFilter as any).isTTY      = process.stdin.isTTY;
(stdinFilter as any).setRawMode = (on: boolean) => { process.stdin.setRawMode?.(on); return stdinFilter; };
(stdinFilter as any).ref        = () => { (process.stdin as any).ref?.();   return stdinFilter; };
(stdinFilter as any).unref      = () => { (process.stdin as any).unref?.(); return stdinFilter; };
process.stdin.pipe(stdinFilter);

// Parse CLI flags
const args  = process.argv.slice(2);
const _flag = (name: string, fallback = '') => {
    const idx = args.indexOf(name);
    if (idx >= 0 && args[idx + 1]) return args[idx + 1];
    const envKey = `FREEWORKER_${name.replace(/^--/, '').toUpperCase().replace(/-/g, '_')}`;
    return process.env[envKey] ?? fallback;
};

// Auto-detect provider and API key from standard env var names when
// FREEWORKER_PROVIDER / FREEWORKER_API_KEY are not explicitly set.
// Priority: CLI flag > FREEWORKER_* env > standard key names in .env.
const PROVIDER_ENV_MAP: Array<[string, string]> = [
    ['OPENAI_API_KEY',     'openai'],
    ['GEMINI_API_KEY',     'google'],
    ['ANTHROPIC_API_KEY',  'anthropic'],
    ['MISTRAL_API_KEY',    'mistral'],
    ['GROQ_API_KEY',       'groq'],
    ['CEREBRAS_API_KEY',   'cerebras'],
    ['OPENROUTER_API_KEY', 'openrouter'],
    ['NVIDIA_API_KEY',     'nvidia'],
    ['NOUSPORTAL_API_KEY', 'nous'],
    ['NOUS_API_KEY',       'nous'],   // alias
];

function _detectProvider(): { provider: string; apiKey: string } | null {
    if (process.env.FREEWORKER_PROVIDER) return null; // explicit config wins
    for (const [envVar, provider] of PROVIDER_ENV_MAP) {
        const key = process.env[envVar];
        if (key) return { provider, apiKey: key };
    }
    return null;
}

const _detected = _detectProvider();

// --resume detection: flag may be bare (no value → resume most recent) or carry an ID.
const _resumeIdx = args.indexOf('--resume');
const _resumeId  = _resumeIdx >= 0 && args[_resumeIdx + 1] && !args[_resumeIdx + 1].startsWith('--')
    ? args[_resumeIdx + 1] : '';
// True when --resume is present at all (with or without an explicit ID).
const _resumeRequested = _resumeIdx >= 0 || !!process.env.FREEWORKER_RESUME;

const opts = {
    provider:        _flag('--provider') || _detected?.provider || 'openai',
    model:           _flag('--model'),
    apiKey:          _flag('--api-key') || _detected?.apiKey || '',
    apiUrl:          _flag('--api-url'),
    workspaceRoot:   _flag('--workspace', process.cwd()),
    logFile:         _flag('--log-file', '/tmp/fg-tui.log'),
    mainRole:        _flag('--role', ''),
    // Passed to setup() only when an explicit ID was given; bare --resume is resolved in main().
    resumeSessionId: _resumeId,
};

// --prompt "text": send one message immediately after the TUI boots.
const initialPrompt = _flag('--prompt');

// Install the TUI placeholder factory persistently — every call to
// createResponsePlaceholder() from llm-loops will produce a TUI handle
// that drives tui-store instead of the DOM.
function _tuiFactory() { return makeTuiPlaceholder(); }
dom.window.createResponsePlaceholder = _tuiFactory;
(globalThis as any).createResponsePlaceholder = _tuiFactory;

// Bridge: browser-side prompt-suggest.ts calls this global to push a suggestion
// into the TUI store so InputLine can render it as ghost text.
dom.window._tuiSetPromptSuggestion = (text: string) => Store.setPromptSuggestion(text ?? '');

// Bridge: mirror the JSDOM msg-queue into tui-store so the Ink queue panel re-renders.
function _syncQueue() {
    const items = (dom.window.msgQueue as any)?.getAll() ?? [];
    Store.setQueue([...items]);
}
// Subscribe after agent-core loads (it sets window.msgQueue).
// Use a short defer so the module wiring completes first.
setTimeout(() => {
    (dom.window.msgQueue as any)?.subscribe(_syncQueue);
    _syncQueue();  // initial sync
}, 0);

// Hook called by agent-core's _processQueue when a queued message is about to be sent.
// Adds the user message to the TUI event log at the moment of actual dispatch.
dom.window._onQueueDequeue = (msg: { text: string }) => {
    Store.addUserMessage(msg.text);
};

// Wire up sendMessage for use by the Ink input handler.
// Called once per user message; agent state is preserved across turns via
// the in-memory history.
export async function sendMessage(text: string): Promise<void> {
    try {
        await (globalThis as any).runAgentTurn(text, null);
        dom.window.generateAndShowSuggestion?.().catch?.(() => {});
    } catch (e: any) {
        // Surface errors through the store as a system message
        const { addTurn, finalizeTurn } = await import('./tui-store.js');
        const t = addTurn();
        finalizeTurn(t, `Error: ${e?.message ?? String(e)}`);
    }
}

export function stopAgent(): void {
    try { dom.window.stopNow?.(); } catch {}
}

export function newSession(): void {
    try { dom.window.newChat?.(); } catch {}
}

export async function runCompact(): Promise<void> {
    Store.addUserMessage('/compact');
    const ph = makeTuiPlaceholder() as any;
    try {
        await (dom.window as any).compactHistory?.(ph);
        ph.finalize?.('Compacted.');
    } catch (e: any) {
        const t = Store.addTurn();
        Store.finalizeTurn(t, `Compaction error: ${e?.message ?? String(e)}`);
    }
}

// ── TUI warmup ────────────────────────────────────────────────────────────────
// Mirrors init.ts's _tryWarmupEndpoint / _doModelWarmup for the TUI context.
// Called non-blocking after setup() so it never delays first render.
// Only fires for endpoints isCacheCapable() knows cache the KV prefix — no point
// spending quota to prime a cache that doesn't exist.

async function _doTUIWarmup(): Promise<void> {
    const ep = oaiEndpoint();
    if (!ep?.url || !isCacheCapable(ep)) return;

    try {
        const systemPrompt: string = (dom.window as any).buildSystemPrompt?.() ?? '';
        const tools = (dom.window as any).buildOAITools?.(false) ?? null;
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: '.' },
        ];
        const payload = (dom.window as any).buildChatPayload?.(ep, {
            messages, tools,
            temperature: (dom.window as any).getTemperature?.() ?? 0.6,
            maxTokens: 1, stream: false, thinkingBudget: 0,
        }) ?? { model: ep.model, messages, tools, max_tokens: 1, stream: false };

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (ep.key) headers['Authorization'] = `Bearer ${ep.key}`;

        const proxyUrl: string = ep.proxy ? ((dom.window as any).getLocalApiProxy?.() ?? '') : '';
        let resp: Response;
        if (proxyUrl) {
            resp = await fetch(proxyUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: ep.url, method: 'POST', headers, body: JSON.stringify(payload) }),
                signal: AbortSignal.timeout(20_000),
            });
        } else {
            resp = await fetch(ep.url, {
                method: 'POST', headers,
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(20_000),
            });
        }
        if (!resp.ok) _markFlatCooldown(ep);
    } catch {
        // Non-fatal — warmup failures never block TUI startup
    }
}

// Boot the agent environment, then render the Ink app.
async function main() {
    // Redirect console output to log file immediately — before Ink or setup,
    // so nothing from module initialisation leaks to stdout/stderr.
    const { appendFileSync } = await import('node:fs');
    const _log = (...a: any[]) =>
        appendFileSync(opts.logFile, JSON.stringify({ ts: new Date().toISOString(), msg: a.join(' ') }) + '\n', 'utf8');
    console.log   = _log;
    console.info  = _log;
    console.debug = _log;
    console.warn  = _log;
    console.error = _log;

    // Coarse wall-clock timer for the fg-tui.tsx side of startup.
    const _t0 = Date.now();
    const _t = (step: string) => {
        try { appendFileSync(opts.logFile, JSON.stringify({ timing: { step, ms: Date.now() - _t0 } }) + '\n', 'utf8'); } catch {}
    };
    _t('main:start');

    // setup() must run BEFORE render() — it contains synchronous blocking work
    // (DatabaseSync open, schema exec, history load) that stalls the Node.js
    // event loop and freezes Ink's stdin processing.  Running it here means the
    // user sees a brief blank alternate-screen pause instead of a visible-but-
    // frozen TUI; once the TUI appears it is immediately fully interactive.
    // (Previously render() came first to hide npm warnings, but a frozen UI is
    // worse UX.  console.log is already redirected above, so no agent output
    // leaks to stdout during setup.)
    await setup(opts);
    _t('main:after_setup');

    // Non-blocking warmup: prime the KV prefix cache for cache-capable endpoints.
    // Fires in the background — never awaited, never delays render or first user interaction.
    _doTUIWarmup().catch(() => {});

    // Bare --resume (no explicit ID): resolve the most recent session now that the
    // adapter is initialised, then swap history in before the first render.
    if (_resumeRequested && !_resumeId) {
        const sessions = await listWorkspaceSessions();
        if (sessions.length) {
            await resumeSession(sessions[0].id);
            _t('main:resume_done');
        }
    }

    // Fresh session (no history loaded from SQLite): classify tools from project
    // context in the background, exactly as createNewChat() does for WebUI.
    if (!(dom.window as any).openaiHistory?.length) {
        (dom.window as any).classifyTools?.()
            .then(() => _t('main:classifyTools:done'))
            .catch(() => {});
    }

    // Enable X10 mouse click tracking. alternateScreen makes terminal row 0
    // equal Ink's yoga row 0, so coordinate-to-component mapping is exact.
    process.stdout.write('\x1b[?1000h');

    render(React.createElement(TuiApp, { opts }), {
        stdin:           stdinFilter as any,
        exitOnCtrlC:     false,
        alternateScreen: true,
    });
    _t('main:after_render');
    Store.setReady();
    _t('main:after_setReady');

    // Heartbeat: fires every 200 ms so any >200 ms gap in the log marks the freeze.
    let _hbLast = Date.now();
    _heartbeatInterval = setInterval(() => {
        const now = Date.now();
        const gap = now - _hbLast;
        _hbLast = now;
        try { appendFileSync(opts.logFile,
            JSON.stringify({ timing: { step: 'heartbeat', ms: now - _t0, gap } }) + '\n', 'utf8'); } catch {}
    }, 200);

    if (initialPrompt) sendMessage(initialPrompt);
}

// Save settings on exit, clear timers, and disable mouse protocol.
const _cleanup = () => { try { clearInterval(_heartbeatInterval); process.stdout.write('\x1b[?1000l'); saveProfile(); } catch {} };
process.on('exit',    _cleanup);
process.on('SIGTERM', () => { _cleanup(); process.exit(0); });
process.on('SIGINT',  () => { _cleanup(); process.exit(0); });

main().catch(e => { process.stderr.write(String(e?.stack ?? e) + '\n'); process.exit(1); });
