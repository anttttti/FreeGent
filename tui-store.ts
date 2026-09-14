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
}

export type Entry =
    | { type: 'user'; id: number; text: string }
    | { type: 'turn'; turn: TurnState };

export interface AppState {
    entries:          Entry[];
    activePanel:      string | null;
    agentRunning:     boolean;
    scrollOffset:     number;   // rows scrolled up from bottom in event log
    promptSuggestion: string;   // ghost text shown in the input line after each turn
    queue:            QueuedMsg[];  // pending messages mirrored from JSDOM msg-queue
    ready:            boolean;     // false while setup() is running; input is disabled
}

const _state: AppState = {
    entries:          [],
    activePanel:      null,
    agentRunning:     false,
    scrollOffset:     0,
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

export function finalizeTurn(turn: TurnState, text: string): void {
    turn.done     = true;
    turn.finalText = text;
    _state.agentRunning  = false;
    _notify();
}

export function toggleTurnCollapse(turn: TurnState): void {
    turn.collapsed = !turn.collapsed;
    _notify();
}

export function toggleStepCollapse(step: StepState): void {
    step.collapsed = !step.collapsed;
    _notify();
}

export function toggleStepSection(step: StepState, section: StepSection): void {
    step.openSection = step.openSection === section ? null : section;
    step.collapsed   = false;
    _notify();
}

export function setActivePanel(panel: string | null): void {
    _state.activePanel = _state.activePanel === panel ? null : panel;
    _notify();
}

export function scroll(delta: number): void {
    _state.scrollOffset = Math.max(0, _state.scrollOffset + delta);
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
