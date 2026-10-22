// fg-tui.tsx — interactive TUI entry point for FreeGent.
// Run with:  npx tsx fg-tui.tsx [--provider openai] [--model gpt-4o] ...
//
// Boots the same agent core as fg-run.ts (via headless-runner side effects),
// installs a TUI placeholder factory, then enters an interactive Ink session.

// bootstrap-jsdom MUST be the first import: it sets globalThis.window = dom.window
// before any other module body runs. headless-runner re-exports dom for us.
import { setup, dom, saveProfile, listWorkspaceSessions, resumeSession } from './headless-runner.js';
import { isCacheCapable, oaiEndpoint, _markFlatCooldown } from './model-router.js';
export { listWorkspaceSessions, resumeSession };
import { makeTuiPlaceholder } from './tui-placeholder.js';
import * as Store from './tui-store.js';
import { createMouseSplitter } from './mouse-input.js';
import { takeSnapshot, restoreSnapshot, dropSnapshot, type Snapshot } from './tui-checkpoint.js';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { rmSync } from 'node:fs';
import { startGoal, resumeGoal, stopGoal, loadGoal, clearGoal, describeGoal, parseGoalCommand, GOAL_PATH, type GoalHost } from './goal.js';
import { workspaceEpoch } from './exec-limits.js';
import { startLoopWatch, stallAnnouncer } from './loop-watch.js';
import { aiBusy, setAiJob, activeChatId, setSoftStopPending, setActiveAbortController, setAgentStreaming, activeAbortController } from './state.js';
import { setChatHistory, getChatHistory } from './chat-history.js';
import { stripInjected } from './history-util.js';
import { _stripTerminal } from './turn-protocol.js';
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
let _stopLoopWatch:      (() => void) | null = null;
export function setMouseHandler (fn: (row: number, col: number) => void): void          { _mouseHandler  = fn; }
export function setScrollHandler(fn: (row: number, col: number, dir: 1|-1) => void): void { _scrollHandler = fn; }

// Transform that strips X10 mouse events from the byte stream before Ink reads (mouse-input.ts holds a report that arrives in two
// reads until it is complete). Non-mouse bytes pass through unchanged.
const _mouse = createMouseSplitter((r, c) => _mouseHandler?.(r, c), (r, c, d) => _scrollHandler?.(r, c, d));
let _mouseHoldTimer: ReturnType<typeof setTimeout> | null = null;
const stdinFilter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
        if (_mouseHoldTimer) { clearTimeout(_mouseHoldTimer); _mouseHoldTimer = null; }
        const out = _mouse.write(chunk);
        if (_mouse.pending()) {
            // A bare Escape (or a cut report that never finishes) goes to Ink after a moment.
            _mouseHoldTimer = setTimeout(() => { _mouseHoldTimer = null; const rest = _mouse.flush(); if (rest.length) stdinFilter.push(rest); }, _mouse.holdMs());
            (_mouseHoldTimer as any).unref?.();
        }
        cb(null, out.length ? out : undefined);
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
    ['GROQ_API_KEY',       'groq'],
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
dom.window._onQueueDequeue = async (msg: { text: string }) => {
    await _takeCheckpoint(msg.text);
    Store.addUserMessage(msg.text);
};

// ── Checkpoints: Rewind and Rerun ──────────────────────────────────────────────
// Before each message: where the history stood and a copy of the workspace's files (tui-checkpoint.ts). The turn that answers the message
// carries that as its origin (tui-store.ts TurnOrigin), which is what the Rewind and Rerun buttons of a turn, and a step's Rerun, go back to.
// The conversation can always be taken back; the workspace copies are kept for the last few messages only, in a temporary folder.
const _CKPT_KEEP = 10;
const _ckptStore = joinPath(tmpdir(), `fg-tui-ckpt-${process.pid}`);
interface Ckpt { id: number; snap: Snapshot | null; historyLen: number }
const _ckpts: Ckpt[] = [];
let _ckptSeq = 0;
function _modelLabel(): string {
    try { const spec: string = (dom.window as any).getActiveMainModelList?.()?.[0] ?? ''; return spec.replace('|', ' · '); } catch { return ''; }
}
async function _takeCheckpoint(text: string): Promise<void> {
    const historyLen = getChatHistory().length;   // before the awaits: the history as the message found it
    const id = ++_ckptSeq;
    let snap: Snapshot | null = null;
    try { snap = await takeSnapshot(opts.workspaceRoot, _ckptStore, String(id)); } catch { /* no workspace copy: the conversation can still be taken back */ }
    _ckpts.push({ id, snap, historyLen });
    while (_ckpts.length > _CKPT_KEEP) { const old = _ckpts.shift()!; if (old.snap) void dropSnapshot(old.snap); }
    Store.setNextTurnOrigin({ text, historyLen, ckptId: id, model: _modelLabel() });
}
const _dropCheckpoints = () => { try { rmSync(_ckptStore, { recursive: true, force: true }); } catch {} };

// Wire up sendMessage for use by the Ink input handler.
// Called once per user message; agent state is preserved across turns via
// the in-memory history.
// A session starts out named after its folder and start time. Like the WebUI, name it from its first message:
// the first words at once, then a short title from the utility model.
async function _nameSession(text: string): Promise<void> {
    const g = globalThis as any;
    const id = g.activeChatId;
    if (!id || text.startsWith('/') || g.getChatHistory?.().length) return;
    const list = g.getChatList?.() ?? [];
    if (!list.some((c: any) => c.id === id)) {   // the session row lives in SQLite; setChatName edits the list entry
        const now = Date.now();
        g.saveChatList?.([...list, { id, name: 'New Chat', createdAt: now, lastAt: now }]);
    }
    g.autoNameChat?.(id, text)?.catch?.(() => {});
}

// Sends the TUI has started and not finished: counted from the call, before the turn itself exists, so the status does
// not read "ready" during the naming and prelude work that runs first.
let _sendsActive = 0;

/** A reply (or a send that is about to start one) is in flight. Things that replace the open conversation must not run now. */
export function isTurnBusy(): boolean {
    const turns = (globalThis as any).turnsInFlight?.() ?? 0;
    return _sendsActive > 0 || turns > 0 || aiBusy();
}
// The status line and the input queue follow this, not whichever local notice happened to finish last.
Store.setBusyProbe(isTurnBusy);

/** Put the workspace back to the copy taken before a turn's message (if it is still kept) and say what came of it. */
async function _restoreTurnWorkspace(o: Store.TurnOrigin): Promise<string> {
    const ck = _ckpts.find(c => c.id === o.ckptId);
    if (!ck) return 'the workspace was not restored (its copy is gone)';
    if (!ck.snap) return 'the workspace was not restored (it could not be copied)';
    try {
        const r = await restoreSnapshot(opts.workspaceRoot, ck.snap);
        return `${r.restored.length} file${r.restored.length === 1 ? '' : 's'} restored, ${r.removed.length} removed`
            + (r.createdNotRemoved ? '; the workspace has too many files to find the ones the reply created, so those were left' : '')
            + (r.skippedLarge.length ? `; ${r.skippedLarge.length} large file${r.skippedLarge.length === 1 ? '' : 's'} left as they are` : '');
    } catch (e: any) { return `files NOT restored: ${e?.message ?? e}`; }
}
/** The copies of the messages from `o` on belong to a conversation that is being cut: drop them (`keepOwn`: not the one of `o` itself). */
async function _dropCheckpointsFrom(o: Store.TurnOrigin, keepOwn: boolean): Promise<void> {
    const from = _ckpts.findIndex(c => c.id === o.ckptId);
    if (from < 0) return;
    for (const c of _ckpts.splice(keepOwn ? from + 1 : from)) if (c.snap) await dropSnapshot(c.snap);
}

/** Go back to before a turn's message: the conversation, the workspace's files and the screen (the Rewind button, /rewind). The files come back only as
 *  far as the copy reached (size limits in tui-checkpoint.ts); what could not be restored is said. Returns false when nothing was rewound. */
export async function rewindToTurn(turn: Store.TurnState, opts2: { announce?: boolean } = {}): Promise<boolean> {
    if (isTurnBusy()) { Store.addNotice('_A reply is still running — stop it (Ctrl+C or /stop) before rewinding._'); return false; }
    const o = turn.origin;
    if (!o) { Store.addNotice('_Nothing to rewind to._'); return false; }
    const history = getChatHistory();
    if (o.historyLen > history.length) { Store.addNotice('_This message can no longer be rewound to: the conversation was compacted, rewound or cleared since._'); return false; }
    _sendsActive++;
    try {
        const files = await _restoreTurnWorkspace(o);
        await _dropCheckpointsFrom(o, false);
        setChatHistory(history.slice(0, o.historyLen));
        Store.truncateFromTurn(turn);
        try { (dom.window as any).saveHistory?.(); } catch {}
        if (opts2.announce !== false) Store.addNotice(`Rewound to before that message — ${files}.`);
        return true;
    } finally { _sendsActive--; Store.syncRunning(); }
}

/** /rewind, Alt+key: the last message. */
export async function rewindLast(): Promise<void> {
    const turn = Store.lastOriginTurn();
    if (!turn) { Store.addNotice('_Nothing to rewind to._'); return; }
    await rewindToTurn(turn);
}

/** The Rerun button of a turn: rewind to before its message and send that message again. */
export async function rerunTurn(turn: Store.TurnState): Promise<void> {
    const text = turn.origin?.text;
    if (!text) { Store.addNotice('_Nothing to rerun._'); return; }
    if (!await rewindToTurn(turn, { announce: false })) return;
    Store.addUserMessage(text);
    await sendMessage(text);
}

/** The Rerun button of a step: cut the conversation back to where that step's model call started and run the turn on from there, keeping the
 *  steps before it. `resetWorkspace` also puts the files back to how they were when the turn began. */
export async function rerunFromStep(turn: Store.TurnState, step: Store.StepState, o: { resetWorkspace: boolean }): Promise<void> {
    if (isTurnBusy()) { Store.addNotice('_A reply is still running — stop it (Ctrl+C or /stop) before rerunning._'); return; }
    const anchor = step.anchor ?? step;
    const histLen = anchor.histLen;
    const history = getChatHistory();
    if (histLen == null || histLen < 1 || histLen > history.length) {
        Store.addNotice('_This step can no longer be rerun: the conversation it started from is gone (compacted, rewound or cleared)._');
        return;
    }
    _sendsActive++;
    try {
        if (o.resetWorkspace) {
            if (turn.origin) Store.addNotice(`Workspace reset to the start of the turn — ${await _restoreTurnWorkspace(turn.origin)}.`);
            else Store.addNotice('_The workspace copy from the start of the turn is not available; the workspace was left as it is._');
        }
        if (turn.origin) await _dropCheckpointsFrom(turn.origin, true);   // the messages after this turn are cut
        setChatHistory(history.slice(0, histLen));
        Store.truncateFromStep(turn, anchor);
        await (globalThis as any).rerunTurnFromHistory(() => makeTuiPlaceholder({ continueTurn: turn }));
    } catch (e: any) {
        if (!turn.done) Store.finalizeTurn(turn, '');   // the cut turn must not stay open
        Store.addNotice(`Error: ${e?.message ?? String(e)}`);
    } finally { _sendsActive--; Store.syncRunning(); }
}

export async function sendMessage(text: string): Promise<void> {
    // A Ctrl+C (stop after this step) is spent when its turn has ended. Left set, it answered the next fresh message with "*(break)*" and
    // no request, until /stop cleared it (TUI report case 044). Only when nothing else is running: it must not cancel a stop that
    // a still-unwinding turn has yet to see.
    if (!isTurnBusy()) setSoftStopPending(false);
    _sendsActive++;
    try {
        await _takeCheckpoint(text);   // counted as busy from the call: the copy is awaited, and the status must not read "ready" meanwhile
        await _nameSession(text);
        await (globalThis as any).runAgentTurn(text, null);
        dom.window.generateAndShowSuggestion?.().catch?.(() => {});
    } catch (e: any) {
        // Surface errors through the store as a system message
        Store.addNotice(`Error: ${e?.message ?? String(e)}`);
    } finally {
        _sendsActive--;
        Store.setNextTurnOrigin(null);   // a send that never reached a turn must not pass its origin on to the next one
        Store.syncRunning();
    }
}


// ── /goal ─────────────────────────────────────────────────────────────────────
// goal.ts owns the loop (shared with the WebUI); this is the terminal's end of it: a turn in the open session, the record in the workspace,
// notices on the screen.
function goalHost(): GoalHost {
    const epoch = workspaceEpoch();
    const session = activeChatId;
    return {
        async runTurn(prompt, { visible }) {
            // The goal belongs to the session it started in; a turn sent to another one would land in the wrong conversation.
            if (activeChatId !== session) return { text: 'the session was switched', finishSignal: 'stopped' };
            _takeCheckpoint();
            setSoftStopPending(false);
            Store.addUserMessage(visible);
            const r: any = await (globalThis as any).runAgentTurn(prompt, null);
            return { text: String(r?.text ?? ''), finishSignal: r?.finishSignal ?? 'running', edited: r?.stop?.edited };
        },
        read: () => (dom.window as any).agentReadFile(GOAL_PATH).catch(() => null),
        write: (c) => (dom.window as any).agentWriteFile(GOAL_PATH, c, null, { epoch }),
        notify: (m) => Store.addNotice(m.includes('\n') ? m : `_${m}_`),
        async waitQuiet() {
            const t0 = Date.now();
            while (((globalThis as any).turnsInFlight?.() ?? 0) > 0 || ((dom.window as any).msgQueue?.size?.() ?? 0) > 0) {
                if (Date.now() - t0 > 300_000) return false;
                await new Promise(r => setTimeout(r, 200));
            }
            return true;
        },
    };
}
/** `/goal …`: start, resume, show, stop or clear the standing goal. Resolves when a started loop ends. */
export async function runGoal(arg: string): Promise<void> {
    const cmd = parseGoalCommand(arg);
    const host = goalHost();
    if (cmd.op === 'status') { Store.addNotice(describeGoal(await loadGoal(host))); return; }
    if (cmd.op === 'stop') {
        if (!stopGoal('stopped by you')) Store.addNotice('_No goal is running._');
        else stopAgent();
        return;
    }
    if (cmd.op === 'clear') { if (await clearGoal(host)) Store.addNotice('_Goal cleared._'); return; }
    if (isTurnBusy()) { Store.addNotice('_A reply is still running — wait for it or stop it (Ctrl+C or /stop), then run /goal again._'); return; }
    if (!(dom.window.getActiveMainModelList?.() ?? []).length) { Store.addNotice('_No model is configured. Choose one with `/model <provider>|<model>`, then run /goal again._'); return; }
    setAiJob('goal'); Store.syncRunning();
    try {
        const loop = cmd.op === 'resume' ? (await resumeGoal(host))?.done ?? null : startGoal(cmd.text, host);
        if (loop) await loop;
    } catch (e: any) { Store.addNotice(`Error: ${e?.message ?? String(e)}`); }
    finally { setAiJob(''); Store.syncRunning(); }
}

export function stopAgent(): void {
    try { dom.window.stopNow?.(); } catch {}
}

export function newSession(): void {
    try { dom.window.newChat?.(); } catch {}
}

/** Start a fresh session and clear the screen. Refused while a reply is running: the old turn would keep writing into the new chat, and
 *  the screen would show a conversation the model still carried (TUI report case 012). */
export function startNewSession(): boolean {
    if (isTurnBusy()) {
        Store.addNotice('_A reply is still running — wait for it or stop it (Ctrl+C or /stop) before starting a new session._');
        return false;
    }
    newSession();
    Store.replaceEntries([]);
    return true;
}

/** Send the last user message again in place of the last exchange (/retry, Alt+U). The WebUI's retry reads state that only a browser
 *  send sets, so in the TUI it never did anything, after a finished or a stopped turn alike (TUI report cases 009, 017). */
export async function retryLast(): Promise<void> {
    if (isTurnBusy()) { Store.addNotice('_A reply is still running — stop it (Ctrl+C or /stop) before retrying._'); return; }
    const history = getChatHistory();
    let idx = history.length - 1;
    const textOf = (c: any): string => typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p?.text ?? '').join('') : '';
    while (idx >= 0 && !(history[idx]?.role === 'user' && !/^\s*<nudge>|^\[TASK/.test(textOf(history[idx].content)))) idx--;
    const text = idx >= 0 ? stripInjected(textOf(history[idx].content)) : '';
    if (!text) { Store.addNotice('_Nothing to retry._'); return; }
    setChatHistory(history.slice(0, idx));   // the message and everything the model answered to it
    Store.dropFromLastUser();
    Store.addUserMessage(text);
    await sendMessage(text);
}

/** Show the conversation that is now the chat's history (after a resume), so the screen, /export and the model agree. */
export function showRestoredConversation(): void {
    try {
        Store.replaceEntries(Store.entriesFromHistory(getChatHistory(), { user: s => stripInjected(s), answer: s => _stripTerminal(s) }));
    } catch {}
}

export async function runCompact(): Promise<void> {
    // Compacting rewrites the history a running reply is appending to, and its end used to mark the TUI ready under it.
    if (isTurnBusy()) {
        Store.addNotice('_A reply is still running — wait for it or stop it (Ctrl+C or /stop) before /compact._');
        return;
    }
    Store.addUserMessage('/compact');
    Store.beginLocalOp();
    // Like the WebUI's /compact: its own stop signal (so Stop cancels it and the summary of a cancelled run is dropped), the streaming
    // flag (so queued messages wait for it), and the rebuilt history applied to the chat and saved. It used to discard the returned history:
    // the next ordinary send re-sent the old turns and overwrote the compacted generation (TUI report case 052).
    const ctrl = new AbortController();
    setActiveAbortController(ctrl);
    setAgentStreaming(true);
    const ph = makeTuiPlaceholder() as any;
    try {
        const rebuilt = await (dom.window as any).compactHistory?.(ph);
        if (ctrl.signal.aborted) ph.finalize?.('Compaction stopped.');
        else {
            if (Array.isArray(rebuilt)) setChatHistory(rebuilt);
            try { (dom.window as any).saveHistory?.(); } catch {}
            ph.finalize?.('Compacted.');
        }
    } catch (e: any) {
        Store.addNotice(`Compaction error: ${e?.message ?? String(e)}`);
    } finally {
        if (activeAbortController === ctrl) setActiveAbortController(null);
        setAgentStreaming(false);
        Store.endLocalOp();
        // Messages typed while it ran waited in the queue; nothing else would start them (case 053).
        setTimeout(() => { try { (dom.window as any)._processQueue?.(); } catch {} }, 0);
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

    // --resume <id> restored its history inside setup(); put it on the screen as well.
    if (_resumeId) showRestoredConversation();

    // Bare --resume: a list of this workspace's sessions to choose from (↑/↓, Enter; Esc keeps the new chat). Without the flag a launch
    // is a new chat. FREEWORKER_RESUME (scripted runs, no one to choose) still continues the most recent one.
    if (_resumeRequested && !_resumeId) {
        const sessions = await listWorkspaceSessions();
        if (!sessions.length) {
            Store.addNotice('_No previous sessions for this workspace: this is a new chat._');
        } else if (_resumeIdx >= 0) {
            Store.setActivePanel('resume');
        } else {
            if (await resumeSession(sessions[0].id)) showRestoredConversation();
            _t('main:resume_done');
        }
    }

    // Fresh session (no history loaded from SQLite): classify tools from project
    // context in the background, exactly as createNewChat() does for WebUI.
    if (!(dom.window as any).getChatHistory?.().length) {
        (dom.window as any).classifyTools?.()
            .then(() => _t('main:classifyTools:done'))
            .catch(() => {});
    }

    // Enable X10 mouse click tracking. alternateScreen makes terminal row 0
    // equal Ink's yoga row 0, so coordinate-to-component mapping is exact.
    process.stdout.write('\x1b[?1000h');

    const app = render(React.createElement(TuiApp, { opts }), {
        stdin:           stdinFilter as any,
        exitOnCtrlC:     false,
        alternateScreen: true,
    });
    // Quitting from the app (Ctrl+C when idle) only unmounts Ink; the heartbeat and the DOM's timers
    // would keep the process alive, so end it here.
    app.waitUntilExit().then(() => { _cleanup(); process.exit(0); }, () => { _cleanup(); process.exit(1); });
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
    // A stall is a heartbeat gap with a cause: how long, whether the process was busy (synchronous work) or just not scheduled, and the
    // slow operations in flight. Repeated long ones also reach the screen: a frozen interface should say why.
    const announce = stallAnnouncer(text => Store.addNotice(`_${text}_`), { where: opts.logFile });
    _stopLoopWatch = startLoopWatch(s => {
        try { appendFileSync(opts.logFile, JSON.stringify({ timing: { step: 'stall', ms: s.ms, busy: s.busy, ops: s.ops } }) + '\n', 'utf8'); } catch {}
        announce(s);
    });

    // The same path as a typed message: the user entry appears, the status reads running, and a message typed meanwhile
    // waits in the queue instead of starting a second turn on the same session.
    if (initialPrompt) { Store.addUserMessage(initialPrompt); sendMessage(initialPrompt); }
}

// Save settings on exit, clear timers, and disable mouse protocol.
const _cleanup = () => { try { clearInterval(_heartbeatInterval); _stopLoopWatch?.(); process.stdout.write('\x1b[?1000l'); saveProfile(); _dropCheckpoints(); } catch {} };
process.on('exit',    _cleanup);
process.on('SIGTERM', () => { _cleanup(); process.exit(0); });
process.on('SIGINT',  () => { _cleanup(); process.exit(0); });

main().catch(e => { process.stderr.write(String(e?.stack ?? e) + '\n'); process.exit(1); });
