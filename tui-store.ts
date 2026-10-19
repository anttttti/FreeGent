// Shared mutable state + pub/sub bridge between the imperative placeholder
// callbacks (from llm-loops) and the declarative Ink component tree.

// Mirror of msg-queue.ts types — kept in sync manually; msg-queue runs in JSDOM,
// this module runs in Node.js, so we cannot share the module instance directly.
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
    const flush = () => {
        if (answer) {
            const turn: TurnState = { id: _nextId++, steps: [], systemSteps: [], collapsed: false, done: true, finalText: answer, startTime: Date.now() };
            out.push({ type: 'turn', turn });
        }
        answer = null;
    };
    for (const m of history) {
        if (!m) continue;
        if (m.role === 'user') {
            const raw = textOf(m.content);
            if (/^\s*<nudge>/.test(raw) || /^\[TASK[^\]]*\]/.test(raw)) continue;   // harness messages, not the user's
            const text = clean.user(raw);
            if (!text) continue;
            flush();
            out.push({ type: 'user', id: _nextId++, text });
        } else if (m.role === 'assistant') {
            const text = clean.answer(textOf(m.content)).trim();
            // The lines the harness adds to close a stopped request are not answers.
            if (text && !/^\[(?:The user stopped|Stopped by the user)/.test(text)) answer = text;
        }
    }
    flush();
    return out;
}

export function addStep(turn: TurnState, label: string): StepState {
    const step: StepState = {
        id: _nextId++, label, model: null,
        tokens: { inp: null, out: null },
        prompt: null, request: null, thinking: '', output: '',
        _buf: { thinking: '', output: '' },
        status: 'running', truncatedReason: null,
        startTime: Date.now(), elapsed: 0,
        openSection: null, collapsed: false,
    };
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

export function patchStep(step: StepState, patch: Partial<StepState>): void {
    Object.assign(step, patch);
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
