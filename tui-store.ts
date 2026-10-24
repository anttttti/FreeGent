// Shared mutable state + pub/sub bridge between the imperative placeholder
// callbacks (from llm-loops) and the declarative Ink component tree.

// Mirror of msg-queue.ts types — kept in sync manually; msg-queue runs in JSDOM,
// this module runs in Node.js, so we cannot share the module instance directly.
import { typedText } from './tui-input-history.js';

export type QueueMode = 'steering' | 'queued';
export interface QueuedMsg { id: string; text: string; mode: QueueMode; }

export type StepSection = 'Output' | 'Thinking' | 'Prompt' | 'Request';
export type StepStatus  = 'running' | 'done' | 'aborted' | 'compact' | 'truncated';

export interface StepState {
    id:              number;
    label:           string;
    model:           string | null;
    tokens:          { inp: number | null; out: number | null };
    prompt:          string | null;
    request:         string | null;
    thinking:        string;
    output:          string;
    _buf:            { thinking: string; output: string };
    status:          StepStatus;
    truncatedReason: string | null;
    startTime:       number;
    elapsed:         number;
    openSection:     StepSection | null;
    collapsed:       boolean;
    /** Length of the chat history the model call of this step started from (the Rerun button's anchor); null for steps that cannot be rerun. */
    histLen:         number | null;
    /** The step Rerun cuts from: the model call itself, or for a tool step the model call that made it (it reruns too). */
    anchor:          StepState | null;
}

/** The user message a turn answers, as it stood when it was sent: what Rewind and Rerun go back to. */
export interface TurnOrigin {
    text:       string;
    /** Chat history length before the message (a rewind cuts the history back to it). */
    historyLen: number;
    /** The workspace copy taken before the message (fg-tui keeps the last few), or null. */
    ckptId:     number | null;
    /** provider · model the message was sent with. */
    model:      string;
}

export interface TurnState {
    id:          number;
    steps:       StepState[];
    systemSteps: string[];
    collapsed:   boolean;
    done:        boolean;
    finalText:   string | null;
    startTime:   number;
    /** A notice from the TUI itself ("Resumed session", a refusal, an export path): shown, never part of the conversation or its export. */
    local?:      boolean;
    /** Set for a turn started by a message the user sent: it gets the Rewind and Rerun buttons. */
    origin?:     TurnOrigin;
}

/** A question waiting for one keypress or click (a rewind, a rerun from a step). */
export interface Confirm {
    text:    string;
    choices: Array<{ key: string; label: string; run: () => void }>;
}

export type Entry =
    | { type: 'user'; id: number; text: string }
    | { type: 'turn'; turn: TurnState };

export interface AppState {
    entries:          Entry[];
    activePanel:      string | null;
    agentRunning:     boolean;
    scrollOffset:     number;   // rows scrolled up from bottom in event log
    panelCursor:      number;   // highlighted row of a selectable panel (model, role)
    promptSuggestion: string;   // ghost text shown in the input line after each turn
    queue:            QueuedMsg[];  // pending messages mirrored from JSDOM msg-queue
    ready:            boolean;     // false while setup() is running; input is disabled
    confirm:          Confirm | null;
}

const _state: AppState = {
    entries:          [],
    activePanel:      null,
    agentRunning:     false,
    scrollOffset:     0,
    panelCursor:      0,
    promptSuggestion: '',
    queue:            [],
    ready:            false,
    confirm:          null,
};

let _nextId = 1;
const _listeners  = new Set<() => void>();
const _dirtySteps = new Set<StepState>();
let _flushTimer: ReturnType<typeof setInterval> | null = null;

export function getState(): AppState { return _state; }

export function subscribe(fn: () => void): () => void {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
}

function _notify(): void {
    for (const fn of _listeners) fn();
}

function _startFlush(): void {
    if (_flushTimer) return;
    _flushTimer = setInterval(() => {
        if (!_dirtySteps.size) return;
        for (const s of _dirtySteps) {
            if (s._buf.thinking) { s.thinking += s._buf.thinking; s._buf.thinking = ''; }
            if (s._buf.output)   { s.output   += s._buf.output;   s._buf.output   = ''; }
            s.elapsed = (Date.now() - s.startTime) / 1000;
        }
        _dirtySteps.clear();
        _notify();
    }, 50);
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export function addUserMessage(text: string): void {
    _state.entries.push({ type: 'user', id: _nextId++, text });
    _state.agentRunning = true;
    _state.scrollOffset = 0;
    syncRunning();
    _notify();
}

export function addTurn(): TurnState {
    const turn: TurnState = {
        id: _nextId++, steps: [], systemSteps: [],
        collapsed: false, done: false, finalText: null,
        startTime: Date.now(),
    };
    _state.entries.push({ type: 'turn', turn });
    _notify();
    return turn;
}

// The origin of the next turn: fg-tui sets it when a message is sent, makeTuiPlaceholder takes it for the turn it creates.
let _nextOrigin: TurnOrigin | null = null;
/** Is the history still the one a turn was made from? The message that started it must still stand at the place recorded; a compaction or a rewind that was
 *  followed by new messages can leave a history long enough for the old position and unrelated to it (codex R52-001). True when there is nothing to compare. */
export function originStillValid(origin: TurnOrigin | undefined, history: readonly any[]): boolean {
    if (!origin) return true;
    const at = history[origin.historyLen];
    return !!at && at.role === 'user' && typedText(at) === origin.text.trim();
}
export function setNextTurnOrigin(o: TurnOrigin | null): void { _nextOrigin = o; }
export function takeTurnOrigin(): TurnOrigin | undefined { const o = _nextOrigin; _nextOrigin = null; return o ?? undefined; }

/** Take away a turn's steps from `step` on (a rerun from it), and everything shown after the turn; the turn is open again. */
export function truncateFromStep(turn: TurnState, step: StepState): void {
    const i = turn.steps.indexOf(step);
    if (i < 0) return;
    turn.steps.splice(i);
    turn.done = false; turn.finalText = null; turn.collapsed = false;
    const at = _state.entries.findIndex(e => e.type === 'turn' && e.turn === turn);
    if (at >= 0) _state.entries.splice(at + 1);
    _notify();
}

/** Take a turn, the user message before it and everything after off the screen (a rewind to before that message). */
export function truncateFromTurn(turn: TurnState): void {
    const at = _state.entries.findIndex(e => e.type === 'turn' && e.turn === turn);
    if (at < 0) return;
    const from = at > 0 && _state.entries[at - 1].type === 'user' ? at - 1 : at;
    _state.entries.splice(from);
    _state.scrollOffset = 0;
    _notify();
}

/** The last turn started by a message the user sent. */
export function lastOriginTurn(): TurnState | null {
    for (let i = _state.entries.length - 1; i >= 0; i--) {
        const e = _state.entries[i];
        if (e.type === 'turn' && e.turn.origin) return e.turn;
    }
    return null;
}

export function askConfirm(c: Confirm | null): void { _state.confirm = c; _notify(); }

/** A local notice: shown like a reply, but not part of the conversation (it is left out of /export). */
export function addNotice(text: string): void {
    const t = addTurn();
    t.local = true;
    finalizeTurn(t, text);
}

/** Drop the last user message and everything after it from the screen (a retry sends that message again). */
export function dropFromLastUser(): void {
    let i = _state.entries.length - 1;
    while (i >= 0 && _state.entries[i].type !== 'user') i--;
    if (i >= 0) _state.entries.splice(i);
    _notify();
}

/** Replace everything shown (a session was resumed, or cleared). */
export function replaceEntries(entries: Entry[]): void {
    _state.entries.splice(0, _state.entries.length, ...entries);
    _state.scrollOffset = 0;
    _notify();
}

/** What a saved conversation looks like in the event log: each user message, and the last text answer that followed it. `clean` strips
 *  the context the harness put in front of the user's words and the terminal token from the answer. */
export function entriesFromHistory(history: any[], clean: { user: (s: string) => string; answer: (s: string) => string }): Entry[] {
    const textOf = (c: any): string => typeof c === 'string' ? c
        : Array.isArray(c) ? c.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join('') : '';
    const out: Entry[] = [];
    let answer: string | null = null;
    let origin: TurnOrigin | undefined;
    const flush = () => {
        if (answer) {
            const turn: TurnState = { id: _nextId++, steps: [], systemSteps: [], collapsed: false, done: true, finalText: answer, startTime: Date.now(), origin };
            out.push({ type: 'turn', turn });
        }
        answer = null; origin = undefined;
    };
    for (let hi = 0; hi < history.length; hi++) {
        const m = history[hi];
        if (!m) continue;
        if (m.role === 'user') {
            // The same rule as the composer's message history: a person's own message (the task pin unwrapped), not a nudge, a tool result in text mode,
            // the compaction summary or a /goal turn. Those were shown as the user's words and became the target of Rerun (codex R53-001).
            const text = typedText(m);
            if (text === null) continue;
            flush();
            out.push({ type: 'user', id: _nextId++, text });
            // A resumed conversation can be rewound and rerun from its messages too (the history is known; the workspace copy is not).
            origin = { text, historyLen: hi, ckptId: null, model: '' };
        } else if (m.role === 'assistant') {
            const text = clean.answer(textOf(m.content)).trim();
            // The lines the harness adds to close a stopped request are not answers.
            if (text && !/^\[(?:The user stopped|Stopped by the user)/.test(text)) answer = text;
        }
    }
    flush();
    return out;
}

export function addStep(turn: TurnState, label: string, rerun?: { histLen: number; anchor: StepState | null }): StepState {
    const step: StepState = {
        id: _nextId++, label, model: null,
        tokens: { inp: null, out: null },
        prompt: null, request: null, thinking: '', output: '',
        _buf: { thinking: '', output: '' },
        status: 'running', truncatedReason: null,
        startTime: Date.now(), elapsed: 0,
        openSection: null, collapsed: false,
        histLen: rerun?.histLen ?? null, anchor: null,
    };
    step.anchor = rerun ? (rerun.anchor ?? step) : null;
    turn.steps.push(step);
    _notify();
    return step;
}

export function addSystemStep(turn: TurnState, label: string): void {
    turn.systemSteps.push(label);
    _notify();
}

export function bufferAppend(step: StepState, text: string, type?: string): void {
    if (type === 'thinking') step._buf.thinking += text;
    else                     step._buf.output   += text;
    _dirtySteps.add(step);
    _startFlush();
}

export function flushStep(step: StepState): void {
    if (step._buf.thinking) { step.thinking += step._buf.thinking; step._buf.thinking = ''; }
    if (step._buf.output)   { step.output   += step._buf.output;   step._buf.output   = ''; }
    _dirtySteps.delete(step);
}

// A step's request is the whole conversation as sent, so each step of a long run holds a larger copy of the history than the one before:
// a few hundred steps were hundreds of MB of strings nobody opens. The latest steps keep theirs whole; older ones keep their start.
const _KEEP_WHOLE = 24, _KEPT_CHARS = 6000;
const _withRequest: StepState[] = [];
function _trimOldRequests(): void {
    while (_withRequest.length > _KEEP_WHOLE) {
        const old = _withRequest.shift()!;
        for (const k of ['request', 'prompt'] as const) {
            const v = old[k];
            if (typeof v === 'string' && v.length > _KEPT_CHARS + 200) old[k] = `${v.slice(0, _KEPT_CHARS)}\n… [${(v.length - _KEPT_CHARS).toLocaleString('en-US')} more characters dropped to save memory]`;
        }
    }
}
export function patchStep(step: StepState, patch: Partial<StepState>): void {
    Object.assign(step, patch);
    if (typeof patch.request === 'string' || typeof patch.prompt === 'string') { const at = _withRequest.indexOf(step); if (at < 0 || at !== _withRequest.length - 1) { if (at >= 0) _withRequest.splice(at, 1); _withRequest.push(step); } _trimOldRequests(); }   // one entry per step, newest last: evicting an old position cannot trim a step still being updated
    _notify();
}

/** Close a turn entry. Whether the agent is still working is not decided here (see syncRunning): a local notice, a
 *  resumed-session list or a finished /compact used to switch the status to ready while a reply was still running,
 *  and the next message then started a second turn on the same session (TUI report cases 038, 054, 082). */
export function finalizeTurn(turn: TurnState, text: string): void {
    turn.done     = true;
    turn.finalText = text;
    syncRunning();
    _notify();
}

// ── What "running" means ─────────────────────────────────────────────────────
// The status and the input queue follow the real work: turns and sends in flight (the probe fg-tui installs), plus
// local operations such as /compact. A message sets the status at once; it is cleared only after the work has stayed
// finished for two checks, so the gap between one queued turn ending and the next starting does not flash "ready".
let _busyProbe: (() => boolean) | null = null;
let _localOps = 0;
let _idleChecks = 0;
let _syncTimer: ReturnType<typeof setInterval> | null = null;
export const SYNC_INTERVAL_MS = 40;

export function setBusyProbe(fn: (() => boolean) | null): void { _busyProbe = fn; }
/** Forget running state and timers (tests, and a fresh start of the store). */
export function resetRunning(): void {
    if (_syncTimer) clearInterval(_syncTimer);
    _syncTimer = null; _localOps = 0; _idleChecks = 0; _state.agentRunning = false;
}
function _busy(): boolean { return _localOps > 0 || (_busyProbe ? !!_busyProbe() : false); }
/** A local operation (not an agent turn) that keeps the status at "running" until it ends. */
export function beginLocalOp(): void { _localOps++; _state.agentRunning = true; syncRunning(); _notify(); }
export function endLocalOp(): void { _localOps = Math.max(0, _localOps - 1); syncRunning(); }
/** Bring the running flag in line with the work in flight; the flag goes back to false only after it stayed idle. */
export function syncRunning(): void {
    _idleChecks = 0;
    if (_syncTimer) return;
    _syncTimer = setInterval(() => {
        if (_busy()) { _idleChecks = 0; if (!_state.agentRunning) { _state.agentRunning = true; _notify(); } return; }
        if (++_idleChecks < 2) return;
        clearInterval(_syncTimer!); _syncTimer = null; _idleChecks = 0;
        if (_state.agentRunning) { _state.agentRunning = false; _notify(); }
    }, SYNC_INTERVAL_MS);
    (_syncTimer as any).unref?.();
}

export function toggleTurnCollapse(turn: TurnState): void {
    turn.collapsed = !turn.collapsed;
    _notify();
}

export function toggleStepSection(step: StepState, section: StepSection): void {
    step.openSection = step.openSection === section ? null : section;
    step.collapsed   = false;
    _notify();
}

export function setActivePanel(panel: string | null): void {
    _state.activePanel = _state.activePanel === panel ? null : panel;
    _state.panelCursor = 0;
    _notify();
}

/** Move the highlight of a selectable panel by `delta` rows, staying inside its `count` rows. */
export function movePanelCursor(delta: number, count: number): void {
    _state.panelCursor = Math.min(Math.max(0, count - 1), Math.max(0, _state.panelCursor + delta));
    _notify();
}

let _scrollLimit = Infinity;
/** The largest scroll offset the log can use right now (set by the log as it renders). A stored offset above it made the first
 *  reverse scroll do nothing (TUI report case 070). */
export function setScrollLimit(n: number): void {
    _scrollLimit = Math.max(0, n);
    if (_state.scrollOffset > _scrollLimit) { _state.scrollOffset = _scrollLimit; _notify(); }
}
export function scroll(delta: number): void {
    _state.scrollOffset = Math.max(0, Math.min(_scrollLimit, _state.scrollOffset + delta));
    _notify();
}

export function setPromptSuggestion(text: string): void {
    _state.promptSuggestion = text ?? '';
    _notify();
}

/** Mirror the JSDOM msg-queue into the TUI store so components re-render on changes. */
export function setQueue(items: QueuedMsg[]): void {
    _state.queue = items;
    _notify();
}

/** Mark setup as complete so the input line activates. */
export function setReady(): void {
    _state.ready = true;
    _notify();
}
