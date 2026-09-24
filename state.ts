// state.js — shared mutable state (ES module).
// READS: import { X } — live bindings, no change at call sites.
// WRITES: call setX(v) — updates the module binding.
// Transition bridge: Object.defineProperty on globalThis so unconverted classic
// scripts can still read/write transparently via window.X.

// A2: per-session state. createSession() gives a fresh isolated session; defaultSession
// proxies the module-level globals so all existing call sites work without changes.
//
// Session event log fields (see docs/session-event-log-migration.md):
//   _session:  the Session instance for this agent run; set by registry.create() in
//              headless-runner / workers, or by agentSend() in the browser.
//   _evtTurn:  monotonic turn counter incremented at each runAgentTurn() call;
//              threaded through runTurn() so step events carry the right turn number.
export type AgentSession = {
    // The model's input is this array only for fn-tag models and sessions without an event log.
    // With an event-log session (_session) the input is _session.deriveMessages(); here this array
    // holds only user prompts, nudges and compaction output, so it is not a full transcript.
    history: any[];
    abortController: AbortController | null;
    role: any;
    _toolFilter?: Set<string> | null;
    _session?:  import('./session.ts').Session | null;
    _evtTurn?:  number;
    // §1 per-session state (previously module-level globals)
    softStopPending:       boolean;
    _lastTurnDoneToken:    boolean;
    _lastTurnBlockedToken: boolean;
    workflowMode:         boolean;
    agentStreaming:        boolean;
    currentTurnSkills:    Set<string>;
    _reactiveFired:       Set<string>;
    _failureCounts:       Record<string, number>;
    _seenReadFiles:       Map<string, any>;
    _seenListFiles:       Set<string>;
    _toolCallHistory:     any[];
    lastUserMessageText:  string;
    _currentUserIntent:   string;
    lastProvider:         string;
    // Per-session replace-failure tracking (not proxied to module-level globals)
    _replaceFailures:     Map<string, number>;
    _replaceNudgeSent:    Map<string, number>;
};

export function createSession(init: Partial<AgentSession> = {}): AgentSession {
    return {
        history:             init.history             ?? [],
        abortController:     init.abortController     ?? null,
        role:                init.role                ?? null,
        _toolFilter:         init._toolFilter         ?? null,
        softStopPending:     init.softStopPending     ?? false,
        _lastTurnDoneToken:    init._lastTurnDoneToken    ?? false,
        _lastTurnBlockedToken: init._lastTurnBlockedToken ?? false,
        workflowMode:        init.workflowMode        ?? false,
        agentStreaming:      init.agentStreaming       ?? false,
        currentTurnSkills:   init.currentTurnSkills   ?? new Set(),
        _reactiveFired:      init._reactiveFired      ?? new Set(),
        _failureCounts:      init._failureCounts      ?? {},
        _seenReadFiles:      init._seenReadFiles      ?? new Map(),
        _seenListFiles:      init._seenListFiles      ?? new Set(),
        _toolCallHistory:    init._toolCallHistory    ?? [],
        lastUserMessageText: init.lastUserMessageText ?? '',
        _currentUserIntent:  init._currentUserIntent  ?? '',
        lastProvider:        init.lastProvider        ?? '',
        _replaceFailures:    init._replaceFailures    ?? new Map(),
        _replaceNudgeSent:   init._replaceNudgeSent   ?? new Map(),
    };
}

export let openaiHistory: any[]         = [];
export let agentStreaming: boolean         = false;
export let activePlaceholder: any     = null;
export let activeAbortController: AbortController | null = null;
export let lastProvider: string          = '';
export let softStopPending: boolean         = false;
export let pendingAgentsContextInject: boolean = false; // set by loadAgentsContext; consumed by agent-core turn assembly
export let currentTurnSkills: Set<string>     = new Set();
export let _reactiveFired: Set<string>        = new Set();
export let _failureCounts: Record<string, number>        = {};
export let activeChatId: string | null          = null;
export let _seenReadFiles: Map<string, any>        = new Map();
export let _seenListFiles: Set<string>        = new Set();
export let mainAgentRole: any         = null; // Role object ({name, body, tools, ...}) or null — not a bare string
export let workflowMode: boolean      = false; // true = bench/background agent (must complete without user); false = interactive chat
export let _toolCallHistory: any[]      = [];
export let lastUserMessageText: string   = ''; // last real user message — read by handover/regen logic across files
export let _currentUserIntent: string    = ''; // set at turn start (agent-core); read by edit-intent validation (tools)
export let _lastTurnDoneToken: boolean    = false; // set when a turn declares COMPLETED; read by the Director continuation loop
export let _lastTurnBlockedToken: boolean = false; // set when a turn accepts a BLOCKED declaration; read by the Director continuation loop
export let _sessionToolFilter: Set<string> | null = null; // classifier output; null = use full active tool set

export function setOpenaiHistory(v: any): void         { openaiHistory         = v; }
export function setAgentStreaming(v: any): void        { agentStreaming = v; (window as any).updateRailRecentChats?.(); }
export function setActivePlaceholder(v: any): void     { activePlaceholder     = v; }
export function setActiveAbortController(v: any): void { activeAbortController = v; }
export function setLastProvider(v: any): void          { lastProvider          = v; }
export function setSoftStopPending(v: any): void        { softStopPending        = v; }
// Reset the Director conversation for a fresh episode. Owned here because it is purely a
// state operation over two vars in this module. It previously lived in autopilot.ts, which
// left the live Agent-tab loop (agent-loop.ts) depending on a module that had no UI entry
// point — deleting autopilot would have broken the loop that actually runs.
export function _clearHistory(): void { setOpenaiHistory([]); setLastProvider(''); setSessionToolFilter(null); }
export function setPendingAgentsContextInject(v: any): void { pendingAgentsContextInject = v; }
export function setCurrentTurnSkills(v: any): void     { currentTurnSkills     = v; }
export function setReactiveFired(v: any): void         { _reactiveFired        = v; }
export function setFailureCounts(v: any): void         { _failureCounts        = v; }
export function setActiveChatId(v: any): void          { activeChatId          = v; }
export function setSeenReadFiles(v: any): void         { _seenReadFiles        = v; }
export function setSeenListFiles(v: any): void         { _seenListFiles        = v; }
export function setMainAgentRole(v: any): void         { mainAgentRole         = v; }
export function setWorkflowMode(v: boolean): void      { workflowMode          = v; }
export function setToolCallHistory(v: any): void       { _toolCallHistory      = v; }
export function setLastUserMessageText(v: any): void   { lastUserMessageText   = v; }
export function setCurrentUserIntent(v: any): void     { _currentUserIntent    = v; }
export function setLastTurnDoneToken(v: any): void     { _lastTurnDoneToken    = v; }
export function setLastTurnBlockedToken(v: any): void  { _lastTurnBlockedToken = v; }
export function setSessionToolFilter(v: Set<string> | null): void { _sessionToolFilter = v; }

// defaultSession proxies the module-level globals — existing call sites that pass no
// session get exactly the same behaviour as before A2.
export const defaultSession: AgentSession = {
    get history()              { return openaiHistory; },
    set history(v)             { setOpenaiHistory(v); },
    get abortController()      { return activeAbortController; },
    set abortController(v)     { setActiveAbortController(v); },
    get role()                 { return mainAgentRole; },
    set role(v)                { setMainAgentRole(v); },
    get _toolFilter()          { return _sessionToolFilter; },
    set _toolFilter(v)         { setSessionToolFilter(v); },
    // §1: proxy all per-session globals so code reading defaultSession.X stays consistent
    get softStopPending()      { return softStopPending; },
    set softStopPending(v)     { setSoftStopPending(v); },
    get _lastTurnDoneToken()    { return _lastTurnDoneToken; },
    set _lastTurnDoneToken(v)   { setLastTurnDoneToken(v); },
    get _lastTurnBlockedToken() { return _lastTurnBlockedToken; },
    set _lastTurnBlockedToken(v){ setLastTurnBlockedToken(v); },
    get workflowMode()         { return workflowMode; },
    set workflowMode(v)        { setWorkflowMode(v); },
    get agentStreaming()        { return agentStreaming; },
    set agentStreaming(v)       { setAgentStreaming(v); },
    get currentTurnSkills()    { return currentTurnSkills; },
    set currentTurnSkills(v)   { setCurrentTurnSkills(v); },
    get _reactiveFired()       { return _reactiveFired; },
    set _reactiveFired(v)      { setReactiveFired(v); },
    get _failureCounts()       { return _failureCounts; },
    set _failureCounts(v)      { setFailureCounts(v); },
    get _seenReadFiles()       { return _seenReadFiles; },
    set _seenReadFiles(v)      { setSeenReadFiles(v); },
    get _seenListFiles()       { return _seenListFiles; },
    set _seenListFiles(v)      { setSeenListFiles(v); },
    get _toolCallHistory()     { return _toolCallHistory; },
    set _toolCallHistory(v)    { setToolCallHistory(v); },
    get lastUserMessageText()  { return lastUserMessageText; },
    set lastUserMessageText(v) { setLastUserMessageText(v); },
    get _currentUserIntent()   { return _currentUserIntent; },
    set _currentUserIntent(v)  { setCurrentUserIntent(v); },
    get lastProvider()         { return lastProvider; },
    set lastProvider(v)        { setLastProvider(v); },
    // _replaceFailures/_replaceNudgeSent: direct properties (not proxied to any module-level global —
    // only used inside llm-loops.ts which reads from _s directly).
    _replaceFailures:  new Map(),
    _replaceNudgeSent: new Map(),
};

// Expose setters on globalThis (and window when it differs from globalThis in headless Node.js).
// This bridge is permanent infrastructure for the house pattern: ES modules in JSDOM resolve
// free variables through globalThis; browser code reads through window.  Both paths are needed.
// Bridge to globalThis (for ES modules — free variables resolve against globalThis)
// AND to window (for classic scripts eval'd in dom.window context in Node.js headless).
// In-browser window === globalThis so the second round is a no-op on the same object.
const _setters = {
    setOpenaiHistory, setAgentStreaming, setActivePlaceholder,
    setActiveAbortController, setLastProvider, setSoftStopPending, setPendingAgentsContextInject,
    setCurrentTurnSkills, setReactiveFired, setFailureCounts,
    setActiveChatId, setSeenReadFiles, setSeenListFiles, setMainAgentRole, setWorkflowMode, setToolCallHistory,
    setSessionToolFilter, _clearHistory,
    // §A2: createSession exposed so headless / test code that reads window.createSession can
    // build a proper AgentSession without falling back to the bare {history,abortController,role} stub.
    createSession,
};
const _reactiveProps: Array<[string, () => any, (v: any) => void]> = [
    ['openaiHistory',         () => openaiHistory,         setOpenaiHistory],
    ['agentStreaming',        () => agentStreaming,         setAgentStreaming],
    ['activePlaceholder',     () => activePlaceholder,     setActivePlaceholder],
    ['activeAbortController', () => activeAbortController, setActiveAbortController],
    ['lastProvider',          () => lastProvider,          setLastProvider],
    ['softStopPending',        () => softStopPending,        setSoftStopPending],
    ['pendingAgentsContextInject', () => pendingAgentsContextInject, setPendingAgentsContextInject],
    ['currentTurnSkills',     () => currentTurnSkills,     setCurrentTurnSkills],
    ['_reactiveFired',        () => _reactiveFired,        setReactiveFired],
    ['_failureCounts',        () => _failureCounts,        setFailureCounts],
    ['activeChatId',          () => activeChatId,          setActiveChatId],
    ['_seenReadFiles',        () => _seenReadFiles,        setSeenReadFiles],
    ['_seenListFiles',        () => _seenListFiles,        setSeenListFiles],
    ['mainAgentRole',         () => mainAgentRole,         setMainAgentRole],
    ['workflowMode',          () => workflowMode,          setWorkflowMode],
    ['_toolCallHistory',      () => _toolCallHistory,      setToolCallHistory],
    ['lastUserMessageText',   () => lastUserMessageText,   setLastUserMessageText],
    ['_currentUserIntent',    () => _currentUserIntent,    setCurrentUserIntent],
    ['_lastTurnDoneToken',    () => _lastTurnDoneToken,    setLastTurnDoneToken],
    ['_lastTurnBlockedToken', () => _lastTurnBlockedToken, setLastTurnBlockedToken],
    ['_sessionToolFilter',   () => _sessionToolFilter,   setSessionToolFilter],
];

// Targets: globalThis first (always), then window only when it's a different object
// (i.e., in headless Node.js where globalThis is the Node process global and
// window is dom.window — two distinct realms).
const _bridgeTargets = (typeof window !== 'undefined' && window !== globalThis)
    ? [globalThis, window]
    : [globalThis];

for (const _t of _bridgeTargets) {
    Object.assign(_t, _setters);
    for (const [name, get, set] of _reactiveProps) {
        Object.defineProperty(_t, name, { get, set, enumerable: true, configurable: true });
    }
}
