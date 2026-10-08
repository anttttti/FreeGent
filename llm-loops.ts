import { collectRanAsBash } from './step-shared.js';
import { runtime } from './runtime.js';
import { activeAbortController, softStopPending, activeChatId, mainAgentRole, workflowMode, lastUserMessageText, type AgentSession, defaultSession, setReactiveFired, _reactiveFired, currentTurnSkills, setSessionToolFilter, setLastTurnDoneToken, setLastTurnBlockedToken } from './state.js';
import { _fpTrunc, _updateStuckDetector, _checkTextResponse, _updateEnvFailureDetector, updateFailStreak, noteAgentFiles, failStreakKind, failureSignature, sameErrorStreak, sameErrorNudge, newRepeatGuard, sameOutputMsg, _callSig, _resultSig, _repeatRefused, _repeatCount, _updateRepeatGuard, _repeatRefusalResult, _pathSig, _pathRepeatRefused, _pathRepeatCount, _pathRepeatRefusalResult, _creditProgress, REPEAT_REFUSALS_BEFORE_STOP, REPEAT_WINDOW } from './detectors.js';
import { _BLOCKED_DECLARATION_RE, _isComplete, _handleTurnState, _stripTerminal } from './turn-protocol.js';
import { validateOutput, AGENT_TOOL_NAMES, RESULT_MARKERS_RE } from './step-validator.js';
import { emitNudge } from './nudge-emitter.js';
import { parseContextOverflow, fmtDelay, sleepInterruptible, withRetry, asTransportError, _makeOAIRetryHandler, _httpErrorFromResponse, _parseRetryAfter } from './retry.js';
import { _endpointNeedsProbe, knownLimitWaitMs, recordRequest, recordSuccess, recordCacheCapable, _isRateLimit, _isServerError, _markCooldown, _markFlatCooldown, _markExactCooldown, _isCoolingDown, getCooldownRemaining, oaiEndpoint, _defaultEndpoint, specToEndpoint, _anyFreeSpec, getRateLimitFallbackEndpoint, _nextRotationSpec, modelFriendlyName } from './model-router.js';
import { _normPath, _invalidateReadDedup, resetSeenReadFiles, _historyResult, pruneSessionHistory, repairOAIHistory } from './history.js';
import { stripInjected, parseArgs } from './history-util.js';
import { _repairToolCallArgs, _repairToolNames, _repairExecCodeArgs, _repairXmlPseudoCalls, _repairLongcatPseudoCalls, _repairBracketPseudoCalls, _repairInlinePseudoCalls, _repairArgEnvelope, repairAllToolCalls } from './tool-call-repair.js';
import { buildSystemPrompt } from './system-prompt.js';
import { reactiveSkillGuidance, completionGateGuidance } from './skill-guidance.js';
import { getModelToolFormat, parseFnTagCalls, recordToolFormat, isToolFormatListed, isToolsRejectedError } from './model-caps.js';
import { isCustomEndpoint, buildChatPayload, buildRequestMessages, fnTagMessages } from './payload-builder.js';
import { buildOAITools, activeTools } from './tool-schemas.js';
import { streamOAICompat, nonStreamOAICompat, decodeOAIResponse } from './stream-decode.js';
import { compactHistory } from './llm-shared.js';
import { _lcsDiff, _diffContent } from './diff-utils.js';
import { type RenderAdapter, NULL_RENDER_ADAPTER } from './render-adapter.js';
import { KEYS, getProvider, getTemperature, modelSupportsThinking, getWorkerThinkingBudget, thinkingLevelBudget, getOAIContextTokens, getAgentMaxSteps, getAgentProactiveCompact, getAgentCompactTokens, getContextThreshold, isContextSizeKnown, getAgentCompactAt, estimateTokens, getSamplingParams, getLocalApiProxy, ls, enabledTools, getActiveMainModelList, getEndpointRotation, getPreserveThinking, recordModelSuccess } from './config.js';
import { executeToolAsync, toolLabel } from './tools.js';
import { agentReadFile, agentFileMtime } from './workspace.js';
import { convoLogTurn, _updateLogBadge } from './convo-log.js';
import { sessionSaveRawMessage } from './session-store.js';
import { registry } from './session-registry.js';
import { compactSurface, type Session } from './session.js';
import { type SurfaceIntent } from './session-event.js';
import { connectSignal } from './abort.js';

// Typed alias for Session.append called with a known surface event type.
// The conditional `surfaceIntent?` parameter defeats inference at call sites
// that pass a runtime string; this cast keeps the intent without losing safety.
type _AppendSurface = (type: string, data: unknown, intent: SurfaceIntent) => void;

// llm-loops.js — FreeGent: LLM loops (unified OAI format with Gemini API support)
// Depends on: config.js, tools.js, llm-shared.js, workers.js, convo-log.js

const FETCH_TIMEOUT_MS        = 90_000;       // 90 s for cloud APIs
const FETCH_TIMEOUT_CUSTOM_MS = 5 * 60_000;   // 5 min for local servers (slow models)

// ── Session event log helpers ───────────────────────────
// These never throw to the caller — failures in the event log MUST NOT break
// the existing history path. All appends are wrapped in try/catch.

/**
 * Return the Session whose event log is the given AgentSession's history, or null.
 */
function _getEvtSession(s: AgentSession): Session | null {
    return s._session ?? null;
}

/** Safe wrapper: append an event to the session log, silently ignoring errors. */
function _evtAppend(
    s:       AgentSession,
    type:    string,
    data:    unknown,
    intent?: SurfaceIntent,
): void {
    try {
        const sess = _getEvtSession(s);
        if (!sess) return;
        (sess.append as _AppendSurface)(type, data, intent as SurfaceIntent);
    } catch (e) {
        // Never propagate — event log failures are non-fatal — always catch and continue.
        if (typeof console !== 'undefined') console.warn('[session-event] append failed:', e);
    }
}

/** Append a user message to the event log (the session's history). */
function _addUserMessage(s: AgentSession, content: string): void {
    _evtAppend(s, 'user/message', { role: 'user', content }, { surfaceOp: 'append' });
}

/**
 * Shadow the surface with a compacted history (anchor, summary, tail).
 * Called with compactHistory()'s result so deriveMessages() stays in sync with
 * what the LLM will receive on the next callOAI() call.
 *
 * @param sess       - active Session; caller verifies it is non-null
 * @param oldSurf    - snapshot of session.surface taken BEFORE compactHistory ran
 * @param newHistory - the compacted history compactHistory returned
 */
function _mirrorCompactionToSession(
    sess:       Session,
    oldSurf:    readonly number[],
    newHistory: any[],
): void {
    try {
        if (oldSurf.length < 2) return; // only anchor or empty — nothing to compact
        const firstHidden = oldSurf[1];                  // first event after anchor
        const lastHidden  = oldSurf[oldSurf.length - 1]; // last event in old surface

        // newHistory[0] = anchor (already in session as surf[0])
        // newHistory[1] = compaction summary text (starts with '[SYSTEM: The conversation history')
        // Guard: bail if newHistory[1] is not a compaction summary. compactHistory always
        // produces one (a failure stub when the summarizer fails), so this is defensive.
        const summaryMsg = newHistory[1];
        if (!summaryMsg?.content) return; // unexpected: no summary
        if (typeof summaryMsg.content !== 'string' ||
            !summaryMsg.content.startsWith('[SYSTEM: The conversation history')) return;

        // Shadow [firstHidden..lastHidden] with the summary.
        compactSurface(sess, summaryMsg.content, firstHidden, lastHidden);

        // Re-append items from newHistory[2+] as new surface events
        // (they were in the old surface and are now shadowed; we create fresh events
        //  so the surface ordering is correct: summary → tail).
        const _sessAppend = sess.append.bind(sess) as _AppendSurface;
        for (let _ci = 2; _ci < newHistory.length; _ci++) {
            const _cm = newHistory[_ci];
            if (!_cm) continue;
            if (_cm.role === 'user' && _cm.content) {
                // Skip bare [SYSTEM: Continue...] filler — not needed in session
                if (_cm.content === '[SYSTEM: Continue where you left off.]') continue;
                _sessAppend('user/message',
                    { role: 'user', content: _cm.content },
                    { surfaceOp: 'append' });
            } else if (_cm.role === 'assistant' && (_cm.content || _cm.tool_calls?.length)) {
                _sessAppend('assistant/message',
                    { turn: 0, step: 0, message: {
                        role: 'assistant', content: _cm.content ?? null,
                        ...(_cm.tool_calls?.length ? { tool_calls: _cm.tool_calls } : {}),
                    } },
                    { surfaceOp: 'append' });
            } else if (_cm.role === 'tool') {
                _sessAppend('tool/result',
                    { turn: 0, step: 0,
                      callId: _cm.tool_call_id ?? `cmp_${_ci}`, name: _cm.name ?? 'unknown',
                      content: _cm.content ?? '' },
                    { surfaceOp: 'append' });
            }
        }
    } catch (e) {
        if (typeof console !== 'undefined') console.warn('[session-event] mirrorCompaction failed:', e);
    }
}

/** The session's history as the model sees it (native shape), read from the live event log. */
function _histR(s: AgentSession): any[] {
    return _getEvtSession(s)?.deriveMessages() ?? [];
}

/**
 * Surface-replace the most recent assistant/message event on the session.
 * Used to retroactively patch the event log when the main loop discovers the
 * model's last response needs rewriting (pseudo-call repair, truncation, tombstone).
 *
 * `buildMsg(existingMessage)` receives the existing message field from the event
 * data and returns the replacement message object. Called only when the last surface
 * event is confirmed to be an assistant/message — callers don't need to guard.
 *
 * No-ops silently when there is no session, or the last event isn't assistant/message.
 */
function _replaceLastAssistantSurface(
    s:        AgentSession,
    step:     number,
    buildMsg: (existingMsg: any) => any,
    label:    string,
): void {
    const sess = _getEvtSession(s);
    if (!sess) return;
    const seq = sess.surface[sess.surface.length - 1];
    if (seq === undefined || sess.events[seq]?.type !== 'assistant/message') return;
    const d = sess.events[seq].data as any;
    try {
        (sess.append as _AppendSurface)('assistant/message',
            { turn: d.turn ?? 0, step: d.step ?? step, message: buildMsg(d.message) },
            { surfaceOp: { op: 'replace', start: seq, end: seq } });
    } catch (e) {
        console.warn(`[session-event] ${label} surface replace failed:`, e);
    }
}


// Timestamp of the last streamed token received from the LLM — updated by callOAI
// on every onChunk call. Used by init.ts to distinguish OS suspend (no chunks arrive
// while JS is frozen) from a benign desktop tab switch (chunks keep arriving).
// Initialised to now so visibilitychange on first load never sees a stale zero.
let _lastStreamChunkAt: number = Date.now();
window._lastStreamChunkAt = _lastStreamChunkAt;

// When a turn switches to a fallback model due to persistent 429s, this is
// stored so subsequent turns (agentSend calls) in the same episode don't
// reset back to the original model. Cleared when a new chat is created.
let _sessionFallback = null; // null | { provider, url?, key?, model }

// System prompt, tool list and messages of the most recent main-agent request, exactly as sent.
// Forked workers (run_workers role "director") resend them verbatim plus their subtask, so
// their request shares the main agent's prefix byte for byte and the endpoint's prefix cache
// covers the inherited history.
export type ForkBase = { system: string; tools: any[] | null; messages: any[] };
let _lastMainRequest: ForkBase | null = null;
export function getLastMainRequest(): ForkBase | null { return _lastMainRequest; }
let _forceToolCall = false;  // set by enforcement nudges (completion_gate, step_validation, etc.); consumed+cleared by callOAI

// Rotation step counter — reset at each new turn; passed to model-router's _nextRotationSpec.
const _rotState = { step: 0 };

// _endpointCooldown, _endpointHits, RATE_LIMIT_COOLDOWN_MS, RATE_LIMIT_MAX_MS,
// _isRateLimit, _isServerError, _markCooldown, _markFlatCooldown, _isCoolingDown,
// getCooldownRemaining, _anyFreeSpec, getRateLimitFallbackEndpoint — defined in llm-shared.js

export function clearSessionFallback(): void { _sessionFallback = null; }
// clearReplaceState: clear replace-failure tracking on the given session (or defaultSession).
// Called from agent-core via window.clearReplaceState() on new chat / rewind.
export function clearReplaceState(session?: import('./state.ts').AgentSession): void {
    const _s = session ?? defaultSession;
    _s._replaceFailures  = new Map();
    _s._replaceNudgeSent = new Map();
}

// finish_reason category sets — used by the truncation detector to decide whether to
// retry (cycle model pool) and how to label the event in logs. Module-level so the
// Sets are allocated once, not per-call.
//   TOKEN_CAP  — provider hit the response token limit; 'OTHER' is Gemini's catch-all.
//   FILTERED   — safety / content filter; different model may respond.
//   FR_ERROR   — server-side error surfaced as finish_reason inside a 200 response.
//   NORMAL     — well-formed completion; no retry action.
// 'repetition': stream-decode stopped a degenerate (repeating) output early — handled as a cut-off.
const _FR_TOKEN_CAP = new Set(['length', 'MAX_TOKENS', 'max_tokens', 'OTHER', 'other', 'repetition']);
const _FR_FILTERED  = new Set(['content_filter', 'SAFETY', 'filtered', 'RECITATION']);
const _FR_ERROR     = new Set(['error', 'abort']);
// Set by stream-decode when the stream went silent mid-response (SSE idle timeout).
const _FR_STALLED   = new Set(['idle_timeout']);
// Normal finish reasons (stop, end_turn, tool_calls, …) are never checked — fall-through is the normal path.

// Per-turn tool-call cap — legitimate parallel batches never exceed this; higher counts
// indicate runaway call storms (e.g. astropy-7746: 163 calls in one turn).
const _MAX_CALLS_PER_TURN = 20;

// Fraction of the response-token budget at which we treat output as truncated and discard
// the response, compact, and retry.
const _TOKEN_FILL_RATIO = 0.98;

// Absolute per-step output cap for local endpoints (plus any thinking budget). v0.54 steps used
// 76 output tokens at the median and <2K at p99; the old 25%-of-context cap (15K at 60K) only let
// degenerate "reasoning in code comments" tool calls run for ~107 s each before being cut off.
const _STEP_OUTPUT_CAP = 8192;

// Tail chars kept from a file-read result for the per-file snippet map (used in step diffs).
const _FILE_SNIP_TAIL = 500;
// …and for the file read last before a compaction (see the post-compaction file block).
const _FILE_SNIP_LAST = 4000;

// Max entries in _repeatCache before oldest entries are evicted (FIFO). Each entry can
// hold a full read_file result (up to _READ_INLINE_MAX chars), so cap at 150 entries
// to bound peak memory at ~7.5 MB for large reads.
const _REPEAT_CACHE_MAX = 150;

// Consecutive all-failing tool turns before the loop bails with a graceful synthesis.
const _MAX_CONSEC_TOOL_FAILS = 10;

// Role-mode step cap — tighter than the main-agent budget; emits BLOCKED rather than synthesising.
const _ROLE_STEP_CAP = 60;

// File extensions that a coder worker can edit directly (used in replace_in_file delegation nudge)
const CODE_FILE_RE = /\.(js|ts|py|css|html|sh|json|yaml|yml)$/i;

function _toolErrorHint(name: string): string {
    return {
        read_file:       'Verify the path exists. Use start_line/end_line for large files.',
        search_workspace:  'Use a simpler single-word pattern. path_filter accepts pipe-separated substrings (e.g. "foo.js|bar.js").',
        replace_in_file: 'old_string must match exactly (whitespace, quotes, indentation). Read the file first to confirm.',
        write_file:      'Ensure parent directory exists. content must be a non-empty string.',
        // Pyodide-specific advice only applies when there is no native execution (browser).
        execute_code:    runtime.hasNativeExec
            ? 'Fix the error above and retry.'
            : 'Fix the error above. Pyodide notes: no subprocess/os.system; install missing packages with `import micropip; await micropip.install(["pkg"])`; use the fetch_url tool for HTTP requests.',
        fetch_url:       'Confirm the URL is correctly formatted and the server is reachable.',
    }[name] || 'Review the error message above and retry with corrected parameters.';
}

// Truncates the large text fields of a tool result before storing in history.
// The model sees the full result in the current turn; only history is capped.

// _replaceFailures / _replaceNudgeSent are now per-session (on AgentSession).
// _trackReplaceFailure / _getReplaceFailNudge receive them as parameters from runTurn().

// After a successful write_file, replace the full file content in the stored
// assistant message with a unified diff vs. the previous version.
// Uses LCS to produce correct multi-hunk diffs for scattered changes.

async function _readOldContent(path: string): Promise<string | null> {
    try { return await agentReadFile(path); } catch { return null; }
}


// Rewrite tool-call arguments of the last assistant message, by call id. Native sessions: the
// event log is what the next request reads (deriveMessages), so surface-replace the event.
// Must run before the step's tool results are appended.
function _patchLastAssistantArgs(s: AgentSession, step: number, edits: Map<string, (a: any) => any>): void {
    const apply = (tcs: any[]) => tcs.map((tc: any) => {
        const f = edits.get(tc.id);
        if (!f) return tc;
        try { return { ...tc, function: { ...tc.function, arguments: JSON.stringify(f(JSON.parse(tc.function.arguments))) } }; }
        catch { return tc; }
    });
    const sess = _getEvtSession(s);
    if (!sess) return;
    const seq = sess.surface[sess.surface.length - 1];
    if (seq === undefined || sess.events[seq]?.type !== 'assistant/message') return;
    const d = sess.events[seq].data;
    if (!d.message?.tool_calls?.length) return;
    const msg = { ...d.message, tool_calls: apply(d.message.tool_calls) };
    try {
        (sess.append as _AppendSurface)('assistant/message',
            { turn: d.turn ?? 0, step: d.step ?? step, message: msg },
            { surfaceOp: { op: 'replace', start: seq, end: seq } });
    } catch (_e) { console.warn('[session-event] tool-call args surface replace failed:', _e); }
}

function _patchOAIWriteArgs(assistantMsg: any, diffs: Map<string, string>): void {
    // diffs: Map<tool_call_id, diffString>
    if (!assistantMsg?.tool_calls?.length || !diffs.size) return;
    for (const tc of assistantMsg.tool_calls) {
        const d = diffs.get(tc.id);
        if (!d) continue;
        try {
            const args = JSON.parse(tc.function.arguments);
            args.content = d;
            args._contentCompressed = true;
            tc.function.arguments = JSON.stringify(args);
        } catch {}
    }
}

// 'percent' mode: fraction of the model's context window (requires proactive compact enabled).
// 'tokens'  mode: fixed token count regardless of context window size.
// Proactive compact being OFF means compact only at the hard context limit (100%).
function _compactThreshold(): number {
    if (!getAgentProactiveCompact()) return getContextThreshold();
    const tokens     = getAgentCompactTokens(); // 0 = disabled
    const pctUsable  = isContextSizeKnown();    // skip % when context size is a guess
    if (!pctUsable)  return tokens > 0 ? tokens : getContextThreshold();
    const pct = getContextThreshold() * getAgentCompactAt();
    return tokens > 0 ? Math.min(pct, tokens) : pct;
}

// ── Per-step loop helpers (shared across loop steps) ──────────────────────

// Track replace_in_file outcomes. On error: increment counter + evict read cache.
// On success: clear counter so nudge resets.
// _replFails / _replNudge are the session-local maps from runTurn().
function _trackReplaceFailure(fp: string, isError: boolean, _replFails: Map<string, number>): void {
    const normFp = _normPath(fp);
    if (isError) {
        _replFails.set(normFp, (_replFails.get(normFp) || 0) + 1);
    } else {
        _replFails.delete(normFp);
    }
    // Always evict read cache for the edited file — success or failure —
    // so any subsequent read returns the current content, not the pre-edit snapshot.
    _invalidateReadDedup(fp);
}

// Returns a delegation nudge string when replace_in_file has failed ≥2 times on the same file,
// or null if no nudge is needed.
async function _getReplaceFailNudge(_replFails: Map<string, number>, _replNudge: Map<string, number>): Promise<string | null> {
    if (!_replFails || !_replNudge) return null; // guard against fallback session stubs
    for (const [fp, n] of _replFails) {
        if (n < 2) continue;
        const sent = _replNudge.get(fp) || 0;
        if (sent >= 3) { _replFails.delete(fp); _replNudge.delete(fp); continue; }
        _replNudge.set(fp, sent + 1);
        const isCodeFile = CODE_FILE_RE.test(fp);
        if (isCodeFile) {
            const _patchTip = enabledTools.has('apply_patch')
                ? ' Try apply_patch with a proper unified diff instead — it handles offset mismatches. If apply_patch also fails, spawn'
                : ' Spawn';
            return `[DELEGATE EDIT] replace_in_file has failed ${n} times on "${fp}".${_patchTip} a coder worker whose sole task is to make this edit, providing the exact change needed.`;
        }
        let content = '';
        try { content = await agentReadFile(fp); } catch {}
        const preview = content.length > 20_000 ? content.slice(0, 20_000) + '\n...[truncated — ' + content.length + ' chars total; read_file with start_line for the rest]' : content;
        return `[EDIT FAILED ${n}x on "${fp}"] Current file content:\n\`\`\`\n${preview}\n\`\`\`\nCopy the old_string character-for-character from the content above. Do not paraphrase or reconstruct from memory.`;
    }
    return null;
}

// The task as given: the first user message without the post-compaction [TASK …] pin and
// without injected framework blocks. The raw message starts with the guidance prelude, so
// slicing it yielded guidance boilerplate (551/558 v0.54 tasks) and its pytest examples were
// read as graded tests.
export function _originalTask(hist: any[]): string {
    const m = hist.find((x: any) => x.role === 'user' && typeof x.content === 'string' && x.content.trim());
    return m ? stripInjected(m.content.replace(/^\[TASK[^\]]*\]\n/, '')) : '';
}

// Returns the role to use when injecting a framework nudge into OAI history.
// Mid-conversation system messages work on vLLM/SGLang and NVIDIA endpoints.
// Mistral and most hosted APIs only reliably support system at position 0.
function _nudgeRole(provider: string | null): 'system' | 'user' {
    // nvidia uses raw ChatML via their API which supports mid-conversation system turns.
    // custom (vLLM/HuggingFace) chat templates often forbid system after turn 0 (e.g. Qwen3),
    // so use user role with <nudge> wrapping for safety.
    return provider === 'nvidia' ? 'system' : 'user';
}

// Shared tool execution (Issue 8 slice 2 — see notes/refactor-loop-and-tools.md). The
// execute + error-wrap + tracking + step-box UI loop is shared with runTurn;
// calls are normalized to {name, args} and
// call this. Returns [{name, args, result}] in call order (Promise.all preserves order).
//   normCalls : [{name, args}]
//   toolTasks : per-call step-box handles (parallel to normCalls), or null (workers use onStart)
//   opts.forWorker  : suppresses main-agent-only replace-failure tracking
//   opts.context    : passed to executeToolAsync (workers pass their workspace context)
//   opts.onStart    : (name, args, i) before execution — workers render their own inline UI here
//   opts.onTaskDone : called when an update_task_status("done") runs this step
//   opts.onResult   : (name, args, result) side-effect at completion time (e.g. convo-log)
const _WRITE_TOOLS = new Set(['write_file', 'apply_patch', 'replace_in_file', 'delete_file', 'execute_code']);
// Read-only tools whose success should NOT reset the consecutiveToolFails counter.
// An ls or read_file between failing attempts would otherwise mask a repeated-failure
// loop (flask-4992: hit 7 consecutive fails but ls resets kept it running for 5.7M tokens).
const _READ_ONLY_TOOLS = new Set(['read_file', 'list_files', 'search_workspace', 'fetch_url']);
// Workspace reads that a stuck turn can do without for a couple of steps (see _stepPausedTools).
const _PAUSABLE_READ_TOOLS = new Set(['read_file', 'list_files', 'search_workspace']);

// ── Overlapping-read guard ───────────────────────────────────────────────────
// The repeat cache only catches byte-identical calls. A model can instead rotate through
// overlapping line ranges of one file (200-250, 200-350, 210-350, …): every call differs, the
// stuck detector never sees three identical results, and pruning stubs the older ranges so the
// cycle continues — SWE-bench Lite v0.55 sympy-18189 spent 88 steps this way, and v0.55
// researcher workers re-read one file 15-20 times. Track which lines of each file were read
// since the last write; reads that add no new lines are allowed a few times, then refused.
type _ReadLedger = Map<string, { ranges: Array<[number, number]>; redundant: number; refused?: number; servedAt?: number; stubs?: number }>;
const _readLedgers = new WeakMap<Map<string, any>, _ReadLedger>();   // keyed by the per-turn repeat cache
// Tool-call steps run against each ledger (one per _runToolCalls call) — the clock for servedAt.
const _ledgerTicks = new WeakMap<_ReadLedger, number>();
// A read of this file served in full this recently is still in context (compaction drops the
// ledger): v0.59 re-served 219 of 245 repeat reads within 2 steps of a full copy.
export const RECENT_READ_STEPS = 5;
export const REDUNDANT_READS_BEFORE_REFUSAL = 3;
// Refusals per file before the guard gives way. A model that keeps asking for the same lines
// after two refusals doesn't have them in view (pruned, compressed or compacted away): v0.56
// Verified sympy-14531 was refused 25 of 36 reads, asking for 600–650 about 20 times until the
// step cap. Serve the lines again, with a warning, instead of refusing forever.
export const REDUNDANT_READ_REFUSALS_MAX = 2;
// "Still shown above" stubs per file before the guard serves the lines once more and pauses
// read_file. The stub is true (v0.60 astropy-12907: the whole file was in history) but the model
// re-asked regardless — 13 times there, 45 in sympy-18189 — until the repeat guard stopped the run
// with an empty patch. A fresh copy at the end of the context plus no read_file for a couple of
// steps leaves editing, running code or answering.
export const READ_STUBS_BEFORE_PAUSE = 2;
// Whole-file reads longer than this may be cut down before the model sees them — not "covered".
const _READ_LEDGER_FULL_MAX_CHARS = 15_000;

function _readRange(args: any): [number, number] {
    return [Number(args?.start_line) || 1, Number(args?.end_line) || Infinity];
}
function _rangeCovered(ranges: Array<[number, number]>, [from, to]: [number, number]): boolean {
    let reach = from - 1;
    for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
        if (a > reach + 1) break;
        if (b > reach) reach = b;
        if (reach >= to) return true;
    }
    return reach >= to;
}
const _fmtRanges = (rs: Array<[number, number]>) =>
    rs.map(([a, b]) => b === Infinity ? (a <= 1 ? 'whole file' : `${a}–end`) : `${a}–${b}`).join(', ');

// For a read that only repeats lines already read: null (run it), { error } (refuse it), or,
// once the file's refusals are used up, { note } (run it and attach the note to the result).
export function _checkRedundantRead(ledger: _ReadLedger, args: any): any | null {
    const path = _normPath(String(args?.path ?? ''));
    const entry = path ? ledger.get(path) : null;
    if (!entry || !_rangeCovered(entry.ranges, _readRange(args))) return null;
    entry.redundant++;
    if (entry.redundant < REDUNDANT_READS_BEFORE_REFUSAL) return null;
    if ((entry.refused ?? 0) >= REDUNDANT_READ_REFUSALS_MAX)
        return { note: `You have read these lines of "${args.path}" ${entry.redundant + 1} times without changing the file. They are shown again below; use them now — edit the file, run code, or give your answer.` };
    entry.refused = (entry.refused ?? 0) + 1;
    return { error: `read_file refused: these lines of "${args.path}" were already read this turn (${_fmtRanges(entry.ranges)}) and the file has not changed since. Their content is in your earlier tool results — a pruned result names the later read that holds it. Do not read this file again: edit it, run code, or give your answer. If those results no longer show the lines, request them once more and they will be shown.` };
}
// Whether an execute_code call may have changed workspace files: reported writes, or a command
// that writes (redirects, in-place edits, file-moving tools, Python/JS file writes, git mutations).
export function _execMayWrite(args: any, result: any): boolean {
    if (Array.isArray(result?.files_written) && result.files_written.length) return true;
    const code = String(args?.code ?? '');
    return /(?:^|[^>&2])>{1,2}\s*[^\s&|]|\btee\b|\bsed\s+(?:-\w*\s+)*-\w*i|\bperl\s+-\w*i|\b(?:mv|cp|rm|touch|truncate|patch|dd|install)\s|\bgit\s+(?:checkout|apply|stash|reset|restore|am|cherry-pick|merge|rebase)\b|open\([^)]*['"][wax+]|\.write(?:_text|_bytes|lines)?\(|writeFile|shutil\.|os\.(?:rename|replace|remove)/.test(code);
}
export function _recordRead(ledger: _ReadLedger, args: any, result: any): void {
    if (!result || result.error || typeof result.content !== 'string') return;
    const _p = _normPath(String(args?.path ?? ''));
    if (_p && ledger.has(_p)) ledger.get(_p)!.servedAt = _ledgerTicks.get(ledger) ?? 0;
    const [from, to] = _readRange(args);
    if (to === Infinity && from <= 1 && (result.content.length > _READ_LEDGER_FULL_MAX_CHARS || /Only the first \d+ lines shown/.test(result.content))) return;
    const path = _normPath(String(args?.path ?? ''));
    if (!path) return;
    const e = ledger.get(path) ?? { ranges: [], redundant: 0 };
    e.ranges.push([from, to]);
    e.servedAt = _ledgerTicks.get(ledger) ?? 0;
    ledger.set(path, e);
}

async function _runToolCalls(normCalls: Array<{name: string; args: any}>, toolTasks: any[] | null, { forWorker, context = null as any, onStart = null as ((name: string, args: any, i: number) => void) | null, onTaskDone = null as (() => void) | null, onResult = null as ((name: string, args: any, result: any) => void) | null, onRepeat = null as ((name: string) => void) | null, repeatCache = null as Map<string, any> | null, replFails = null as Map<string, number> | null, replNudge = null as Map<string, number> | null, blockedTools = null as Set<string> | null, pausedTools = null as Set<string> | null, onPause = null as ((name: string) => number) | null }): Promise<Array<{name: string; args: any; result: any}>> {
    const _ledger: _ReadLedger | null = repeatCache
        ? (_readLedgers.get(repeatCache) ?? (_readLedgers.set(repeatCache, new Map()), _readLedgers.get(repeatCache)!))
        : null;
    if (_ledger) _ledgerTicks.set(_ledger, (_ledgerTicks.get(_ledger) ?? 0) + 1);
    return Promise.all(normCalls.map(async ({ name, args }, i) => {
        const task = toolTasks?.[i];
        task?.setPrompt(JSON.stringify({ tool: name, args }, null, 2));
        onStart?.(name, args, i);
        let result;
        let _rereadNote: string | null = null;
        if (blockedTools?.has(name)) {
            const refused = { error: `${name} is not available in this turn. Do the remaining work yourself with the other tools, then end with COMPLETED.` };
            task?.setOutput(JSON.stringify(refused, null, 2));
            task?.complete();
            onResult?.(name, args, refused);
            return { name, args, result: refused };
        }
        // Paused for this step (not offered in the tool list); a call written anyway is refused.
        if (pausedTools?.has(name)) {
            const refused = { error: `${name} is paused for a moment because the last calls repeated without progress. Use what you already have: edit a file, run code, or give your answer.` };
            task?.setOutput(JSON.stringify(refused, null, 2));
            task?.complete();
            onResult?.(name, args, refused);
            return { name, args, result: refused };
        }
        if (_ledger && name === 'read_file') {
            const verdict = _checkRedundantRead(_ledger, args);
            if (verdict?.error) {
                task?.setOutput(JSON.stringify(verdict, null, 2));
                task?.complete();
                onResult?.(name, args, verdict);
                return { name, args, result: verdict };
            }
            if (verdict?.note) {
                const pNorm = _normPath(String(args?.path ?? ''));
                const seen = [..._seenReadFiles.entries()].filter(([k]) => k.startsWith(pNorm + ':') && !k.endsWith('::__count__'));
                // Every earlier read of this file is still in context unpruned (the pruners and
                // compaction mark a path 'pruned' as soon as any of its results is stubbed): the lines
                // are on screen, so say so instead of sending them again. Re-serving them regardless
                // made a loop of its own — pylint-4970 (v0.57) alternated two ranges of similar.py for
                // 57 steps, each served in full.
                // Or a full copy was served in the last few steps, so it can't have been compacted
                // away; pruning only stubs a copy that a later full read covers. v0.59 xarray-6744
                // was re-served the same window ~36 times, each pruning the copy before it.
                const _e = _ledger.get(pNorm);
                const _recent = _e?.servedAt != null && (_ledgerTicks.get(_ledger) ?? 0) - _e.servedAt <= RECENT_READ_STEPS
                    && !seen.some(([, v]) => v === 'truncated');   // a copy cut short in history doesn't count
                const _stubbable = _recent || (seen.length && seen.every(([, v]) => v === 'full'));
                if (_stubbable && _e && (_e.stubs ?? 0) >= READ_STUBS_BEFORE_PAUSE && onPause) {
                    // Stubbed enough: serve the lines once more (below) and take read_file away
                    // for the next steps.
                    _e.stubs = 0;
                    const _n = onPause('read_file');
                    _rereadNote = `You have asked for these lines of "${args.path}" ${_e.redundant + 1} times without changing the file. Here they are once more. read_file is paused ${pauseText(_n)}: use these lines now — edit the file, run code, or give your answer.`;
                    repeatCache?.delete(`${name}|${JSON.stringify(args)}`);
                } else if (_stubbable) {
                    if (_e) _e.stubs = (_e.stubs ?? 0) + 1;
                    const stub = { path: args?.path, note: `${verdict.note.replace(/ They are shown again below;.*$/, '')} They are still shown in your earlier read_file results above, unchanged, so they are not repeated here. Use them now — edit the file, run code, or give your answer.` };
                    task?.setOutput(JSON.stringify(stub, null, 2));
                    task?.complete();
                    onResult?.(name, args, stub);
                    return { name, args, result: stub };
                }
                // An earlier copy was pruned or compacted away: serve the lines again. Let the history
                // dedup gate (keyed by exact range) pass the content instead of an "Already read" stub.
                // Only this range: marking every range of the file 'pruned' made each later read of
                // the file look invisible too, so all of them were served.
                else {
                    _rereadNote = verdict.note;
                    repeatCache?.delete(`${name}|${JSON.stringify(args)}`);
                }
            }
        }
        if (repeatCache) {
            const key = `${name}|${JSON.stringify(args)}`;
            const hit = repeatCache.get(key);
            if (hit) {
                task?.setOutput(JSON.stringify(hit, null, 2));
                task?.complete();
                onResult?.(name, args, hit);
                onRepeat?.(name);
                return { name, args, result: hit };
            }
        }
        // Snapshot mtimes of any files with pending replace-failure counters so we can
        // detect file changes made by *any* tool (apply_patch, execute_code, etc.), not
        // just the specific tools we enumerated below.
        const _preMtimes = (!forWorker && replFails && replFails.size > 0)
            ? new Map(await Promise.all([...replFails.keys()].map(
                async fp => [fp, await agentFileMtime(fp)] as [string, number | null])))
            : null;
        try { result = await executeToolAsync(name, args, context, task ? (message: string) => task.append(message + '\n', 'thinking') : undefined); }
        catch (e) { result = { error: e.message, hint: _toolErrorHint(name) }; }
        if (_rereadNote && result && !result.error) {
            result = { ...result, note: _rereadNote };
            // Let the history dedup gate pass this copy. It keys on the range read_file returned,
            // which is widened around small requests (215–245 → 203–253); marking the requested
            // range instead left that mark 'pruned' for good, so every later read looked invisible.
            _seenReadFiles.set(`${_normPath(String(args?.path ?? ''))}:${result.start_line || ''}:${result.end_line || ''}`, 'pruned');
        }
        if (_preMtimes && replFails) {
            for (const [fp, before] of _preMtimes) {
                const after = await agentFileMtime(fp);
                // Clear the failure counter whenever the file changes (successful edit by any tool)
                // or is deleted. Null-before means we couldn't stat it pre-call; skip to be safe.
                if (before !== null && after !== before) _trackReplaceFailure(fp, false, replFails);
            }
        }
        if (repeatCache) {
            const key = `${name}|${JSON.stringify(args)}`;
            // A non-GET request may change remote state: earlier cached reads (GET, or POST-style
            // reads such as AutomationBench's /execute) are stale now. Its own entry is still
            // cached below, so an identical repeat (a duplicate send) is not executed twice.
            // v0.56: 5 reads after a write were answered from the pre-write cache (v0.55: 10).
            if (name === 'fetch_url' && !/^(GET|HEAD)$/i.test(String(args?.method ?? 'GET'))) repeatCache.clear();
            if (!result?.error) {
                // Only cache successful results. Error results are retryable — caching them
                // would fire a spurious 'tool_repeat' nudge on retry and hand the model the
                // same failure instead of letting it try again (e.g. 'context budget exhausted').
                repeatCache.set(key, result);
                // Evict oldest entries when the cache grows beyond the cap.
                while (repeatCache.size > _REPEAT_CACHE_MAX)
                    repeatCache.delete(repeatCache.keys().next().value);
            }
            // Eviction for side-effecting tools (including execute_code, which may change the
            // environment) runs regardless of success/error: a write may have partially mutated
            // state even if it returned an error.
            if (_WRITE_TOOLS.has(name)) {
                repeatCache.clear();
                // execute_code is in _WRITE_TOOLS because it *may* change files; running a repro or
                // a grep between reads must not reset read tracking, or the loop above never ends.
                if (name !== 'execute_code' || _execMayWrite(args, result)) _ledger?.clear();
            }
            else if (name === 'read_file' && _ledger) _recordRead(_ledger, args, result);
        }
        if (name === 'update_task_status' && /^done$/i.test(args.status || '')) onTaskDone?.();
        if (name === 'replace_in_file' && !forWorker && replFails) _trackReplaceFailure(args.path || '', !!(result && result.error), replFails);
        task?.setOutput(JSON.stringify(result, null, 2));
        task?.complete();
        onResult?.(name, args, result);
        return { name, args, result };
    }));
}

// Synthesises a short termination summary when the agent is force-stopped by a hard limit.
// Falls back to a raw stop string when callLLMComplete is unavailable (e.g. unit tests).
// Scratch files an agent creates while working — reproduction/debug scripts, temp and backup
// copies, test-run output (report.xml, junit*.xml, .coverage, htmlcov/; v0.55 pytest-5692's whole
// patch was an 87 KB report.xml). Never part of a fix: they should not be the only edit behind COMPLETED, and the
// SWE-bench runner leaves new ones out of the submitted patch (same patterns there).
export const SCRATCH_PATH_RE = /(?:^|\/)(?:repro|reproduce|reproduction|debug|scratch|tmp|temp)(?:[_-][\w.-]*)?\.(?:py|js|ts|sh|txt|log|out)$|(?:^|\/)(?:reproduction|scratch|htmlcov|\.pytest_cache)\/|(?:^|\/)(?:report|junit[\w.-]*|test[_-]?results?|coverage)\.xml$|(?:^|\/)\.coverage(?:\.[\w.-]+)?$|\.(?:tmp|bak|orig|rej|swp)$|~$/i;
// Test runner / packaging configuration. Edits to these are almost never the fix itself.
export const _ENV_CONFIG_RE = /(?:^|\/)(?:conftest\.py|pytest\.ini|tox\.ini|setup\.cfg|setup\.py|pyproject\.toml|\.coveragerc|requirements[\w.-]*\.txt)$/;
// Model-native tool-call markup left in a reply's text (Gemma-4: <|tool_call>, <tool_call|>, <|"|>).
export const _BROKEN_CALL_RE = /<tool_call\|>|<\|tool_call>|<\|"\|>/;
export function isScratchPath(p: string): boolean { return SCRATCH_PATH_RE.test(String(p || '').replace(/^\/workspace\//, '')); }

// Test/packaging configuration changed in this run that the task doesn't name. Combines the loop's
// own edit tracking with git's view of the workspace where the runner provides one (headless:
// fgChangedFiles), which also sees edits a worker made with shell commands — v0.59 sphinx-8595 and
// sklearn-10297 shipped worker-made environment edits the loop never saw.
// Also a new top-level package (headless: fgNewFiles) the task doesn't name — a stub standing in
// for a dependency missing locally. v0.60 shipped asgiref/ and pytz/ (django-12747) and erfa/
// (astropy-13398); in the graded environment the real package is installed and the stub shadows
// it. None of the 69 sampled gold patches adds a top-level directory.
export async function envConfigEdits(task: string, edited: Iterable<string> = []): Promise<string[]> {
    let changed: string[] = [], created: string[] = [];
    try { changed = (await (globalThis as any).fgChangedFiles?.()) ?? []; } catch {}
    try { created = (await (globalThis as any).fgNewFiles?.()) ?? []; } catch {}
    const config = [...new Set([...edited, ...changed].map(String))]
        .filter(p => _ENV_CONFIG_RE.test(p) && !task.includes(p.split('/').pop() ?? ''));
    const stubPkgs = created.map(String)
        .map(p => /^([\w.-]+)\/__init__\.py$/.exec(p)?.[1])
        .filter((d): d is string => !!d && !new RegExp(`\\b${d.replace(/[.-]/g, '\\$&')}\\b`).test(task))
        .map(d => `${d}/`);
    return [...config, ...stubPkgs];
}

// Final message when an interactive turn reaches its step limit. The pending tool call of the
// last step was not run; saying so keeps the user from assuming it was.
async function _stepBudgetStopMessage(max: number): Promise<string> {
    const lines = [`**Paused:** this turn reached its limit of ${max} steps (Settings → Agent Loop → Max steps per turn). The last requested tool call was not run. Send **continue** to pick up where it left off.`];
    if (typeof getMode === 'function' && getMode() === 'cowork' && typeof loadTaskFiles === 'function') {
        try {
            const open = (await loadTaskFiles()).filter((t: any) =>
                t.path.startsWith('fg-tasks/') && !['done', 'completed'].includes((t.fm.status || '').toLowerCase()));
            if (open.length) {
                lines.push('', '**Tasks not finished yet:**',
                    ...open.map((t: any) => `- ${t.fm.id ? `#${t.fm.id} ` : ''}${t.fm.title || t.path} — ${t.fm.status || 'open'}`),
                    '', 'You can also run them one at a time with **Run** in the Tasks tab.');
            }
        } catch {}
    }
    return lines.join('\n');
}

// The current turn's forced stop (reason given to _gracefulSynthesis) and whether the turn changed
// files. runAgentTurn copies it into TurnResult so directorLoop can tell a step-limit stop after
// edits (worth one closing continuation) from any other stop (end the run). Reset per turn.
let _turnStop: { reason: string | null; edited: boolean } = { reason: null, edited: false };
// Tools the current main-agent turn may not use (directorLoop's closing turn drops run_workers:
// v0.58 xarray-4094's closing turn re-edited its fix through a worker). Set per runTurn; never
// applied to worker requests.
let _turnExcludedTools: Set<string> | null = null;
// Tools paused for the current step of the main-agent turn (set by runTurn before each request).
// A model stuck re-requesting one call ignores refusals and stubs worded any way: v0.60 SWE runs
// with 5+ read stubs resolved 0 of 8, re-asking the same lines 13–45 times until the repeat guard
// ended the run. Taking the tool away for a couple of steps forces a different action.
let _stepPausedTools: Set<string> | null = null;
export const TOOL_PAUSE_STEPS = 2;
// A pause that expires after TOOL_PAUSE_STEPS changes nothing when the model's loop is longer than
// that: v0.61 sympy-15875 re-asked for the same lines the step the pause ended, 33 pauses and 92
// reads over 99 steps (3.0M tokens; v0.60 ended it at step 28 with 0.7M). So each further pause of
// a tool is longer: 2 steps, then 4, then the rest of the turn.
export function pauseSteps(timesPausedBefore: number): number {
    return timesPausedBefore === 0 ? TOOL_PAUSE_STEPS : timesPausedBefore === 1 ? TOOL_PAUSE_STEPS * 2 : Infinity;
}
export const pauseText = (n: number): string => Number.isFinite(n) ? `for the next ${n} steps` : 'for the rest of this turn';
// Below this share of the step budget a refused read still only pauses (there is room to recover);
// past it the refusal counts toward the turn stop, which ends the turn with what the run has.
export const READ_REFUSAL_FREE_SHARE = 0.6;
export function readRefusalIsFree(step: number, loopMax: number, timesPaused: number[]): boolean {
    return step < loopMax * READ_REFUSAL_FREE_SHARE && !timesPaused.some(n => n >= 3);
}
export function getTurnStopInfo(): { reason: string | null; edited: boolean } { return { ..._turnStop }; }

// What the stop summary needs to recover an answer: the task and the last few successful tool
// outputs of this turn. Set by runTurn.
let _stopTask = '';
let _stopRecent: string[] = [];
function _noteStopOutputs(results: Array<{ name: string; result: any }>): void {
    for (const r of results) {
        const res = r.result;
        if (!res || res.error || (res.exit_code != null && res.exit_code !== 0)) continue;
        const body = typeof res.stdout === 'string' ? res.stdout
            : typeof res.content === 'string' ? res.content : JSON.stringify(res);
        if (!body?.trim()) continue;
        _stopRecent.push(`${r.name}: ${body.length > 1500 ? body.slice(0, 1500) + ' […]' : body}`);
    }
    if (_stopRecent.length > 3) _stopRecent = _stopRecent.slice(-3);
}

export async function _gracefulSynthesis(reason: string, lastContent: string = ''): Promise<string> {
    // A forced stop is otherwise invisible in the step log: the run just ends on a tool call
    // (v0.56: 12 failure-streak stops and 13 step-cap stops read as "completed").
    try { convoLogTurn({ type: 'stop', name: reason }); } catch {}
    // A forced stop ends the turn as BLOCKED. The summary alone did not guarantee it: the model
    // writes "… BLOCKED: x" mid-line, which _BLOCKED_DECLARATION_RE (line-leading) misses, and the
    // fallback text had no BLOCKED at all. The turn then read as 'running' and directorLoop started
    // up to 4 more 100-step turns (v0.57: 1,102 SWE steps; pylint-4970 ran 394 steps over three stops).
    _turnStop.reason = reason;
    setLastTurnBlockedToken(true);
    // BLOCKED goes first and the summary (or recovered answer) last: benchmark graders take the last
    // line as the answer, and with BLOCKED last the answer became the stop reason — v0.58 CTF 48 had
    // the flag in its step-1 output and was graded "it kept repeating calls that…".
    const withBlocked = (t: string) => _BLOCKED_DECLARATION_RE.test(t) ? t : `BLOCKED: ${reason}\n\n${t}`;
    if (typeof callLLMComplete !== 'function') return withBlocked(`*(stopped: ${reason})*`);
    try {
        const task = _stopTask ? `Task:\n${_stopTask.slice(0, 1500)}\n\n` : '';
        const outs = _stopRecent.length ? `Most recent tool outputs:\n${_stopRecent.join('\n---\n')}\n\n` : '';
        const ctx = lastContent ? `Last agent output:\n${lastContent.slice(0, 600)}\n\n` : '';
        const text = await callLLMComplete(
            `${task}${outs}${ctx}An autonomous agent working on this task was force-stopped (${reason}). If the task asks for a specific answer (a value, name, flag, path, command or query) and the tool outputs above show it, reply with only that answer, in the form the task asks for. Otherwise summarise in 1-2 sentences what was accomplished and why it stopped.`,
            { maxTokens: 300, label: 'termination:synthesis', maxAttempts: 1 }
        );
        return withBlocked(text?.trim() || `*(stopped: ${reason})*`);
    } catch { return withBlocked(`*(stopped: ${reason})*`); }
}

// ── Generic step-output validation ──────────────────────────────────────────
// Design principle: validate every step output with
// fast deterministic checks for the certain cases, escalating to a minimal LLM call
// only for the ambiguous band. Each check declares two bracketing patterns:
//   re_pass — RegExp or (text) => boolean; "definitely fine" → check passes, free
//   re_fail — RegExp or (text) => boolean; "definitely violating" → nudge, no LLM
// Band routing: pass-only → skip; fail-only → deterministic fire; BOTH or NEITHER
// match → the text is by definition ambiguous → llmPrompt decides (told which
// ambiguity case it is); no llmPrompt → pass (fail-open: a wrong nudge actively misleads).
// Write re_pass broad enough that ordinary outputs exit there — it bounds LLM cost.
//   phase     — 'pre-state' (before turn-state handling)
//   nudge     — string or (text, payload, n, toolName?) => string; payload = extracted command
//               (LLM verdict line, else deterministic capture) for actionable wording
//   max       — consecutive-fire cap (counters reset whenever a real tool call happens)
//   onFire    — optional (ps, text) side effect for protocol-state bookkeeping
// Canonical tool names from step-validator.ts (AGENT_TOOL_NAMES global). Read lazily
// at call time so a module-load race doesn't capture undefined. Fallback is emergency-only.
const _toolNamesRe = () => (typeof AGENT_TOOL_NAMES !== 'undefined' && AGENT_TOOL_NAMES
    ? AGENT_TOOL_NAMES.join('|')
    : 'execute_code|write_file|read_file|replace_in_file|list_files|apply_patch|run_workers|search_workspace');
// Save the turn's candidate answer. NEVER replace an existing answer with a body-less
// response: a reasoning-only step (empty visible text) or a bare state line ("COMPLETED")
// carries no answer of its own, and overwriting one produced empty "(no text response)"
// finals (fg-chat 2026-07-16). The guard existed as _saveAnswer until 31db758 (the v0.18
// baseline revert) replaced it with bare `ps.saved = text` assignments, reintroducing the
// bug. Regression guard: tests/loop-protocol.test.js.
function _saveAnswer(ps: any, text: string): void {
    if (_stripTerminal(text ?? '').trim() || !ps.saved) { ps.saved = text; ps.savedByStateLine = false; }
}


// Final sentence announces an immediate action: "Let me write X now.", "I'll create Y:",
// "Next, I will add Z." — intent without the tool call that should carry it out.
// "[.!?](?=\S)" lets file names ("game.js") through; "let me know" is a sign-off, not intent.
const _INTENT_TAIL_RE = /(?:^|[.!?\n]\s*)(?:(?:ok(?:ay)?|now|next|so|then|first|alright)[,\s]+)*(?:let me(?! know)|let's|i'll|i will|i'm going to|i am going to|i need to|time to)\b(?:[^\n.!?]|[.!?](?=\S))*[.:!…]*$/i;

// Is a no-tool-call message only narration of the agent's next step (not a result for the user)?
// Three-band check (step-validator.ts): the intent regex above fires deterministically; clear
// result/report markers pass; anything matching both or neither goes to a yes/no model call.
// Its verdict decides whether missing_state_line may save the text as the turn's answer and
// whether a tool call is forced next.
const _NARRATION_CHECKS = [{
    name: 'narration_only',
    max: Infinity,
    re_fail: (t: string) => _INTENT_TAIL_RE.test(t),
    re_pass: RESULT_MARKERS_RE,
    llmPrompt: 'An AI agent working on a task sent the message below without calling a tool. Is the message ONLY narration of what the agent is about to do next (announcing or planning its next step), rather than a result, finding, answer, or summary meant for the user? Answer YES if it only announces next steps; NO if it reports something the user needs.',
}];
export async function _isNarrationOnly(text: string, llm: any = typeof callLLMComplete === 'function' ? callLLMComplete : null): Promise<boolean> {
    const t = (text ?? '').trim();
    if (!t) return false;
    return !!(await validateOutput(t, _NARRATION_CHECKS, { llm, maxTokens: 200 }));
}

// Is the text only a pseudo tool call — nothing left once the call lines, code fences and
// tool-call XML/JSON are removed? Such a reply carries no answer for the user.
export function _isBarePseudoCall(text: string): boolean {
    const names = _toolNamesRe();
    const rest = String(text ?? '')
        .replace(/```[\s\S]*?(?:```|$)/g, '')
        .replace(/<(invoke|tool_call|function_calls)\b[\s\S]*?(?:<\/\1>|$)/gi, '')
        .replace(new RegExp(`<(${names})\\b[\\s\\S]*?(?:<\\/\\1>|\\/>|$)`, 'gi'), '')
        .split('\n')
        .filter(l => !new RegExp(`\\b(?:${names})(?:_tool)?\\s*\\(|"(?:name|tool|function|tool_name)"\\s*:\\s*"(?:${names})"`).test(l))
        .join('\n')
        .replace(/[\s{}\[\],"'`]/g, '');
    return rest.length < 40;
}

const _STEP_CHECKS = [
    {   // Pseudo tool call in any form: text that tries to run a command instead of
        // making a tool call. re_fail = exact formats (XML invoke/tag, python-call,
        // JSON); re_pass = terminal state or no tool-shaped content at all; the middle
        // (prose + fence, bare fenced commands) and pass∧fail conflicts go to the LLM.
        name: 'pseudo_tool_call', phase: 'pre-state', max: 5,
        // _isComplete short-circuits ONLY when there is no tool-JSON in the text.
        // A COMPLETED+{"name":"execute_code",...} response must not pass unchecked —
        // the re_fail below catches the JSON syntax and fires the nudge instead.
        re_pass: t => (_isComplete(t) && !new RegExp('"(?:name|tool|function|tool_name)"\\s*:\\s*"(?:' + _toolNamesRe() + ')"').test(t))
            // Strip inline code spans (`…`) before the tool-name check so that documentation
            // like "`update_task_status(path, status)` to mark" is not treated as suspicious.
            // Code fences (``` … ```) are intentionally preserved — tool calls inside a fence
            // are genuine pseudo-calls.  /`[^`\n]+`/g strips only single-backtick spans.
            || !(/```[\w-]*\s*\n/.test(t) || new RegExp(`\\b(?:${_toolNamesRe()})(?:_tool)?\\b`).test(t.replace(/`[^`\n]+`/g, '…')))
            // XML-tag match embedded mid-line (not line-leading): return true here so that
            // re_pass and re_fail are both true, which routes to the LLM judge instead of
            // firing the nudge deterministically.
            || (new RegExp(`<(?:${_toolNamesRe()})(?:\\s|>|/|=)`, 'i').test(t)
                && !new RegExp(`(?:^|\\n)\\s*<(?:${_toolNamesRe()})(?:\\s|>|/|=)`, 'i').test(t)),
        // Returns the matched tool name (string) when recognisable, true for generic
        // pseudo-call formats (invoke/tool_name XML), false when no violation found.
        // step-validator.ts preserves the string and exposes it as vc.toolName.
        re_fail: t => {
            // Strip inline code spans so "`update_task_status(path, status)`" in
            // documentation does not trigger a deterministic pseudo-call nudge.
            // Code fences are NOT stripped — a tool call inside ``` is a real pseudo-call.
            const _bare = t.replace(/`[^`\n]+`/g, '…');
            const m = new RegExp(`\\b(${_toolNamesRe()})(?:_tool)?\\s*\\(`).exec(_bare)
                   ?? new RegExp(`"(?:name|tool|function|tool_name)"\\s*:\\s*"(${_toolNamesRe()})"`).exec(t)
                   ?? new RegExp(`<(${_toolNamesRe()})(?:\\s|>|/|=)`, 'i').exec(t);
            if (m) return m[1];
            return /<invoke\s+name="[^"]+"/i.test(t) || /<tool_name>/i.test(t) || false;
        },
        llmPrompt: (_text: string, ctx: any) => {
            const goal = ctx?.taskGoal ? `\nCurrent task: ${ctx.taskGoal}\n` : '';
            return `An autonomous agent must invoke tools via structured tool calls; plain text output is never executed.${goal} Does the output below try to run a command or invoke a tool by writing it as text (a pseudo-call, or a code block it expects to be executed), instead of stating a final answer or explanation? Answer YES or NO on the first line. If YES and you can identify the command it wanted to run, add a second line: payload: <the command> If YES and you can identify the specific tool name, add a third line: tool: <toolname>`;
        },
        nudge: (text, payload, n, toolName) => {
            const cmd = payload ? payload.split('\n')[0].slice(0, 160) : '';
            // Build a concrete call example from detected tool + payload so the model
            // sees exactly which parameters to fill in, not just the tool name.
            // If the model's text is already JSON tool-call args, parse code/language from it directly.
            let example = '';
            if (toolName === 'execute_code' && cmd) {
                let lang = 'bash';
                try { const parsed = JSON.parse(text.trim()); if (parsed?.language) lang = parsed.language; } catch {}
                example = ` Call it as: execute_code(code=${JSON.stringify(cmd)}, language="${lang}")`;
            } else if (toolName && cmd) {
                example = ` Call it as: ${toolName}(${JSON.stringify(cmd)})`;
            } else if (toolName) {
                example = ` Call it as: ${toolName}(...)`;
            } else {
                example = ' Use execute_code(code=<command>, language="bash").';
            }
            const escape = ' If your previous response was already the complete answer to the user\'s question and no tool call is needed, respond with only `COMPLETED`.';
            const base = cmd
                ? `You wrote ${JSON.stringify(cmd)} as TEXT — nothing was executed.${example} Do not print code you intend to run.${escape}`
                : `You wrote a command or tool call as TEXT — nothing was executed and nothing will be. Text and code blocks are never run.${example} Do not print the code you intend to run.${escape}`;
            if ((n ?? 1) >= 3) return base + '\n\nThis is the THIRD reminder. Use the native JSON function-calling schema provided in your tools list — emit a structured tool call, NOT text or code blocks. If you cannot determine the right tool or arguments, declare BLOCKED: <reason>.';
            if ((n ?? 1) >= 2) return base + '\n\nIMPORTANT: Text you write is NEVER executed, including code blocks and JSON snippets. To run a command, emit a native function call using the tools schema in your system context.';
            return base;
        },
    },


    {   // Degenerate/garbled output — repetitive sequences and stray artifact tags.
        // Covers single-character repetition (陪着陪着陪着… at temperature 0), unclosed
        // think tags (</thinking leaked as final answer), and other zero-value output.
        // Long enough to matter, low unique-char count → deterministic fail; ambiguous
        // cases (e.g. code dumps with few distinct tokens) escalate to the LLM.
        // NOTE: re_fail must use \S (non-whitespace) for the repetition check — markdown
        // table column padding can produce 25+ consecutive spaces (fg-chat-2026-08-15-11-27-50:
        // "| **Models**                          |") which incorrectly triggers [\s\S]\1{24,},
        // sending good output to the LLM judge and starting a false COMPLETED-loop.
        name: 'gibberish_output', phase: 'pre-state', max: 3,
        re_pass: t => _isComplete(t)
            || t.trim().length < 40
            || new Set([...t.trim()].filter(c => !/\s/.test(c))).size > 3,
        re_fail: t => /(\S)\1{24,}/.test(t)
            || /<\/?(?:think|thinking)>?\s*$/i.test(t.trim())
            || /^\s*<\/?(?:think|thinking)>?\s*$/i.test(t),
        llmPrompt: 'The output below is either meaningful text or degenerate garbage (repetitive/repetitive/repetitive... loops, stray markup tags, or meaningless tokens). Does it look like degenerate/meaningless output that should be suppressed? Answer YES if it is degenerate garbage.',
        nudge: 'Your last response was degenerate output — repetitive text or artifact tags. Focus: call a tool or give a clear final answer. Do not repeat yourself.',
    },

    {   // No terminal state declared: model output contains no COMPLETED/BLOCKED declaration.
        // Fires post-state (after _handleTurnState returns fallthrough) so it does not
        // conflict with pre-state pseudo_tool_call or the completion gate.
        // onFire is intentionally a no-op: ps.saved must never be overwritten by this check —
        // that was the 2026-07-16 regression (31db758: bare COMPLETED after saved answer was
        // overwritten by onFire(ps, '') and the turn finalized as "(no text response)").
        //
        // Director role is excluded: the director legitimately produces multi-step narration
        // turns between worker dispatches (synthesising results, planning next steps) and has
        // its own completion gate via the final COMPLETED token.  Forcing COMPLETED after
        // N text turns causes premature task termination before verification is complete —
        // confirmed as the primary driver of the v0.47→v0.50 SWE-Bench Lite regression (−6/36).
        // The exclusion is limited to workflowMode (headless runs, the task runner), whose outer
        // loop re-enters after a narration turn. Interactive chat also defaults to the director
        // role but has no outer loop: unchecked, mid-task narration ("Let me do…") after tool
        // calls ended the turn with the work half done (Cowork game build, 2026-09).
        name: 'missing_state_line', phase: 'post-state', max: 5,
        re_pass: t => _isComplete(t),   // already has COMPLETED/BLOCKED — pass
        re_fail: t => !_isComplete(t) && !(workflowMode && mainAgentRole?.name === 'director'),
        llmPrompt: '',                   // deterministic: no LLM judge needed
        nudge: (_text: string, _payload: any, n: number) => {
            if ((n ?? 1) >= 5) return 'You have written text five times in a row without a terminal state token. Declare COMPLETED: <answer> or BLOCKED: <reason> immediately — no further narration.';
            return 'Your response has no tool call and no state token. If work remains, make the next tool call now — describing it does nothing. Otherwise end with COMPLETED (task done) or BLOCKED: <reason> (cannot proceed without user input).';
        },
        // Save the answer text when this check fires so a subsequent bare "COMPLETED"
        // (the model's next reply after the state-token nudge) can be accepted without
        // requiring the answer to be repeated.  Uses _saveAnswer so an empty text arg
        // (e.g. from a reasoning-only step) cannot overwrite an already-saved answer.
        // Narration that announces a next action ("Let me check the update function:") is not an
        // answer — saving it made a later bare COMPLETED display it as the turn's result, 30 steps
        // after the fact (fg-chat 2026-09-27-08-44-35). ps.savedByStateLine marks the save so a
        // following tool step (the model carried on working) can drop it.
        onFire: async (ps: any, text: string) => {
            ps.lastWasNarration = await _isNarrationOnly(text);
            if (ps.lastWasNarration) return;
            const before = ps.saved;
            _saveAnswer(ps, text);
            if (ps.saved !== before) ps.savedByStateLine = true;
        },
    },
];
// Thin wrapper over the shared engine (step-validator.js): runs the band routing,
// then applies this loop's fail action — protocol bookkeeping + rendered nudge.
async function _validateStepOutput(text: string, ps: any, phase: string, taskGoal = ''): Promise<any> {
    if (typeof validateOutput !== 'function') return null;
    const vc = await validateOutput(text, _STEP_CHECKS, {
        phase,
        counters: (ps.checkFires ??= {}),
        llm: typeof callLLMComplete === 'function' ? callLLMComplete : null,
        ctx: taskGoal ? { taskGoal } : null,
    });
    if (!vc) return null;
    await vc.check.onFire?.(ps, text);
    // counters[name] is incremented by validateOutput before returning vc — pass it so
    // nudge functions can escalate their message on repeated fires.
    const _fireN = (ps.checkFires ??= {})[vc.name] ?? 1;
    return { name: vc.name, nudge: typeof vc.check.nudge === 'function' ? vc.check.nudge(text, vc.payload, _fireN, vc.toolName) : vc.check.nudge };
}


// Build a Map of write_file diffs for successfully-written files.
// items: [{name, args, result, key}] — key is tc.id from the tool call.
// oldContents: pre-read file contents array, parallel to items.
function _buildWriteDiffs(items: Array<{name: string; args: any; result: any; key: string}>, oldContents: Array<string | null>): Map<string, string> {
    const diffs = new Map();
    for (let i = 0; i < items.length; i++) {
        const { name, args, result, key } = items[i];
        if (name === 'write_file' && args?.path && args?.content && result && !result.error) {
            const diff = _diffContent(oldContents[i], args.content, args.path);
            if (diff && diff.length < args.content.length && args.content.length >= 4000) diffs.set(key, diff);
        }
    }
    return diffs;
}


// ── Keyword-based tool pre-selection ─────────────────────────────────────────
// Matched against the first user message synchronously (no LLM call) in both
// WebUI and benchmarking paths to add context-relevant optional tools instantly.
const _KEYWORD_TOOL_MAP: Array<{ re: RegExp; tools: string[] }> = [
    { re: /\b(web search|search (the )?web|search online|google it|find online|latest news|current (events?|news|prices?)|trending|stock price|weather in)\b/i,
      tools: ['web_search'] },
    { re: /^search[\s.,!?]/i,   // bare "search" as a command at the start of a message
      tools: ['web_search'] },
    // Removed: "look up / find out / what is / who is / where is / …" — these question-word
    // patterns are far too broad and fire on ordinary task phrasings that have no web-search
    // intent (e.g. "What is the output of …", "Who is the author in this repo").  The
    // explicit-intent patterns above and below cover legitimate web-search triggers.
    { re: /\b(research|deep.dive|investigate|comprehensive (analysis|review|report|summary)|multiple sources|literature review|survey)\b/i,
      tools: ['deep_research', 'web_search'] },
    { re: /\bhttps?:\/\/|\b(fetch (the )?url|make (an? )?api (call|request)|call (the )?api|scrape|crawl)\b/i,
      tools: ['fetch_url'] },
    { re: /\b(arxiv|pubmed|academic papers?|research papers?|scholarly|bibliography|journal article)\b/i,
      tools: ['academic_search', 'web_search'] },
    { re: /\b(npm|pypi|pip install|npm install|find (a |the )?package|which (library|package)|node module)\b/i,
      tools: ['package_search'] },
    { re: /\b(run (the )?tests?|execute (the )?(script|code|command)|bash script|shell command|compute|calculate|pytest|npm test|run npm)\b/i,
      tools: ['execute_code'] },
    { re: /\b(generate (an? )?(image|picture)|draw (a |an )?|create (an? )?(image|illustration)|stable diffusion|dall.?e)\b/i,
      tools: ['generate_image'] },
    { re: /\b(git (status|diff|log|commit|branch|merge|stash|rebase|show|blame|add)|pull request|git history)\b/i,
      tools: ['run_git'] },
    { re: /\b(documentation for|docs for|api docs|library docs|context7)\b/i,
      tools: ['context7_docs'] },
];

// Returns tool names that keyword-match taskText, filtered to enabled tools.
// Uses ignoreRole=true so specialist tools (ast_query, deep_research, fetch_url, …)
// are reachable even when the active role doesn't include them in its baseline set.
// The role floor is enforced at payload-build time by activeTools() in callOAI.
function _keywordMatchTools(taskText: string): string[] {
    const allActive = new Set((activeTools(false, null, true) as any[]).map((t: any) => t.name));
    const matched = new Set<string>();
    for (const { re, tools } of _KEYWORD_TOOL_MAP) {
        if (re.test(taskText)) for (const t of tools) if (allActive.has(t)) matched.add(t);
    }
    return [...matched];
}


// ── Exported tool-classify entry points ───────────────────────────────────────

// Applied at first-message time: adds keyword-matched tools into the Director's additions set.
// activeTools() treats these as extensions to the role ceiling — they add out-of-ceiling
// specialist tools (web_search, fetch_url, …) when the task clearly needs them.
function applyKeywordToolFilter(taskText: string, session?: AgentSession): void {
    if (!taskText) return;
    const _s = session ?? defaultSession;
    const extras = _keywordMatchTools(taskText);
    if (!extras.length) return; // no matches — leave additions set unchanged
    if (_s._toolFilter === null) _s._toolFilter = new Set();
    for (const t of extras) _s._toolFilter.add(t);
}

/** Sentinel returned by _handleTextOnlyStep; caller translates to runTurn control flow. */
type StepAction =
    | { do: 'return'; value: string }   // return value from runTurn
    | { do: 'continue' }                // continue the step loop
    | { do: 'retry' };                  // step-- then continue (token-cutoff discard)

// Unified turn function: the history is the session's event log, projected to messages per request.
// Main turn loop — dispatches through callOAI (all providers including Google via OAI-compat).
// Cross-provider fallback is handled by changing activeEndpoint with no history conversion.
async function runTurn(endpoint: any, placeholder: RenderAdapter, { toolFilterOverride = null as Set<string> | null, session, forceToolCall = false, maxSteps, excludeTools }: { toolFilterOverride?: Set<string> | null; session?: AgentSession; forceToolCall?: boolean; maxSteps?: number; excludeTools?: string[] } = {}): Promise<string> {
    const _s = session ?? defaultSession;
    // Every nudge must land in THIS turn's history, which is `_s`'s event log — not the default
    // chat's (headless runs have their own session; the model saw none of their nudges from
    // 8028033 until emitNudge was bound here). The log is the only sink: emitNudge is told to
    // leave history alone and the nudge is appended below. See docs/dead-code-audit-2026-07-25.md §4.5.
    const _emitNudge = (name: string, entry: any, opts: any = {}) => {
        emitNudge(name, entry, { suppressHistory: true, ...opts });
        // append all nudges to the event log as user/message so
        // deriveMessages() includes them in the effective history for the next callOAI.
        // NVIDIA uses role:'system' nudges (mid-turn system role) — stored in the event
        // log as user/message with <nudge> wrapping, since deriveMessages() only produces
        // user/assistant/tool events. callOAI's sanitization layer handles the provider-
        // specific role for the final API payload.
        if (typeof entry?.content === 'string') {
            const _nudgeContent = entry.role === 'user'
                ? entry.content  // already wrapped in <nudge>...</nudge> by _nudge()
                : `<nudge>${entry.content}</nudge>`;
            _evtAppend(_s, 'user/message',
                { role: 'user', content: _nudgeContent },
                { surfaceOp: 'append' });
        }
    };
    if (!_getEvtSession(_s)) _s._session = registry.create({ chatId: activeChatId ?? 'anon' });
    if (_s === defaultSession) repairOAIHistory();
    resetSeenReadFiles();
    _lastMainRequest = null;   // set by this turn's first request; never another chat's
    setLastTurnDoneToken(false);
    setLastTurnBlockedToken(false);
    _turnStop = { reason: null, edited: false };
    _turnExcludedTools = excludeTools?.length ? new Set(excludeTools) : null;
    _stepPausedTools = null;
    const _toolPauses = new Map<string, number>();   // tool → last step it is paused for
    const _pauseCount = new Map<string, number>();   // tool → how many times it has been paused this turn
    // Pause `t` from `step`, longer each time; a tool already paused isn't paused again. Returns the length.
    const _pauseTool = (t: string, at: number): number => {
        const until = _toolPauses.get(t);
        if (until != null && at <= until) return Number.isFinite(until) ? until - at : Infinity;
        const n = pauseSteps(_pauseCount.get(t) ?? 0);
        _pauseCount.set(t, (_pauseCount.get(t) ?? 0) + 1);
        _toolPauses.set(t, at + n);
        return n;
    };
    _stopTask = (() => { try { return _originalTask(_histR(_s)) || ''; } catch { return ''; } })();
    _stopRecent = [];
    // Director kicks pass forceToolCall:true to prevent step-0 planning-text exits.
    // The flag is consumed+cleared by callOAI on the first LLM request of this turn.
    if (forceToolCall) _forceToolCall = true;
    const _failSigs: string[] = [];   // error signature of each failure in the current streak
    let _sameErrorGraceUsed = false;
    let _stepCount = 0, resultHashes = [], consecutiveToolFails = 0, _garbledState = { count: 0 }, _envFailSig = '', _envFailCount = 0, _envFailTotal = 0, _overflowStreak = 0;
    const _repeatCache = new Map();
    const _dupSeen = new Map<string, number[]>();   // call + result → steps it ran (duplicate-output stubs)
    let _stubStreak = 0, _cycleNudged = false;      // consecutive steps whose every result was stubbed
    let _repeatGuard = newRepeatGuard();   // same call + same result streak (detectors.ts)
    let _stuckCallSigs: string[] = [];     // calls of the last 3 steps, for the stuck nudge's wording
    const ps: { finalCheck: number; cont: number; saved: any; substCheck: number; checkFires: Record<string, number>; blockedCheck?: number; scratchOnlyCheck?: number; savedByStateLine?: boolean; lastWasNarration?: boolean; emptyBodyCount?: number; _lastCompactionStep?: number; _postCompactionTurns?: number; brokenCallRetries?: number; envConfigCheck?: number; envConfigAt?: number } = { finalCheck: 0, cont: 0, saved: null, substCheck: 0, checkFires: {} };
    let _editsThisRun = false;      // any successful write_file/replace_in_file/apply_patch — feeds the completion gate
    const _editedPaths = new Set<string>();   // files changed this run (scratch-only completion check)
    let _editEvents = 0;            // steps that edited files or ran workers — re-arms the env-config check
    let _execsThisRun = false;      // any successful execute_code (exit 0) — feeds step_validation advisory mode (T3.3/T3.7)
    let _emptyFsNudged = false;     // empty-FS fallback fires at most once per turn
    const _emptyListTargets = new Map(); // path → count of consecutive empty list_files results
    let _nudgeFn;
    const _oaiAdapter = {
        pushNudge: text => _emitNudge('turn_state', _nudgeFn(text)),
        spliceFromSecondLast: count => {
            // Drop the splice from the session surface via a tombstone replace.
            // Splices always start at history[length-2] and remove 'count' items.
            // In the session surface the same items are at surf[surfLen-2] .. surf[surfLen-2+(count-1)].
            // An empty-content user/message is the tombstone; deriveMessages() filters those.
            // Guard: require surface.length >= count + 2 (not +1) so the splice range can never
            // include surf[0] — the first user message (anchor) which must always remain on-surface
            // to satisfy the "at least one user message" invariant required by vLLM templates.
            const _splSess = _getEvtSession(_s);
            if (_splSess && _splSess.surface.length >= count + 2) {
                const _sp = _splSess.surface;
                const _spStart = _sp[_sp.length - 2];
                const _spEnd   = _sp[_sp.length - 2 + (count - 1)];
                if (_spStart !== undefined && _spEnd !== undefined) {
                    try {
                        (_splSess.append as _AppendSurface)('user/message',
                            { role: 'user', content: '' },
                            { surfaceOp: { op: 'replace', start: _spStart, end: _spEnd } });
                    } catch (_e) {
                        if (typeof console !== 'undefined')
                            console.warn('[session-event] spliceFromSecondLast surface replace failed:', _e);
                    }
                }
            }
        },
        histLen: () => _histR(_s).length,
    };
    _sessionFallback = null;
    _rotState.step = 0;
    const _ep0 = endpoint ?? _defaultEndpoint();
    if (_isCoolingDown(_ep0)) {
        const fb = getRateLimitFallbackEndpoint();
        if (fb) _sessionFallback = fb;
    }
    let activeEndpoint    = endpoint ?? _sessionFallback ?? null;
    let oaiMaxTokens      = null;
    let _forceCompact     = false;
    let _lastInputTokens  = 0;
    let _lastHistoryLen   = 0;    // last history.length seen by the estimator (for cache hit check)
    let _lastEstTokens    = 0;    // cached result of estimateTokens for that length
    let _lastMaxTokensSent = 0;   // max_tokens of the last request (callOAI's clamp), for truncation checks

    // A caller-set budget (directorLoop's closing turn) overrides the per-turn setting.
    const _loopMax = maxSteps && maxSteps > 0 ? Math.min(maxSteps, getAgentMaxSteps()) : getAgentMaxSteps();
    // One "N steps left" note before the step limit. Autonomous runs: so a run that has its fix can
    // apply and check it inside the turn (v0.58: 18 of 36 Lite first turns ran to the limit).
    // Interactive chat: so the pause lands at a clean point, not mid-edit.
    const _stepsLeftWarnAt = _loopMax - Math.max(3, Math.min(10, Math.round(_loopMax * 0.1)));

    // On the first user turn: apply keyword matching on top of the LLM-classified set.
    // Classification itself is the caller's responsibility (agentSend / runAgentTurn /
    // headless-runner) and must be awaited before runTurn is called.
    if (_histR(_s).filter((m: any) => m.role === 'user').length === 1) {
        const _firstUser = _histR(_s).find((m: any) => m.role === 'user');
        applyKeywordToolFilter(typeof _firstUser?.content === 'string' ? _firstUser.content : '', _s);
    }

    // ── Compaction inner function ───────────────────────────────────────────
    // Called when the token budget is full.  Compacts history and re-injects any pending nudge.
    async function _doCompact(step: number): Promise<void> {
        _forceCompact = false;
        _dupSeen.clear();   // stubs point at earlier copies; after compaction those are gone
        // Capture any pending nudge so it can be re-injected if compaction drops it.
        const _lastPre = _histR(_s).at(-1);  // read from session
        const _pendingNudge = (_lastPre?.role === 'user' && typeof _lastPre.content === 'string' && _lastPre.content.startsWith('<nudge>'))
            || (_lastPre?.role === 'system' && typeof _lastPre.content === 'string')
            ? _lastPre : null;
        convoLogTurn({ type: 'history_snapshot', history: _histR(_s).slice() });
        // Snapshot the session surface BEFORE compaction, so the compacted history can shadow it.
        const _evtSessC = _getEvtSession(_s);
        const _preSurfC = _evtSessC ? [..._evtSessC.surface] : null;
        const _effectiveForCompact = _evtSessC ? _evtSessC.deriveMessages() : undefined;
        // Main loop's last request (system prompt + tools as sent) → compaction request shares its prefix.
        const _compacted = await compactHistory(placeholder, activeEndpoint, _s, _effectiveForCompact, _lastMainRequest);
        // Shadow the old surface events with the summary + tail items.
        if (_evtSessC && _preSurfC && _preSurfC.length > 1) {
            _mirrorCompactionToSession(_evtSessC, _preSurfC, _compacted);
        }
        ps._lastCompactionStep = step;
        ps._postCompactionTurns = 2;
        // Re-inject the nudge if compaction dropped it from the tail (rare safety net —
        // pending nudge is always the last message and thus always in the tail, so the
        // mirror already handles it in the common case; this fires only on unusual tail gaps).
        // deriveMessages() returns new objects on every call, so compare by content.
        if (_pendingNudge) {
            const _lastAfter = _histR(_s).at(-1);
            const _nudgeStillPresent = typeof _lastAfter?.content === 'string' &&
                typeof _pendingNudge.content === 'string' &&
                _lastAfter.content === _pendingNudge.content;
            if (!_nudgeStillPresent && typeof _pendingNudge.content === 'string') {
                // System-role nudges (NVIDIA) must be wrapped in <nudge> before storing
                // as user/message — matches the _emitNudge pattern.
                const _reInjectContent = _pendingNudge.role === 'user'
                    ? _pendingNudge.content
                    : `<nudge>${_pendingNudge.content}</nudge>`;
                _addUserMessage(_s, _reInjectContent);
            }
        }
        oaiMaxTokens = null;
        _lastInputTokens = 0;
        _lastHistoryLen  = 0;
        _lastEstTokens   = 0;
        // After compaction the model has lost context — re-reading files it previously
        // read is legitimate, not a repeat. Clear the cache so tool_repeat doesn't fire
        // for calls the model genuinely needs to redo.
        // Inject last-read content for each file so the model can verify fix state
        // without re-reading (prevents the post-compaction re-read cascade).
        const _fileSnips = new Map<string, { label: string; snippet: string }>();
        for (const [key, val] of _repeatCache) {
            if (!key.startsWith('read_file|') || typeof val?.content !== 'string' || !val.path) continue;
            const sl = val.start_line != null ? val.start_line : '';
            const el = val.end_line   != null ? val.end_line   : '';
            const label = sl !== '' ? `${val.path} (lines ${sl}–${el})` : val.path as string;
            _fileSnips.delete(val.path);   // keep insertion order = read order; the last is the newest
            _fileSnips.set(val.path, { label, snippet: val.content as string });
        }
        if (_fileSnips.size) {
            // The file read last — usually the one being worked on — keeps more: a 500-char tail under a
            // "lines 101–250" label read as the whole range, and v0.60 sympy-18189 re-requested lines
            // 130–150 45 times after compaction. Each label says how much is shown.
            const _snips = [..._fileSnips.values()];
            const body = _snips.map(({ label, snippet }, i) => {
                const max = i === _snips.length - 1 ? _FILE_SNIP_LAST : _FILE_SNIP_TAIL;
                if (snippet.length <= max) return `${label}:\n${snippet}`;
                return `${label} — only its last ${max} characters are shown:\n${snippet.slice(-max)}`;
            }).join('\n\n');
            const _flsContent = `[Files read before compaction — last-read content retained so you can verify fix state without re-reading:\n\n${body}]`;
            _addUserMessage(_s, _flsContent);
        }
        // Mark all files from _repeatCache as 'pruned' in _seenReadFiles before
        // clearing the cache. After compaction the history no longer contains those
        // read results, so the 'full' state would cause truncateResultForHistory to
        // return stubs claiming the content is still in history — it isn't.
        // 'pruned' lets the dedup gate serve real content on the next re-read.
        for (const [key, val] of _repeatCache) {
            if (!key.startsWith('read_file|') || !val?.path) continue;
            const pNorm = _normPath(val.path);
            for (const k of _seenReadFiles.keys())
                if (k.startsWith(pNorm + ':')) _seenReadFiles.set(k, 'pruned');
        }
        _repeatCache.clear();
        // The overlapping-read ledger is keyed by this same Map object, so clear() alone kept it:
        // v0.56 refused 19 reads (6 SWE tasks) of lines whose only copy had been compacted away.
        _readLedgers.delete(_repeatCache);
        // After compaction the context window is fresh — the prelude guidance that was
        // injected on earlier turns is gone.  Re-enable those skills by removing them
        // from _reactiveFired so buildTriggeredGuidance re-injects them on the next turn.
        // currentTurnSkills holds the skills triggered at the start of this turn and
        // accurately tracks what was prelude-injected.  Reactive/event-driven skills
        // (triggered mid-turn by tool failures etc.) stay deduplicated — they'll re-fire
        // if their trigger condition occurs again in the fresh context.
        for (const skill of currentTurnSkills) _reactiveFired.delete(skill);
    }

    // ── Text-only step inner function ─────────────────────────────────────────
    // Called when the model returns text with no tool calls.
    // All control-flow exits (return / continue / step--+continue) are returned
    // as StepAction sentinels so the caller can drive the outer for-loop.
    async function _handleTextOnlyStep(
        textContent: string, usage: any, step: number,
        thinkTask: any,
        nudge: (text: string) => any,
    ): Promise<StepAction> {
        // Output at the max_tokens callOAI actually sent (set on every response) → truncated.
        if (_lastMaxTokensSent > 0 && (usage?.completion_tokens ?? 0) >= _lastMaxTokensSent * _TOKEN_FILL_RATIO && step < _loopMax - 1) {
            thinkTask.append('\n[output cut off at token limit — discarding response, compacting before retry]\n', 'error');
            // tombstone the last assistant event so deriveMessages() excludes it.
            _replaceLastAssistantSurface(_s, step, _m => ({ role: 'assistant', content: null }), 'pop-tombstone');
            _forceCompact = true;
            return { do: 'retry' };  // caller: step--; continue
        }
        // Native tool-call markup that no parser could turn into a call (Gemma's
        // `thought<tool_call|>`, or a call cut off mid-arguments): nothing ran, and it is not an
        // answer. Ending the turn on it cost v0.58 requests-1142 (a 2-step first turn, then a blind
        // 54-step continuation). Drop the reply and ask for the call again, up to 3 times a turn.
        if (_BROKEN_CALL_RE.test(textContent) && (ps.brokenCallRetries ?? 0) < 3 && step < _loopMax - 1 && !softStopPending) {
            ps.brokenCallRetries = (ps.brokenCallRetries ?? 0) + 1;
            thinkTask.append('\n[tool call arrived as unparseable text — asking again]\n', 'warn');
            _replaceLastAssistantSurface(_s, step, _m => ({ role: 'assistant', content: null }), 'pop-tombstone');
            _emitNudge('broken_tool_call', nudge('Your last reply was a tool call written as text (tool-call markup in the message), so nothing ran. Send it again as a proper tool call.'));
            _forceToolCall = true;
            return { do: 'continue' };
        }
        // Quality gate before turn-state checks
        const qc = _checkTextResponse(textContent, step, _loopMax, _garbledState);
        if (qc) {
            // Surface-replace the last assistant event with truncated content.
            _replaceLastAssistantSurface(_s, step, m => ({ role: 'assistant', content: qc.truncated, ...(m?.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) }), 'truncation');
            // Re-inject original task so the agent doesn't lose context on
            // generation collapse (no fg-tasks/current.md in headless/Docker).
            // Skipped after compaction: the pinned [TASK …] anchor already keeps it in view.
            const _firstUser = _histR(_s).find((m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.trim());
            if (_firstUser && !_firstUser.content.startsWith('[TASK')) {
                const _taskSnippet = _originalTask(_histR(_s));
                if (_taskSnippet) qc.nudge += `\n\nOriginal task:\n${_taskSnippet}`;
            }
            _emitNudge('quality_check', nudge(qc.nudge));
            if (qc.action === 'bail')
                return { do: 'return', value: await _gracefulSynthesis('persistent garbled output after 3 consecutive attempts', textContent) };
            return { do: 'continue' };
        }
        // Generic step-output validation, pre-state phase: deterministic gates first,
        // minimal LLM yes/no for what regexes can't decide (see _STEP_CHECKS).
        const _task = _originalTask(_histR(_s));
        const _taskGoal = _task.slice(0, 4000);
        // Run validation even on COMPLETED responses so pseudo-calls embedded
        // alongside COMPLETED are caught before the session terminates.
        // re_pass in pseudo_tool_call fast-exits for clean COMPLETED (no LLM call).
        if (step < _loopMax - 1 && !softStopPending && !(ps._postCompactionTurns ?? 0)) {
            const vc = await _validateStepOutput(textContent, ps, 'pre-state', _taskGoal);
            if (vc) {
                thinkTask.append(`\n[validation: ${vc.name} — nudging]\n`, 'warn');
                _emitNudge('step_validation', nudge(vc.nudge));
                // Block (force rework) only on the first fire AND when no prior
                // execute_code has yet succeeded this turn. After a correct state
                // exists, blocking causes models to rework right answers into wrong
                // ones (T3.3/T3.7: step_validation block→warn when prior result passed).
                // A response that is nothing but the pseudo-call has no answer to rework: falling
                // through returned `read_file("game.js")` as the turn's final text (glm5.3-flash,
                // 2026-09-29). Always retry those; the check's max caps the loop.
                const _svFirstFire = ((ps.checkFires?.[vc.name] ?? 0) <= 1);
                if ((_svFirstFire && !_execsThisRun) || (vc.name === 'pseudo_tool_call' && _isBarePseudoCall(textContent))) {
                    _forceToolCall = true;
                    return { do: 'continue' };
                }
                // Advisory mode: nudge in history, model not forced to loop.
            }
        }
        // Scratch-only completion: every file changed this run is a repro/debug/temp file, so the
        // fix itself is not in place (SWE-bench v0.55 astropy-12907: a sed that matched nothing,
        // then COMPLETED with only repro scripts in the patch). One bounce; a second COMPLETED
        // is accepted — the scratch files may be the deliverable.
        if (_isComplete(textContent) && !_BLOCKED_DECLARATION_RE.test(textContent)
            && step < _loopMax - 1 && !softStopPending && !ps.scratchOnlyCheck
            && _editedPaths.size && [..._editedPaths].every(isScratchPath)) {
            ps.scratchOnlyCheck = 1;
            _saveAnswer(ps, textContent);
            _emitNudge('scratch_only_edits', nudge(`You declared COMPLETED, but the only files changed this turn are scratch files: ${[..._editedPaths].slice(0, 6).join(', ')}. No project file was modified, so if the task was to change the code, the fix is not applied — check with \`git diff\` (or read the file) and apply it, then remove the scratch files. If these files are the deliverable, reply COMPLETED again.`));
            return { do: 'continue' };
        }
        // Test-environment workarounds in the change set: a rewritten conftest.py / pytest.ini /
        // setup.cfg that made tests run locally ships with the fix and can break every graded test
        // (v0.58 xarray-5131: a root conftest.py monkeypatching pandas; collection then failed on all
        // 34 graded tests). Skipped when the task itself names the file; a COMPLETED repeated with
        // no edits in between passes. A second bounce follows new edits: v0.59 flask-4045 restored
        // conftest.py after the first, then rewrote it to make the checklist's test run pass.
        if (_s.workflowMode && _isComplete(textContent) && !_BLOCKED_DECLARATION_RE.test(textContent)
            && step < _loopMax - 1 && !softStopPending
            && (ps.envConfigCheck ?? 0) < 2 && (ps.envConfigCheck ? _editEvents > (ps.envConfigAt ?? 0) : true)) {
            const _cfg = await envConfigEdits(_originalTask(_histR(_s)), _editedPaths);
            if (_cfg.length) {
                ps.envConfigCheck = (ps.envConfigCheck ?? 0) + 1;
                ps.envConfigAt = _editEvents;
                _saveAnswer(ps, textContent);
                _emitNudge('env_config_edits', nudge(`You changed test or packaging configuration${_cfg.some(f => f.endsWith('/')) ? ', or added a new top-level package (a stand-in for a missing dependency)' : ''}: ${_cfg.slice(0, 6).join(', ')}. The graded tests run in their own prepared environment and these edits ship with your change — a modified conftest.py or pytest.ini can break every graded test, and a stub package hides the real one. Unless the task asks for these changes, restore them (\`git checkout -- <file>\`, or delete a file or folder you created), keep only the fix itself, then reply COMPLETED again. If local tests can't run without them, check the fix with a short script instead.`));
                return { do: 'continue' };
            }
        }
        // Completion gate: context-dependent rules (trigger_on_completion in skills.js)
        // fire once when the model first declares completion. _reactiveFired dedup in
        // completionGateGuidance makes this a single bounce per turn.
        // _editsThisRun guard: skip gate entirely for data-query tasks (no file writes) —
        // gate re-checks cause models to second-guess correct answers (v0.33 db/10).
        if (_isComplete(textContent) && step < _loopMax - 1 && !softStopPending
            && _editsThisRun && ps.finalCheck < 1) {
            const _blocked = _BLOCKED_DECLARATION_RE.test(textContent);
            let _gate = completionGateGuidance(_editsThisRun, _blocked);
            // SWE-bench graded-test directive: when the task text lists `pytest path::name`
            // identifiers (injected by the runner), require them to pass before COMPLETED.
            // Fires once per session (_reactiveFired dedup); skipped when blocked.
            let _hasGradedTest = false;
            if (!_blocked && _editsThisRun && !_reactiveFired.has('graded_test')) {
                const _taskText = _task;   // guidance examples (e.g. `pytest tests/test_foo.py`) excluded
                // Collect graded test IDs from two formats the runner emits:
                //   1. backtick-quoted `pytest -xvs path.py::name …` — runner always wraps in
                //      backticks and may include flags and multiple paths on one line; parse
                //      the full arg string and filter for *.py tokens (fixes dead regex — T1.3)
                //   2. bare lines in "Graded tests:" block — tests without '::' are emitted as-is
                const _ftpSet = new Set<string>();
                for (const _cmdM of _taskText.matchAll(/pytest\s+(.*?)(?=`|$)/gm))
                    for (const _tok of _cmdM[1].split(/\s+/))
                        if (/^[\w/.+-]+\.py(?:::\S+)?$/.test(_tok)) _ftpSet.add(_tok);
                const _blockM = _taskText.match(/Graded tests[^\n]*\n([\s\S]*?)(?:\n\n|$)/);
                if (_blockM) {
                    for (const _line of _blockM[1].split('\n')) {
                        const _t = _line.trim();
                        if (_t && !_t.startsWith('#')) _ftpSet.add(_t.startsWith('pytest ') ? _t.slice(7).trim() : _t);
                    }
                }
                const _ftpIds = [..._ftpSet];
                if (_ftpIds.length) {
                    _hasGradedTest = true;
                    _reactiveFired.add('graded_test');
                    const _ftpMsg = `Run the graded test now: \`pytest ${_ftpIds.join(' ')}\` — it must exit 0 before you declare COMPLETED.`;
                    _gate = _gate ? `${_gate}\n\n${_ftpMsg}` : `~~~guidance\n${_ftpMsg}\n~~~`;
                }
            }
            if (_gate) {
                _saveAnswer(ps, textContent); ps.finalCheck++;
                _emitNudge('completion_gate', nudge(_gate));
                if (_hasGradedTest) _forceToolCall = true;  // checklist path: advisory only
                return { do: 'continue' };
            }
        }
        // graded_test re-fire: gate already fired once; model declares COMPLETED again.
        // Check the most recent pytest tool result — if tests still failing (or never ran),
        // inject another bounce. Cap at ps.finalCheck < 3 (two re-fires after the first).
        if (_isComplete(textContent) && step < _loopMax - 1 && !softStopPending
            && _editsThisRun && ps.finalCheck >= 1 && ps.finalCheck < 3 && _reactiveFired.has('graded_test')) {
            const _hist = _histR(_s);
            let _testOutput = '';
            for (let _i = _hist.length - 1; _i >= 0; _i--) {
                const _m = _hist[_i];
                if (_m.role !== 'tool') continue;
                const _c = typeof _m.content === 'string' ? _m.content
                    : Array.isArray(_m.content) ? (_m.content as any[]).map((x: any) => x.text ?? '').join('') : '';
                if (/passed|failed|PASSED|FAILED|ERROR|pytest/.test(_c)) { _testOutput = _c; break; }
            }
            // Pass: at least one "N passed" with no "N failed" / "N error"
            const _testPassed = !!_testOutput && /\d+ passed/.test(_testOutput) && !/\d+ (failed|error)/.test(_testOutput);
            if (!_testPassed) {
                const _retryMsg = _testOutput
                    ? `The graded test still failed — fix the failure then run it again: it must exit 0 before you declare COMPLETED.`
                    : `You declared COMPLETED without running the graded test. Run it now — it must exit 0.`;
                _saveAnswer(ps, textContent); ps.finalCheck++;
                _emitNudge('completion_gate', nudge(`~~~guidance\n${_retryMsg}\n~~~`)); _forceToolCall = true;
                return { do: 'continue' };
            }
        }

        // Declared turn state (COMPLETED / BLOCKED)
        const _ts = await _handleTurnState(textContent, step, ps, _oaiAdapter);
        if (_ts.kind === 'return')   return { do: 'return', value: _ts.text };
        if (_ts.kind === 'continue') return { do: 'continue' };

        // Premature BLOCKED: autonomous mode, model declared blocked without making
        // any tool calls this turn. One bounce only (ps.blockedCheck cap).
        if (_BLOCKED_DECLARATION_RE.test(textContent)
            && _s.workflowMode
            && step < _loopMax - 1 && !softStopPending && !(ps.blockedCheck >= 1)) {
            let _toolsThisTurn = 0;
            const _btHist = _histR(_s);
            for (let _i = _btHist.length - 1; _i >= 0; _i--) {
                if (_btHist[_i].role === 'user') break;
                if (_btHist[_i].role === 'tool') _toolsThisTurn++;
            }
            if (_toolsThisTurn === 0) {
                ps.blockedCheck = 1;
                _emitNudge('premature_blocked', nudge('You declared BLOCKED without attempting the task with available tools. Call execute_code or the relevant tool first; only declare BLOCKED: if the tool call itself fails or returns an error.'));
                return { do: 'continue' };
            }
        }
        // Post-state validation: in workflowMode (no user to ask), any non-terminal text
        // reply is a stall — nudge the model to declare COMPLETED/BLOCKED.
        // Also fires in agentic mode (_stepCount > 0: at least one tool call has already
        // run this turn). After any tool call the model is mid-task — text-only without a
        // terminal state is "Thought without Action" and must be nudged even in interactive chat.
        // Also covers empty reasoning-only responses (completion_tokens > 0 but no visible
        // text): always retry regardless of workflowMode, and pop the null assistant message
        // so it doesn't pollute later turns as a "(no text response)" placeholder.
        const _isEmptyReasoning = !textContent.trim() && (usage?.completion_tokens ?? 0) > 0;
        // Agentic mode: at least one tool ran this turn, so we are mid-task even in interactive chat.
        // A text-only response at this point is "Thought without Action" and must be nudged.
        const _isAgenticMode = _stepCount > 0;
        if ((_isEmptyReasoning || _s.workflowMode || _isAgenticMode) && step < _loopMax - 1 && !_s.softStopPending
            && !(ps._postCompactionTurns ?? 0)) {
            const vcPost = await _validateStepOutput(textContent, ps, 'post-state', _taskGoal);
            if (vcPost) {
                thinkTask.append(`\n[validation: ${vcPost.name} — nudging]\n`, 'warn');
                // An empty-reasoning reply (null content) needs no removal: deriveMessages() already
                // excludes content:null assistant entries (session.ts), so callOAI never sees it.
                _emitNudge('step_validation', nudge(vcPost.nudge));
                // Narration announcing its next action ("Let me write the game.js file now.")
                // means the model intends a tool call but keeps emitting text — the reminder
                // alone looped five times in a Cowork run. Force the call it announced.
                // ps.lastWasNarration: the narration_only verdict set by missing_state_line's onFire.
                if (vcPost.name === 'missing_state_line' && ps.lastWasNarration)
                    _forceToolCall = true;
                return { do: 'continue' };
            }
        }
        // Empty final text — recover the last substantive response instead of
        // returning nothing (an empty return scores as an empty answer downstream).
        if (!textContent.trim() && ps.saved?.trim()) return { do: 'return', value: _stripTerminal(ps.saved) };
        // Set blocked token BEFORE stripping: _stripTerminal removes "BLOCKED:" so
        // the caller (agent-core.ts) cannot detect a genuine BLOCKED declaration from
        // the stripped finalText alone. Mirror the _lastTurnDoneToken pattern for COMPLETED.
        if (_BLOCKED_DECLARATION_RE.test(textContent)) setLastTurnBlockedToken(true);
        return { do: 'return', value: _stripTerminal(textContent) };
    }

    for (let step = 0; step < _loopMax; step++) {
        if (softStopPending || activeAbortController?.signal.aborted) return '*(break)*';
        let _taskDoneCalledThisStep = false;
        const _paused = [..._toolPauses].filter(([, until]) => step <= until).map(([t]) => t);
        _stepPausedTools = _paused.length ? new Set(_paused) : null;

        // ── history pruning ────────────────────────────────────────────────────
        // Prune directly on the event-log surface.
        const _pruSess = _getEvtSession(_s);
        if (_pruSess) pruneSessionHistory(_pruSess);

        // ── Token estimation and compaction ─────────────────────────────────────────────
        const _tokEst = _lastInputTokens > 0
            ? _lastInputTokens  // real server-reported count; delta since last call is small vs. threshold
            : (() => {          // fallback: estimate from history (step 0 only, before first server response)
                const h = _histR(_s);
                if (h.length !== _lastHistoryLen || _lastEstTokens === 0) {
                    _lastHistoryLen = h.length;
                    _lastEstTokens  = Math.ceil(estimateTokens(h) * 1.1);
                }
                return _lastEstTokens;
            })();
        if (_forceCompact || (_tokEst > _compactThreshold() && _lastInputTokens > _compactThreshold() * 0.5)) {
            await _doCompact(step);
        }

        if ((ps._postCompactionTurns ?? 0) > 0) ps._postCompactionTurns!--;

        let thinkTask = placeholder.addThinkingTask();

        // Revert fallback when primary recovered
        if (!endpoint && activeEndpoint && _sessionFallback && !getEndpointRotation()) {
            const ep0 = _defaultEndpoint();
            if (!_isCoolingDown(ep0) && activeEndpoint.model !== ep0.model) {
                activeEndpoint = null; _sessionFallback = null;
            }
        }
        // Endpoint rotation
        if (!endpoint) {
            const ep = activeEndpoint ?? _defaultEndpoint();
            const currentKey = `${ep.provider ?? getProvider()}|${ep.model}`;
            const nextSpec = _nextRotationSpec(currentKey, _rotState);
            if (nextSpec) { activeEndpoint = specToEndpoint(nextSpec); _sessionFallback = activeEndpoint; }
        }

        const ep    = activeEndpoint ?? _defaultEndpoint();
        const _epKey = `${ep.provider ?? getProvider()}|${ep.model}`;

        // Pre-flight probe
        if (_endpointNeedsProbe.has(_epKey)) {
            const _probeOk = await _probeOAIEndpoint(ep);
            if (_probeOk) {
                _endpointNeedsProbe.delete(_epKey);
            } else {
                _markFlatCooldown(ep);
                thinkTask.append(`\n[${_epKey}][probe: unreachable — skipping]\n`, 'thinking');
                const fb = getRateLimitFallbackEndpoint();
                if (fb) { activeEndpoint = fb; _sessionFallback = fb; thinkTask.setModel(modelFriendlyName(`${fb.provider}|${fb.model}`)); thinkTask.abort(); continue; }
            }
        }

        const _nudge = text => {
            const role = _nudgeRole(ep.provider ?? getProvider());
            return { role, content: role === 'user' ? `<nudge>${text}</nudge>` : text };
        };
        _nudgeFn = _nudge;
        thinkTask.setModel(modelFriendlyName(_epKey));
        const last = _histR(_s).at(-1);  // read from session
        thinkTask.setPrompt(typeof last?.content === 'string' ? stripInjected(last.content) || last.content : JSON.stringify(last, null, 2));

        let message;
        try {
            message = await withRetry(
                async () => {
                    const msg = await callOAI((c, t) => thinkTask.append(c, t),
                        p => thinkTask.setRequest(JSON.stringify(p, null, 2)),
                        { endpointOverride: activeEndpoint, maxTokens: oaiMaxTokens, inputTokensHint: _lastInputTokens, toolFilterOverride: _s._toolFilter ?? toolFilterOverride, evtSession: _s, evtStep: step });
                    // Detect responses that need a retry — four triggers, all throw isTruncated
                    // so _makeOAIRetryHandler cycles the model pool (same path as 429s/server errors).
                    const _text = (typeof msg.content === 'string' ? msg.content : '').trim();
                    const _fr   = (msg as any).finish_reason as string | null | undefined;
                    // 1. Known retry-worthy finish_reason values (see _FR_* sets at module level).
                    const _frTokenCap = _fr != null && _FR_TOKEN_CAP.has(_fr);
                    const _frFiltered = _fr != null && _FR_FILTERED.has(_fr);
                    const _frError    = _fr != null && _FR_ERROR.has(_fr);
                    // 2. finish_reason null/missing: only fire when content is clearly mid-construction
                    //    (dangling | for tables, open [ ( ` for fences/links) — avoids retrying
                    //    providers that simply omit finish_reason on well-formed responses.
                    const _DANGLING_RE = /[|(\[`]\s*$|```\w*\s*$|\|[ \t]*[*_~`#]+\s*$/;
                    const _missingFR   = _fr == null && !msg.tool_calls?.length
                        && _text.length > 0 && !_isComplete(_text) && _DANGLING_RE.test(_text);
                    // 3. Legacy: very short content despite output tokens (blank/truncated start).
                    //    Requires _text.length > 0 — empty text with completion_tokens is handled
                    //    by _isEmptyReasoning in _handleTextOnlyStep, not by model cycling.
                    const _shortTrunc  = _text.length > 0 && _text.length < 20 && !/[.!?]/.test(_text)
                        && !_isComplete(_text) && !msg.tool_calls?.length
                        && (msg.usage?.completion_tokens ?? 0) >= 10;
                    // 4. Completely empty response with no tool calls — provider swallowed the
                    //    request (e.g. upstream 429 returned as an empty stream rather than an
                    //    HTTP error). Token cap guard excluded: a real 0-token stop is not empty.
                    //    Reasoning-only excluded (completion_tokens > 0): handled by _isEmptyReasoning.
                    const _emptyResponse = !_text && !msg.tool_calls?.length && !_frTokenCap
                        && !(msg.usage?.completion_tokens > 0);
                    // 5. Tool call cut off at max_tokens. Streamed vLLM responses report
                    //    finish_reason "tool_calls" and close the JSON, so only the token count
                    //    shows it; executing it runs truncated code (v0.54: 40 such calls).
                    const _toolCapHit = !!msg.tool_calls?.length && (msg as any)._maxTokens > 0
                        && (msg.usage?.completion_tokens ?? 0) >= (msg as any)._maxTokens * _TOKEN_FILL_RATIO;
                    // 6. Stream went silent mid-response and was cut (SSE idle timeout): the text is
                    //    a fragment, and any tool call in progress was lost.
                    const _frStalled = _fr != null && _FR_STALLED.has(_fr);
                    if (_frTokenCap || _toolCapHit || _frFiltered || _frError || _frStalled || _missingFR || _shortTrunc || _emptyResponse) {
                        const _truncReason = _frStalled ? 'stream_stalled:idle_timeout'
                            : _toolCapHit ? `tool_call_cut_off:${msg.usage?.completion_tokens}`
                            : _frTokenCap ? `finish_reason:${_fr}`
                            : _frFiltered ? `finish_reason:filtered(${_fr})`
                            : _frError    ? `finish_reason:error(${_fr})`
                            : _missingFR  ? `finish_reason:missing,dangling:"${_text.slice(-20)}"`
                            : _emptyResponse ? 'empty:no_content'
                            : `short:"${_text}"`;
                        // Do NOT call markTruncated here: the step stays 'running' so that
                        // content from the retry attempt appends to the same step and is
                        // visible, and complete() can close it as 'done' on success.
                        // markTruncated is called in the outer catch if the whole pool is
                        // exhausted and the error escapes withRetry.
                        const _e: any = new Error(`TruncatedResponse(${_truncReason})`);
                        _e.isTruncated = true;
                        _e.truncReason = _truncReason;
                        if (_frTokenCap || _toolCapHit) {
                            // Head and tail of what was discarded, for the log: the text was in no log
                            // before, so the cause of v0.59's 154 cut-offs (repetition? long code?)
                            // couldn't be checked.
                            const _args = (msg.tool_calls ?? []).map((t: any) => `${t.function?.name}(${t.function?.arguments ?? ''})`).join(' ');
                            const _cut = `${_text}${_args ? ` ${_args}` : ''}`;
                            _e.outputCapHit = { tokens: msg.usage?.completion_tokens ?? 0, toolCall: !!msg.tool_calls?.length, maxTokens: (msg as any)._maxTokens ?? 0,
                                head: _cut.slice(0, 500), tail: _cut.length > 1000 ? _cut.slice(-500) : '',
                                degenerate: (msg as any).degenerate ?? null };
                        }
                        if (_frFiltered) _e.isFiltered = true;
                        if (_frStalled) _e.streamStalled = true;
                        throw _e;
                    }
                    return msg;
                },
                _makeOAIRetryHandler({
                    getEp:         () => activeEndpoint ?? oaiEndpoint(),
                    setEp:         ep => { activeEndpoint = ep; },
                    setFallback:   fb => { _sessionFallback = fb; },
                    onNote:        msg => thinkTask.append(`\n${msg}\n`, 'error'),
                    onModelChange: key => thinkTask.setModel(modelFriendlyName(key)),
                    onContextOverflow: max => {
                        oaiMaxTokens = max;
                        _forceCompact = true;
                        thinkTask.append(`\n[context: reducing max_tokens to ${max}, will compact]\n`, 'thinking');
                    }
                }),
                Infinity,
                e => e.isTruncated || (activeEndpoint ?? oaiEndpoint()).provider === 'custom',
                e => {
                    const ep = activeEndpoint ?? oaiEndpoint();
                    sessionSaveRawMessage?.(activeChatId, {
                        role: 'assistant', kind: 'request_failed',
                        name: `${ep.provider}|${ep.model}`, content: e?.message ?? String(e),
                    });
                }
            );
        } catch (e) {
            if (e.name === 'AbortError') {
                thinkTask.abort();
                // Exit cleanly when: the user pressed Stop (softStopPending), OR our own
                // AbortController was fired externally (signal.aborted — e.g. suspension
                // recovery calling stopNow(), which sets softStopPending=false before abort).
                // Without the signal.aborted check, a dead controller causes a ghost thinking
                // step: addThinkingTask() is called, then sleepInterruptible() immediately
                // throws (signal aborted), propagating the AbortError out of the catch block
                // instead of continuing the loop — cosmetically wrong and semantically confusing.
                if (softStopPending || activeAbortController?.signal.aborted) return '*(break)*';
                // Genuine browser/network abort with a live signal — mobile radio sleep, iOS
                // backgrounding, network interface change. withRetry already retries these but
                // if one escapes the race, re-enter the turn loop without surfacing *(stopped)*.
                thinkTask = placeholder.addThinkingTask();
                await sleepInterruptible(2_000);
                continue;
            }
            // isTruncated escaped withRetry — the whole model pool is exhausted.
            // Close the step as truncated (it was kept 'running' across inner retries)
            // then continue the outer loop so the next iteration re-enters with a fresh step.
            if (e.isTruncated) {
                thinkTask.markTruncated?.(e.truncReason ?? 'pool_exhausted');
                // Output cut off at the token cap: the response was discarded (not executed, not in
                // history). Tell the model why before retrying, or it tends to repeat the runaway.
                if (e.outputCapHit) {
                    const { tokens, toolCall, maxTokens, head, tail, degenerate } = e.outputCapHit;
                    try { convoLogTurn({ type: 'cut_off', name: toolCall ? 'tool_call' : 'text', responseTokens: tokens, response: tail ? `${head}\n[…]\n${tail}` : head, ...(degenerate ? { degenerate } : {}) }); } catch {}
                    // Below the step cap, the limit came from the context clamp: the context is
                    // nearly full, so an unchanged retry is cut off again (v0.55: 46 in a row).
                    if (!degenerate && maxTokens > 0 && maxTokens < _STEP_OUTPUT_CAP) _forceCompact = true;
                    _emitNudge('output_cut_off', _nudge(degenerate
                        ? `Your last response was stopped after about ${tokens} tokens because it had fallen into a loop (${degenerate}${toolCall ? ', in tool-call arguments' : ''}) and was discarded — nothing was executed. Write the next call short and specific: one command or request, no repeated terms, and your reasoning in the reply text, not in code comments.`
                        : `Your last response was cut off at ${tokens} tokens${toolCall ? ' while writing tool-call arguments' : ''} and was discarded — nothing was executed. Keep code short and put your reasoning in the reply text, not in code comments. Split large outputs across several calls.`));
                }
                // Stalled mid-response: typically a very large tool call (a whole app in one
                // write_file) that the provider buffers until done. Ask for smaller pieces.
                if (e.streamStalled) {
                    _emitNudge('output_stalled', _nudge('Your last response stalled mid-generation and was discarded — nothing was executed, and any tool call you were writing was lost. This usually means a single tool call was too large. Make the next call now, keeping it small: split a large file into several smaller files (e.g. index.html, style.css, game.js split by feature), each well under 300 lines — or, if append_file is available, write the first part and append the rest in further calls.'));
                }
                continue;
            }
            const _is429 = _isRateLimit(e.message);
            const _isErr = _isServerError(e.message);
            // Permanent configuration errors (model not found, no access) must not re-enter
            // the retry cycle — fall through to throw so the task fails fast with a clear message.
            const _isPermanent = /does not exist|you do not have access|model not found|no such model/i.test(e.message || '');
            if (_forceCompact && parseContextOverflow(e) !== null) { thinkTask.abort(); continue; }
            const _oEp = activeEndpoint ?? _defaultEndpoint();
            if (_isPermanent) throw e;
            if (_is429) _markCooldown(_oEp, e.retryAfterMs ?? null);
            else if (_isErr) {
                // 4xx without a Retry-After header on custom/vLLM endpoints = transient
                // per-request state (e.g. vLLM spec-decode returning 400 under load,
                // xgrammar FSM rejection). Keep it short (3s) — a long cooldown would
                // serialize parallel tasks against a healthy server.
                // Cloud providers (mistral, groq, etc.) getting a 4xx means the API
                // rejected the request (wrong model ID, unsupported param, etc.) — use
                // the standard flat cooldown so they don't get hammered every 3 seconds.
                const _is4xx = (e as any).status >= 400 && (e as any).status < 500;
                if (_is4xx && !e.retryAfterMs && isCustomEndpoint(_oEp)) _markExactCooldown(_oEp, 3_000);
                else _markFlatCooldown(_oEp, e.retryAfterMs ?? null);
                // HTTP 400 from a cloud provider = permanent availability failure (free-tier
                // restriction, deprecated endpoint, etc.) — pause the model so it is skipped
                // in future turns but remains visible in the model table for the user to manage.
                if ((e as any).status === 400 && !isCustomEndpoint(_oEp)) {
                    const _pauseKey = `${_oEp.provider}|${_oEp.model}`;
                    if (typeof savePausedMainModels === 'function' && typeof getPausedMainModels === 'function') {
                        const _paused = getPausedMainModels();
                        if (!_paused.includes(_pauseKey)) {
                            savePausedMainModels([..._paused, _pauseKey]);
                            thinkTask.append(`\n[${_pauseKey}][paused: HTTP 400]\n`, 'error');
                        }
                    }
                }
            }
            if (_is429 || _isErr) {
                const fb = _sessionFallback ?? getRateLimitFallbackEndpoint();
                if (fb && fb.model !== _oEp.model) {
                    activeEndpoint = fb; _sessionFallback = fb;
                    thinkTask.setModel(modelFriendlyName(`${fb.provider}|${fb.model}`));
                    thinkTask.append(`\n[${_epKey}][switching to ${fb.provider}|${fb.model}]\n`, 'error');
                    thinkTask.abort(); continue;
                }
                const curKey = `${_oEp.provider ?? getProvider()}|${_oEp.model}`;
                const next = _anyFreeSpec(curKey);
                if (next) {
                    activeEndpoint = specToEndpoint(next); _sessionFallback = activeEndpoint;
                    thinkTask.setModel(modelFriendlyName(next));
                    thinkTask.append(`\n[${curKey}][${_is429 ? 'rate limited' : 'server error'}: rotating to ${next}]\n`, 'error');
                    thinkTask.abort(); continue;
                }
                const _allPool = getActiveMainModelList();
                const _minWaitSec = _allPool.length > 0 ? Math.min(..._allPool.map(k => getCooldownRemaining(k)).filter(r => r > 0)) : 0;
                if (_minWaitSec > 0 && _minWaitSec < Infinity) {
                    const _waitMs = _minWaitSec * 1000 + 500;
                    thinkTask.append(`\n[${curKey}][all endpoints cooling — waiting ${fmtDelay(_waitMs)}]\n`, 'error');
                    await sleepInterruptible(_waitMs);
                    const recovered = _anyFreeSpec(curKey);
                    if (recovered) { activeEndpoint = specToEndpoint(recovered); _sessionFallback = activeEndpoint; }
                    thinkTask.abort(); continue;
                }
            }
            throw e;
        }
        if (!message) throw new Error('No response from model');
        _endpointNeedsProbe.delete(_epKey);
        recordSuccess(activeEndpoint ?? _defaultEndpoint());
        // Main-agent requests only (workers and utility calls use other paths): feeds the
        // per-model reliability count used by the Model Priority ranking.
        recordModelSuccess((activeEndpoint ?? _defaultEndpoint())?.model);
        sessionSaveRawMessage?.(activeChatId, {
            role: 'assistant', kind: 'response', name: _epKey,
            content: message.content ?? null,
            ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
        });
        const { usage, _maxTokens, ...msg } = message as any;
        _lastMaxTokensSent = _maxTokens ?? 0;
        // Capture raw content for hallucinated-call detection before _stripThinking removes it.
        const _rawMsgContent = typeof msg.content === 'string' ? msg.content : '';
        if (typeof msg.content === 'string') msg.content = _stripThinking(msg.content) || null;
        // Event log append: the sole write of the assistant message (a fn-tag model's request
        // projection drops tool_calls, see fnTagMessages).
        _evtAppend(_s, 'assistant/message', {
            turn: _s._evtTurn ?? 0,
            step,
            message: { role: 'assistant', content: msg.content ?? null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) },
            ...(usage?.prompt_tokens ? { usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens ?? 0 } } : {}),
        }, { surfaceOp: 'append' });
        if (usage?.prompt_tokens) _lastInputTokens = usage.prompt_tokens;
        // Observe prefix-cache capability: if the response carries cached_tokens > 0,
        // this endpoint actively caches the KV prefix — persist the fact so init.ts
        // can gate warmup calls to only these providers (no point priming a cache that
        // doesn't exist).  Uses the endpoint that actually responded (activeEndpoint),
        // not the pre-withRetry snapshot, so model-cycling retries are attributed correctly.
        const _cachedTok = usage?.prompt_tokens_details?.cached_tokens
                         ?? (usage as any)?.cached_tokens ?? 0;
        if (_cachedTok > 0) recordCacheCapable(activeEndpoint ?? _defaultEndpoint());
        thinkTask.setTokens(
            usage?.prompt_tokens  ?? usage?.input_tokens,
            usage?.completion_tokens ?? usage?.output_tokens,
        );
        thinkTask.complete(); updateTokenLabel();

        const rawContent  = msg.content;
        const textContent = typeof rawContent === 'string' ? rawContent
            : (Array.isArray(rawContent) ? rawContent.map(p => p.text || '').join('') : String(rawContent ?? ''));

        if (softStopPending) return textContent || '*(break)*';

        let calls = message.tool_calls || [];

        // Detect hallucinated self-completed tool calls (model writes the call AND fabricates the
        // result as text, bypassing actual tool execution). _stripThinking removed the block from
        // history; emit a targeted nudge so the model uses native function calling instead.
        if (!calls.length && /<tool_call>[\s\S]*?<tool_name>/i.test(_rawMsgContent)) {
            sessionSaveRawMessage?.(activeChatId, { role: 'assistant', content: _rawMsgContent, kind: 'hallucinated_tool_call' });
            _emitNudge('bad_tool_format', _nudge('You output a tool call containing a fabricated result — the tool was NOT actually executed and the result you wrote was invented. Use native function calling: emit a proper tool call via the JSON schema. Do NOT write tool calls as XML text or include any <result> block.'));
        }

        // XML pseudo-call repair: model emitted <search_workspace>{…} style text instead of
        // proper tool_calls (primed by angle-bracket context injection). Parse and execute as
        // real calls; log with kind:'xml_pseudo_call_repaired' for corpus analysis.
        if (!calls.length) {
            const _xmlCalls = _repairXmlPseudoCalls(textContent, AGENT_TOOL_NAMES) ?? _repairLongcatPseudoCalls(textContent, AGENT_TOOL_NAMES);
            if (_xmlCalls) {
                const _synCalls = _xmlCalls.map((c, i) => ({
                    id: `xml_${step}_${i}`, type: 'function' as const,
                    function: { name: c.name, arguments: JSON.stringify(c.args) },
                }));
                sessionSaveRawMessage?.(activeChatId, { role: 'assistant', content: textContent, kind: 'xml_pseudo_call_repaired', tool_calls: _synCalls });
                thinkTask.append(`\n[repair: xml_pseudo_call → ${_xmlCalls.map(c => c.name).join(', ')}]\n`, 'warn');
                _replaceLastAssistantSurface(_s, step, m => ({ role: 'assistant', content: m?.content ?? null, tool_calls: _synCalls }), 'xml-repair');
                calls = _synCalls;
            }
        }

        // Bracket pseudo-call repair: model emitted [[{"name":"…","parameters":{…}}]] style
        // text instead of proper tool_calls (nemotron-3-ultra-free and similar models that
        // don't reliably use native function calling). Parse and execute as real calls;
        // log with kind:'bracket_pseudo_call_repaired' for corpus analysis.
        if (!calls.length) {
            const _brCalls = _repairBracketPseudoCalls(textContent, AGENT_TOOL_NAMES);
            if (_brCalls) {
                const _synCalls = _brCalls.map((c, i) => ({
                    id: `bracket_${step}_${i}`, type: 'function' as const,
                    function: { name: c.name, arguments: JSON.stringify(c.args) },
                }));
                sessionSaveRawMessage?.(activeChatId, { role: 'assistant', content: textContent, kind: 'bracket_pseudo_call_repaired', tool_calls: _synCalls });
                thinkTask.append(`\n[repair: bracket_pseudo_call → ${_brCalls.map(c => c.name).join(', ')}]\n`, 'warn');
                _replaceLastAssistantSurface(_s, step, m => ({ role: 'assistant', content: m?.content ?? null, tool_calls: _synCalls }), 'bracket-repair');
                calls = _synCalls;
            }
        }

        // Inline pseudo-call repair: the whole reply is `read_file("x")` or
        // {"tool":"read_file","path":"x"} (glm5.3-flash ended turns with these as the answer,
        // 2026-09-29). The text is only the call, so history keeps the real call without it —
        // the model then sees itself using native calls.
        if (!calls.length) {
            const _order = Object.fromEntries((activeTools?.() ?? []).map((t: any) => [t.name, Object.keys(t.parameters?.properties ?? {})]));
            const _inCalls = _repairInlinePseudoCalls(textContent, AGENT_TOOL_NAMES, _order);
            if (_inCalls) {
                const _synCalls = _inCalls.map((c, i) => ({
                    id: `inline_${step}_${i}`, type: 'function' as const,
                    function: { name: c.name, arguments: JSON.stringify(c.args) },
                }));
                sessionSaveRawMessage?.(activeChatId, { role: 'assistant', content: textContent, kind: 'inline_pseudo_call_repaired', tool_calls: _synCalls });
                thinkTask.append(`\n[repair: inline_pseudo_call → ${_inCalls.map(c => c.name).join(', ')}]\n`, 'warn');
                _replaceLastAssistantSurface(_s, step, () => ({ role: 'assistant', content: null, tool_calls: _synCalls }), 'inline-repair');
                calls = _synCalls;
            }
        }

        // Log no-tool-call turns; tool-call turns are logged after _exec with results.
        if (!calls.length) {
            convoLogTurn({
                step, model: ep.model, provider: ep.provider ?? getProvider(),
                promptTokens: usage?.prompt_tokens, responseTokens: usage?.completion_tokens,
                response: textContent, toolCalls: [], loopDetected: false,
                systemPrompt: buildSystemPrompt(),
                lastUserMessage: (() => { try { const u = _histR(_s).filter(m => m.role === 'user'); return typeof u[u.length-1]?.content === 'string' ? u[u.length-1].content : JSON.stringify(u[u.length-1]?.content); } catch { return ''; } })(),
            });
            _updateLogBadge?.();
        }

        if (!calls.length) {
            const _sa = await _handleTextOnlyStep(textContent, usage, step, thinkTask, _nudge);
            if (_sa.do === 'return') return _sa.value;
            if (_sa.do === 'retry') { step--; }
            continue;
        }

        ps.substCheck = 0;
        ps.checkFires = {};
        // A text saved by missing_state_line was not the answer after all — the model went on
        // working. Drop it, so a closing bare COMPLETED asks for a summary instead of showing it.
        if (ps.savedByStateLine) { ps.saved = null; ps.savedByStateLine = false; }
        // Role mode gets a tighter, explicit cap that emits BLOCKED rather than a silent synthesis.
        if (_s.workflowMode && _s.role) {
            const _roleCap = Math.min(_ROLE_STEP_CAP, _loopMax);
            if (_stepCount + 1 >= _roleCap)
                return await _gracefulSynthesis(`role step cap (${_roleCap} steps) reached`, textContent);
        }
        if (++_stepCount >= _loopMax) {
            // Interactive chat: the user can simply continue, so say that plainly (with the open
            // tasks in Cowork) — the 160-token synthesis came back empty and left a bare
            // "*(stopped: …)*" after a 100-step Cowork build (fg-chat 2026-09-27-01-29-29).
            if (!_s.workflowMode) return await _stepBudgetStopMessage(_loopMax);
            return await _gracefulSynthesis('step budget exhausted', textContent);
        }
        if (_stepCount === _stepsLeftWarnAt) {
            const _left = _loopMax - _stepCount;
            // Autonomous runs (benchmarks, Cowork runner) end at the limit, so finish. Interactive chat
            // only pauses — the user can continue — so reach a clean stopping point rather than wrap up.
            _emitNudge('steps_left', _nudge(_s.workflowMode
                ? `${_left} steps left in this turn. Finish now: if you changed code, check that the change is applied (e.g. git diff) and end with COMPLETED; if the task asks for an answer, give it. Do not start new exploration.`
                : `${_left} steps left in this turn before it pauses. Reach a clean stopping point: finish the change you are making, don't start new ones, and leave files in a working state. The user can continue from there.`));
        }

        // Cap per-turn tool calls — see _MAX_CALLS_PER_TURN comment above.
        let _callsOverflowNudge: string | null = null;
        if (calls.length > _MAX_CALLS_PER_TURN) {
            _overflowStreak++;
            if (_overflowStreak >= 3) {
                // Recurring overflow: model ignores the batch-size nudge. Synthesise and exit
                // rather than looping indefinitely (mirrors the step-budget exhaustion path).
                return await _gracefulSynthesis('repeated tool-call overflow', textContent);
            }
            _callsOverflowNudge = `Your response included ${calls.length} tool calls; only the first ${_MAX_CALLS_PER_TURN} ran. Do not assume the remaining ${calls.length - _MAX_CALLS_PER_TURN} executed — they did not. In your next response issue ONLY the next batch of calls (≤${_MAX_CALLS_PER_TURN}); do not restate completed work or plan ahead.`;
            calls.length = _MAX_CALLS_PER_TURN;
        } else {
            _overflowStreak = 0;
        }

        // Malformed tool-call arguments (deterministic tier): JSON.parse failures
        // silently became {} and the tool executed with empty args ("apply_patch: missing
        // required argument", "File not found: undefined"). Repair common LLM JSON defects
        // in place; when irreparable, the tool still runs (its error is real feedback) but
        // a targeted nudge explains the actual cause so the model re-emits valid JSON.
        // repairAllToolCalls owns the ordering: raw repair → normalize → name/envelope/execcode.
        const { bad: _badArgCalls, norm: _normCalls, hasEmptyCode: _hasEmptyCode } = repairAllToolCalls(calls);
        const labels    = calls.map(tc => toolLabel(tc.function.name, parseArgs(tc.function.arguments)));
        const toolTasks = placeholder.addToolStep(labels);

        const oaiOldContents = await Promise.all(_normCalls.map((nc, i) => {
            const { name, args } = nc;
            return (name === 'write_file' && args?.path && args?.content) ? _readOldContent(args.path) : Promise.resolve(null);
        }));
        const _repeatedNames: string[] = [];
        // Repeat guard: a call that recently returned the same result REPEAT_LIMIT times is refused
        // (error result, not executed); after a few refusals the turn ends as BLOCKED below.
        const _thisCallSig = _callSig(_normCalls);
        const _thisPathSig = _pathSig(_normCalls);
        const _pathRefused = _pathRepeatRefused(_repeatGuard, _thisPathSig, _thisCallSig);
        const _refused = _repeatRefused(_repeatGuard, _thisCallSig) || _pathRefused;
        // A refused call made only of workspace reads pauses those tools for the next steps instead
        // of counting toward the turn stop: v0.60 SWE runs ended on read-only repeat stops with
        // 20–75 steps unused, 5 of 8 Verified ones with an empty patch. fetch_url is not paused — in
        // AutomationBench it is often the only tool that can act.
        const _readOnlyRefusal = _refused && _normCalls.every(c => _PAUSABLE_READ_TOOLS.has(c.name));
        // Pause now, so the refusal can say for how long.
        const _refusalPause = _readOnlyRefusal ? Math.max(...[...new Set(_normCalls.map(c => c.name))].map(t => _pauseTool(t, step))) : 0;
        const _exec = _refused
            ? _normCalls.map(({ name, args }, i) => {
                const _r = _pathRefused
                    ? _pathRepeatRefusalResult(_pathRepeatCount(_repeatGuard, _thisPathSig), _thisPathSig!)
                    : _repeatRefusalResult(_repeatCount(_repeatGuard, _thisCallSig));
                const result = _readOnlyRefusal
                    ? { error: `${_r.error} ${[...new Set(_normCalls.map(c => c.name))].join(' and ')} ${_normCalls.length > 1 ? 'are' : 'is'} paused ${pauseText(_refusalPause)}.` }
                    : _r;
                toolTasks?.[i]?.setOutput(JSON.stringify(result, null, 2));
                toolTasks?.[i]?.complete();
                return { name, args, result };
            })
            : await _runToolCalls(_normCalls, toolTasks, {
                forWorker: false,
                blockedTools: _turnExcludedTools,
                pausedTools: _stepPausedTools,
                onPause: (t) => _pauseTool(t, step),
                repeatCache: _repeatCache,
                onTaskDone: () => { _taskDoneCalledThisStep = true; },
                onRepeat: (name) => _repeatedNames.push(name),
                replFails: _s._replaceFailures,
                replNudge: _s._replaceNudgeSent,
            });
        // A read-only refusal is free only while there is budget left and the tool hasn't already been
        // taken away for the rest of the turn; after that it counts, so the turn ends cleanly instead
        // of cycling pause → re-ask → pause to the step cap (sympy-15875, scikit-learn-12471, django-15957).
        const _freeRefusal = _readOnlyRefusal && readRefusalIsFree(step, _loopMax, _normCalls.map(c => _pauseCount.get(c.name) ?? 0));
        const _execOk = _exec.filter(r => !r.result?.error).length;
        if (_refused) {
            _repeatGuard = { ..._repeatGuard, refused: _repeatGuard.refused + (_freeRefusal ? 0 : 1) };
        } else {
            const _thisResSig = _resultSig(_exec);
            // A clean step with a result this turn has never seen forgives one earlier refusal (detectors.ts).
            _repeatGuard = _creditProgress(_updateRepeatGuard(_repeatGuard, _thisCallSig, _thisResSig, _thisPathSig),
                _thisResSig, _execOk === _exec.length);
        }
        // Failure streak (detectors.ts updateFailStreak): real progress resets it, real failures
        // add to it; read-only tools, silent exit-0 runs and missing-environment errors are neutral.
        // A diagnostic ls between failing attempts therefore neither masks nor extends a loop.
        const _prevToolFails = consecutiveToolFails;
        // Python files this step wrote or edited, for the "module has no attribute" check.
        noteAgentFiles(_exec.flatMap((r: any) => [
            ...(r.result?.error ? [] : [r.args?.path ?? r.args?.filename ?? r.args?.file]),
            ...(Array.isArray(r.result?.files_written) ? r.result.files_written : []),
        ]));
        consecutiveToolFails = updateFailStreak(consecutiveToolFails, _exec, _READ_ONLY_TOOLS);
        const _failedThisStep = consecutiveToolFails > _prevToolFails;
        if (consecutiveToolFails === 0) _failSigs.length = 0;
        for (const r of _exec) if (failStreakKind(r.name, r.result, _READ_ONLY_TOOLS) === 'fail') _failSigs.push(failureSignature(r.result));
        convoLogTurn({
            step, model: ep.model, provider: ep.provider ?? getProvider(),
            promptTokens: usage?.prompt_tokens, responseTokens: usage?.completion_tokens,
            response: textContent,
            toolCalls: _exec.map(r => ({ name: r.name, args: r.args, result: r.result })),
            loopDetected: _repeatedNames.length > 0 || consecutiveToolFails >= 5,
            systemPrompt: buildSystemPrompt(),
            lastUserMessage: (() => { try { const u = _histR(_s).filter(m => m.role === 'user'); return typeof u[u.length-1]?.content === 'string' ? u[u.length-1].content : JSON.stringify(u[u.length-1]?.content); } catch { return ''; } })(),
        });
        _updateLogBadge?.();
        // Checked after the log row, so the step that ends the run is in the step log.
        // Same error every time: one directed nudge and 5 more attempts before the stop (once per turn).
        let _sameErrorNudge: string | null = null;
        if (consecutiveToolFails >= _MAX_CONSEC_TOOL_FAILS && !_sameErrorGraceUsed) {
            const _sig = sameErrorStreak(_failSigs);
            if (_sig) {
                _sameErrorGraceUsed = true;
                _sameErrorNudge = sameErrorNudge(_sig, consecutiveToolFails);
                consecutiveToolFails = _MAX_CONSEC_TOOL_FAILS - 5;
            }
        }
        if (consecutiveToolFails >= _MAX_CONSEC_TOOL_FAILS) return await _gracefulSynthesis(`${_MAX_CONSEC_TOOL_FAILS} consecutive tool failures with no progress`, textContent);
        const results = _exec.map((r, i) => ({ tc: calls[i], name: r.name, args: r.args, result: r.result }));
        _noteStopOutputs(results);

        const oaiDiffs = _buildWriteDiffs(
            results.map(({ tc, name, args, result }) => ({ name, args, result, key: tc.id })),
            oaiOldContents
        );
        // Rewrites of this step's tool-call arguments in history, by call id. Write tools: content
        // replaced by the diff. Shell sent as Python that ran as bash: recorded as bash, so the
        // model sees the call that actually ran. With the call left as python and a "Ran as bash —
        // do not re-run it" note, 20% of the next calls were identical re-sends (8.5% after other
        // results; v0.58), and CTF 48 re-sent a call that had printed the flag 10 times.
        const _argEdits = new Map<string, (a: any) => any>();
        for (const [id, d] of oaiDiffs) _argEdits.set(id, (a: any) => ({ ...a, content: d, _contentCompressed: true }));
        for (const id of collectRanAsBash(results)) _argEdits.set(id, (a: any) => ({ ...a, language: 'bash' }));
        if (_argEdits.size) _patchLastAssistantArgs(_s, step, _argEdits);

        const replaceFailNudge = await _getReplaceFailNudge(_s._replaceFailures, _s._replaceNudgeSent);

        const resSig = JSON.stringify(results.map(r => ({ n: r.name, res: r.result })), _fpTrunc);
        const stalledPaths = new Set(calls.map(tc => parseArgs(tc.function.arguments)?.path).filter(Boolean).map(_normPath)) as Set<string>;
        let stuckNudge;
        ({ resultHashes, stuckMsg: stuckNudge } = _updateStuckDetector(resSig, stalledPaths, resultHashes));
        _stuckCallSigs = [..._stuckCallSigs, _thisCallSig].slice(-3);
        if (stuckNudge && results.every(r => r.name === 'execute_code') && new Set(_stuckCallSigs).size > 1)
            stuckNudge = sameOutputMsg(results.map(r => r.result?.stdout ?? r.result?.content ?? ''));
        let envFailNudge: string | null;
        ({ envFailSig: _envFailSig, envFailCount: _envFailCount, envFailTotal: _envFailTotal, envFailMsg: envFailNudge } = _updateEnvFailureDetector(results, _envFailSig, _envFailCount, _envFailTotal));

        const _stepBudgetChars = parseInt(ls(KEYS.AGENT_STEP_BUDGET, String(getAgentMaxToolResult())), 10);
        const stepBudget = { remaining: _stepBudgetChars };

        // The same call returning the same result for the 4th time within the repeat guard's window:
        // history gets a short stub instead of another full copy (the earlier copies are still in
        // context). Nothing is refused or stopped — v0.57's review found every refusal/stop variant
        // cut more scoring runs than loops — but a cycling loop (v0.58 CTF 71: one unzip|grep 14×
        // among variants; OS 40: one cat 25×) stops re-sending the same output. Simulated on v0.58:
        // 1,644 results, 3.1M characters. read_file has its own guard.
        const _histStub = new Map<string, any>();
        for (const r of results) {
            if (r.name === 'read_file') continue;
            const key = `${r.name}|${JSON.stringify(r.args)}|${JSON.stringify(r.result, _fpTrunc)}`;
            const prev = (_dupSeen.get(key) ?? []).filter(s => _stepCount - s < REPEAT_WINDOW);
            if (prev.length >= 3) {
                _histStub.set(r.tc.id, {
                    ...(r.result?.exit_code != null ? { exit_code: r.result.exit_code } : {}),
                    note: `Same result as the ${prev.length} earlier runs of this exact call in your last ${REPEAT_WINDOW} steps — still shown above, not repeated here. If that result answers the task, give your answer now ("not found" is an answer too); otherwise take a different approach. Running it again will not change it.`,
                });
            }
            prev.push(_stepCount);
            _dupSeen.set(key, prev);
        }
        const _forHist = (tc: any, result: any) => _histStub.get(tc.id) ?? result;
        // A cycle through a few commands: each is stubbed, none reaches the repeat guard's 8-in-12
        // refusal, and stuck_detected (3 identical in a row) never sees it. v0.59 AutomationBench
        // cycled `ls -R /workspace` / `ls -R / | grep …` / `ls -la /workspace` this way; a streak of
        // 4 all-stubbed steps would have fired in 86 runs (64 AutomationBench). One nudge per turn.
        _stubStreak = results.length && results.every(r => _histStub.has(r.tc.id)) ? _stubStreak + 1 : 0;
        const _cycleNudge = _stubStreak >= 4 && !_cycleNudged
            // Points at the last result rather than at answering: "give your answer from what you
            // already have" made v0.60 AutomationBench runs, whose task is to act through an API, give
            // up ~5 steps sooner (−0.14 partial credit where it fired; −0.03 for the same runs
            // without it in v0.59). Most of those loops re-sent a request the server had rejected.
            ? (_cycleNudged = true, `Your last ${_stubStreak} steps only repeated earlier calls exactly, with the same results — you are cycling through the same few commands, and they will not show anything new. Read the last error or result literally: it usually says what is wrong (a missing field, a wrong name, the wrong place for a value). Change the request itself — arguments, body, endpoint or command — rather than re-sending it.`)
            : null;

        const _errPrefix = (r: any): string => {
            if (r?.error) return `[TOOL ERROR: ${String(r.error).slice(0, 200)}]\n`;
            if (r?.exit_code != null && r.exit_code !== 0) return `[EXIT CODE ${r.exit_code}]\n`;
            return '';
        };
        // Append one tool/result event per tool call to the event log — the only write of tool results.
        // Always individual; a fn-tag request merges them per step (fnTagMessages).
        for (const { tc, name, result } of results) {
            const _pfx = _errPrefix(result);
            const _histContent = _pfx + JSON.stringify(_historyResult(name, _forHist(tc, result), false, stepBudget));
            _evtAppend(_s, 'tool/result', {
                turn: _s._evtTurn ?? 0,
                step,
                callId:  tc.id,
                name,
                content: _histContent,
                ...(result?.error || (result?.exit_code != null && result.exit_code !== 0) ? { isError: true } : {}),
            }, { surfaceOp: 'append' });
        }

        const _reactive = !(ps._postCompactionTurns ?? 0) && reactiveSkillGuidance(results.map(r => ({ name: r.name, args: r.args, result: r.result })));
        if (_reactive) { _emitNudge('reactive_guidance', _nudge(_reactive)); _forceToolCall = true; }
        // Track successful file edits — feeds the completion gate ('edit' condition).
        // Exclude fg-tasks/ writes (e.g. fg-tasks/current.md setup) — those aren't code edits.
        if (results.some(r => (r.name === 'write_file' || r.name === 'replace_in_file' || r.name === 'apply_patch') && !r.result?.error && !String(r.result?.path ?? '').startsWith('fg-tasks/')))
            _editsThisRun = true;
        // Also set _editsThisRun when execute_code writes workspace files (Director-role benchmarks
        // have no write_file, so the gate only fires if bash/python wrote files — detected via
        // files_written populated by nativeExec's pre/post filesystem snapshot in headless-runner.ts).
        if (!_editsThisRun && results.some(r =>
            r.name === 'execute_code' && !r.result?.error && (r.result?.exit_code ?? 0) === 0
            && Array.isArray(r.result?.files_written) && r.result.files_written.length > 0))
            _editsThisRun = true;
        // Which files changed this run — for the scratch-only completion check.
        for (const r of results) {
            if (r.result?.error) continue;
            if (r.name === 'write_file' || r.name === 'replace_in_file') {
                const p = r.result?.path ?? r.args?.path;
                if (p && !String(p).startsWith('fg-tasks/')) _editedPaths.add(String(p));
            } else if (r.name === 'apply_patch') {
                for (const m of String(r.args?.patch ?? r.args?.diff ?? '').matchAll(/^\+\+\+ (?:b\/)?(\S+)/gm))
                    if (m[1] !== '/dev/null') _editedPaths.add(m[1]);
            } else if (r.name === 'execute_code' && (r.result?.exit_code ?? 0) === 0 && Array.isArray(r.result?.files_written)) {
                for (const p of r.result.files_written) _editedPaths.add(String(p));
            }
        }
        if (results.some(r => !r.result?.error && (r.name === 'run_workers' || r.name === 'write_file'
            || r.name === 'replace_in_file' || r.name === 'apply_patch'
            || (r.name === 'execute_code' && Array.isArray(r.result?.files_written) && r.result.files_written.length))))
            _editEvents++;
        // For directorLoop's closing turn: a project (non-scratch) file changed, by the director or a
        // worker. Repro/debug scripts alone don't make a fix worth finishing.
        if ([..._editedPaths].some(p => !isScratchPath(p)) || results.some(r => r.name === 'run_workers'
            && (r.result?.agents ?? []).some((a: any) => Array.isArray(a?.wrote) && a.wrote.some((p: any) => !isScratchPath(String(p))))))
            _turnStop.edited = true;
        // Track successful execute_code — feeds step_validation advisory mode.
        // A prior successful exec means the model can already use tools; further
        // step_validation fires should warn rather than block (T3.3/T3.7).
        if (results.some(r => r.name === 'execute_code' && !r.result?.error && (r.result?.exit_code ?? 0) === 0))
            _execsThisRun = true;

        // ── Post-results nudge zone ─────────────────────────────────────────
        // Phase contract: this is the ONLY place user-role guidance may be appended
        // after tool execution — tool results are already in history above, so the
        // assistant tool_calls → role:'tool' pairing is intact.
        if (_callsOverflowNudge)               _emitNudge('calls_overflow', _nudge(_callsOverflowNudge));
        if (_cycleNudge)                       _emitNudge('dup_cycle', _nudge(_cycleNudge));
        // stuck_detected: 3 consecutive identical full-result signatures — the model is in a
        // genuine loop with no new information. Nudge only: the nudge offers answering or BLOCKED,
        // both text replies, so forcing a tool call (tool_choice 'required') would rule them out
        // and leave repeating the call as the only move. The repeat guard ends real loops.
        // Do NOT _gracefulSynthesis here: for SWE tasks !_editsThisRun is true throughout the
        // entire exploration phase, so early termination kills tasks that would have recovered.
        if (_sameErrorNudge)                  _emitNudge('same_error', _nudge(_sameErrorNudge));
        else if (stuckNudge)                  _emitNudge('stuck_detected', _nudge(stuckNudge));
        else if (envFailNudge)                _emitNudge('env_failure', _nudge(envFailNudge));
        else if (consecutiveToolFails >= 5 && _failedThisStep) _emitNudge('tool_failures', _nudge('Multiple consecutive tool calls are failing. Diagnose the root cause before retrying, or end with BLOCKED: if you cannot proceed.'));
        else if (replaceFailNudge)            _emitNudge('replace_fail', _nudge(replaceFailNudge));
        if (!stuckNudge) {
            const _errRes = results.filter(r => r.result?.error || (r.result?.exit_code != null && r.result.exit_code !== 0));
            // Rate-limit: skip on the first error in a burst (the [TOOL ERROR] prefix in history
            // already carries the signal). Fire only on the 2nd+ consecutive error, and stop at 5+
            // where tool_failures (the escalation path at :1073) already fired.
            if (_errRes.length && consecutiveToolFails >= 2 && consecutiveToolFails < 5) {
                const _errParts = _errRes.map(r => r.result?.error
                    ? `${r.name}: ${String(r.result.error).slice(0, 120)}`
                    : `${r.name}: exit_code=${r.result.exit_code}`);
                _emitNudge('tool_failure', _nudge(`Tool error(s) — ${_errParts.join('; ')}. Fix before declaring COMPLETED.`));
            }
        }
        if (_repeatedNames.length)            _emitNudge('tool_repeat', _nudge(`You repeated tool call(s) you already made this turn: ${_repeatedNames.join(', ')}. Here are the cached results — no need to re-execute, move forward.`));
        if (_badArgCalls.length) {
            _emitNudge('bad_args', _nudge(`The arguments of your ${_badArgCalls.join(', ')} tool call(s) were not valid JSON — they were executed with EMPTY arguments and their errors reflect that, not the tool itself. Re-emit each call with valid JSON arguments.`));
            _forceToolCall = true;
        }
        if (_hasEmptyCode)        _emitNudge('empty_code', _nudge('execute_code was called with no code argument. Provide the code as: {"code": "...", "language": "bash"}.'));


        // ps.lastToolFailed removed — assigned but never read (T2.7).
        // ps.gateRequiresExecVerify removed — forced verification before COMPLETED caused
        // wasted turns on TAC/TerminalBench tasks where no test suite exists.

        // Empty-FS → bash fallback (CTF-36): repeated empty list_files → run ls -la directly
        if (!_emptyFsNudged) {
            for (const { name, result } of results) {
                if (name === 'list_files' && Array.isArray(result.files) && result.files.length === 0) {
                    const prev = _emptyListTargets.get(result.path) ?? 0;
                    _emptyListTargets.set(result.path, prev + 1);
                    if (prev >= 1 && (!enabledTools || enabledTools.has('execute_code'))) {
                        _emptyFsNudged = true;
                        let lsOut: string;
                        try {
                            const lsResult = await executeToolAsync('execute_code', { language: 'bash', code: `ls -la "${result.path}"` }, null);
                            lsOut = typeof lsResult?.output === 'string' ? lsResult.output
                                  : typeof lsResult?.stdout === 'string' ? lsResult.stdout
                                  : JSON.stringify(lsResult);
                        } catch (e) { lsOut = `(error: ${(e as Error).message})`; }
                        const _lsContent = `No results from "ls", results from "ls -la":\n${lsOut}`;
                        _addUserMessage(_s, _lsContent);
                        break;
                    }
                }
            }
        }

        // The model kept issuing the refused call: stop instead of spending the step budget on it.
        if (_repeatGuard.refused >= REPEAT_REFUSALS_BEFORE_STOP)
            return await _gracefulSynthesis(`it kept repeating calls that had already returned the same result many times`, textContent);

        if (softStopPending) return '*(break)*';
    }
    return await _gracefulSynthesis('maximum step limit reached');
}

// callLLM — raw single-attempt LLM call: preflight check, fetch, stream decode.
// No retry logic — callers embed this inside withRetry + _makeOAIRetryHandler.
// When ep can rotate between retries (e.g. callLLMComplete), build payload inside
// the withRetry lambda and pass the freshly-resolved ep + payload each attempt.
// onRequest: called with the payload object before the fetch (for debug/display).
async function callLLM(
    ep: any,
    payload: any,
    onChunk: (text: string, kind: string) => void,
    { onRequest = null as ((p: any) => void) | null } = {}
): Promise<any> {
    const { url, key, model } = ep;
    const provider = ep.provider ?? getProvider();
    const isCustom = isCustomEndpoint(ep);

    // Preflight: known rate-limit window — bail before spending a request slot.
    const _waitMs = knownLimitWaitMs(ep);
    if (_waitMs > 0) {
        const _e: any = new Error(`HTTP 429 known rate limit (${model}: ${Math.ceil(_waitMs / 1000)}s)`);
        _e.retryAfterMs = _waitMs;
        _e.preFlight = true; // cooldown already set; retry handler must not extend it
        throw _e;
    }

    onRequest?.(payload);
    recordRequest(ep);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key) headers['Authorization'] = `Bearer ${key}`;
    if (provider === 'nvidia') headers['Accept'] = 'text/event-stream';
    // OpenRouter identifies apps via HTTP-Referer + X-Title; used for analytics and
    // partner-tier quota allocation.
    if (provider === 'openrouter') {
        headers['HTTP-Referer'] = 'https://freegent.app/';
        headers['X-Title'] = 'FreeGent';
    }

    const _effectiveProxy = ep.proxy ? getLocalApiProxy() : '';

    // Two-phase abort: connection-establishment timeout clears once headers arrive so it
    // cannot fire during the stream body read. AbortSignal.timeout() as a static timer
    // would kill active SSE streams mid-response (e.g. thinking models streaming past 90s).
    const _conn = connectSignal(activeAbortController?.signal, isCustom ? FETCH_TIMEOUT_CUSTOM_MS : FETCH_TIMEOUT_MS);
    const _connSig = _conn.signal;

    let resp: Response;
    // Serialise before the try: a TypeError from JSON.stringify is a bug, not a dropped connection.
    const _reqBody = JSON.stringify(payload);
    try {
        resp = _effectiveProxy
            ? await fetch(_effectiveProxy, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: _connSig,
                body: JSON.stringify({ url, method: 'POST', headers, body: _reqBody }),
            })
            : await fetch(url, { method: 'POST', headers, signal: _connSig, body: _reqBody });
    } catch (e) {
        throw asTransportError(e); // fetch only rejects when the request never completed
    } finally {
        _conn.clear(); // release timer — cannot abort the body reader after headers received
    }
    if (!resp.ok) throw await _httpErrorFromResponse(resp, `[${provider}|${model}]`);
    return decodeOAIResponse(resp, onChunk);
}

async function callOAI(onChunk: (chunk: string, ...rest: any[]) => void, onRequest: (r: any) => void, { localHistory = null as any[] | null, forWorker = false, endpointOverride = null as any, roleOverride = null as any, toolFilterOverride = null as Set<string> | null, maxTokens = null as number | null, inputTokensHint = 0, evtSession = null as AgentSession | null, evtStep = 0, forkPrefix = null as { system: string; tools: any[] | null } | null } = {}): Promise<any> {
    const ep = endpointOverride ?? oaiEndpoint();
    const { model } = ep;
    const provider = ep.provider ?? getProvider();
    const isNvidia = provider === 'nvidia';
    const _bsp = buildSystemPrompt;
    const _bwsp = buildWorkerSystemPrompt;
    if (!_bsp || !_bwsp) throw new Error('System prompt builders not available — reload the page (tools.js may not have loaded).');
    // isCustom triggers per-step token clamping below; definition shared with the payload builder.
    const isCustom    = isCustomEndpoint(ep);
    const isGoogle    = provider === 'google';
    const googleThinkBudget = isGoogle && modelSupportsThinking(provider, model)
        ? (forWorker ? getWorkerThinkingBudget() : thinkingLevelBudget('google')) : 0;
    const defaultMaxTokens = isNvidia ? 65536
        : (isGoogle && googleThinkBudget > 0 ? 65536
        : (isCustom ? getOAIContextTokens() : 32768));
    const toolFormat  = getModelToolFormat(provider, model);
    const hasTools    = toolFormat !== 'none';
    // fn-tag models get the same native `tools` JSON schema as 'openai'-format models (so they
    // know what's available), but this endpoint doesn't execute that schema — tool calls must be
    // written as a literal text tag, which nothing tells the model unless we say so explicitly.
    // Without this, compliance is inconsistent: sometimes a valid tag, sometimes bare narration
    // with no tag at all (silently not a tool call), occasionally a hallucinated fake tag+result.
    const _fnTagNote = toolFormat === 'fn-tag'
        ? '\n\n## Tool-call format (this endpoint)\nThis endpoint does not execute the tool schema natively — to call a tool, output exactly this tag as literal text: `<function=NAME>{"arg":"value"}</function>` (NAME is the tool name, the body is valid JSON arguments). Output ONLY the tag, nothing else on that line — no narration before it, no fabricated result after it. The real result arrives in the next turn.'
        : '';
    // Forked worker: reuse the parent's system prompt and tools verbatim (prefix-cache identity).
    const sysPrompt = forkPrefix ? forkPrefix.system : (forWorker ? _bwsp(roleOverride) : _bsp()) + _fnTagNote;
    // log the request header (model, system prompt size, tool count).
    // evtSession / evtStep come from runTurn via the options object.
    if (evtSession) {
        _evtAppend(evtSession, 'request/header', {
            turn:            (evtSession as any)._evtTurn ?? 0,
            step:            evtStep,
            model:           ep.model,
            provider:        ep.provider ?? provider,
            systemPromptLen: sysPrompt.length,
            toolCount:       hasTools ? (activeTools?.() ?? []).length : 0,
        });
    }
    const thinkBudget = isNvidia && !endpointOverride && modelSupportsThinking(provider, model)
        ? (forWorker ? getWorkerThinkingBudget() : thinkingLevelBudget('nvidia')) : 0;
    const customThinkBudget = isCustom ? thinkingLevelBudget('custom') : 0; // 0 = off
    // The history is the event log's projection (deriveMessages). A fn-tag model gets the text-tag
    // shape of it (fnTagMessages). Workers are excluded: their localOH is the authoritative history
    // (it includes the task message which is never added to the worker's event session). On step 0
    // deriveMessages() returns [] (only turn/start is logged) and the task would be silently lost.
    const _evtSessOAI = (evtSession && !forWorker) ? _getEvtSession(evtSession) : null;
    let _effectiveHist: any[] = _evtSessOAI ? _evtSessOAI.deriveMessages() : (localHistory ?? []);
    if (_evtSessOAI && toolFormat === 'fn-tag') _effectiveHist = fnTagMessages(_effectiveHist);
    // For custom endpoints, clamp max_tokens so prompt + output fits within the configured context window.
    // Prefer exact prompt_tokens from the previous response (inputTokensHint) + estimate of new messages
    // added since then; fall back to estimateTokens * 1.25 when no prior call exists.
    // 1.25x (not 1.1x): code-heavy content tokenises at ~3 chars/token vs the 4-char heuristic,
    // causing the estimate to run 15–25% low — a 10% buffer produces frequent 400s on benchmarks.
    let effectiveMaxTokens = maxTokens ?? defaultMaxTokens;
    if (isCustom) {
        const ctxWindow = getOAIContextTokens();
        // Build once; used by both branches below.
        const msgs = [{ role: 'system', content: sysPrompt }, ..._effectiveHist.filter(m => !(m.role === 'assistant' && m.content == null && !m.tool_calls?.length))];
        let estInput;
        if (inputTokensHint > 0) {
            // Exact base from last vLLM response + rough estimate of messages added since then.
            const estFull = Math.ceil(estimateTokens(msgs) * 1.25);
            estInput = Math.max(inputTokensHint + 512, estFull);
        } else {
            estInput = Math.ceil(estimateTokens(msgs) * 1.25);
        }
        const available = ctxWindow - estInput - 512;
        // Percentage floor: even if the estimate is accurate, never allocate more than 25% of
        // the context window for output — guards against compounding estimation error.
        const pctCap = Math.floor(ctxWindow * 0.25);
        const stepCap = _STEP_OUTPUT_CAP + Math.max(0, customThinkBudget);
        effectiveMaxTokens = Math.max(256, Math.min(effectiveMaxTokens, available, pctCap, stepCap));
    }
    // Sanitize history before sending:
    // 1. Drop bare assistant messages (content:null, no tool_calls) — these arise when
    //    _stripThinking empties a response; strict providers (Mistral, Devstral) reject them
    //    with HTTP 400 "Invalid assistant message: content=None tool_calls=None".
    // 2. Normalize mid-conversation role:'system' messages (NVIDIA nudges) to role:'user' —
    //    Mistral/Devstral reject system after position 0.
    let _hist = buildRequestMessages(_effectiveHist, provider);
    // Guard: vLLM (Qwen3 Jinja2 template) raises "No user query found in messages." when
    // the messages array contains no user-role entry. This should never happen — the
    // invariant is that the first event appended to a session is the task's user message.
    // If it is violated (e.g. by surface corruption), fall back to the local-history anchor
    // so the request remains valid and a warning is logged for diagnosis.
    if (isCustom && !_hist.some((m: any) => m.role === 'user')) {
        console.warn('[callOAI] invariant: no user message in effective history —',
            'surface.length=', _evtSessOAI?.surface?.length ?? -1,
            'hist.length=', _hist.length,
            'last surface seqs=', JSON.stringify(_evtSessOAI?.surface?.slice(-5) ?? []));
        const _anchor = (localHistory ?? []).find((m: any) => m.role === 'user');
        if (_anchor) _hist = [_anchor, ..._hist];
    }
    // All provider quirks (thinking kwargs, cache keys, tool_choice suppression, top_p)
    // live in buildChatPayload — do not add per-provider fields here.
    const _ftc = _forceToolCall; _forceToolCall = false; // consume and reset before the call
    const payload = buildChatPayload(ep, {
        messages: [{ role: 'system', content: sysPrompt }, ..._hist],
        tools: forkPrefix ? forkPrefix.tools : (hasTools
            ? (() => {
                const all = buildOAITools(forWorker, toolFilterOverride).filter(t => forWorker || !_turnExcludedTools?.has(t.function?.name));
                if (forWorker || !_stepPausedTools) return all;
                // A pause never leaves the request without tools.
                const rest = all.filter(t => !_stepPausedTools!.has(t.function?.name));
                return rest.length ? rest : all;
            })()
            : null),
        temperature: getTemperature(),
        maxTokens: effectiveMaxTokens,
        stream: true,
        thinkingBudget: thinkBudget || customThinkBudget || googleThinkBudget,
        preserveThinking: getPreserveThinking(),
        sampling: isCustom ? getSamplingParams() : null,
        forceToolCall: _ftc,
    });
    if (!forWorker) _lastMainRequest = { system: sysPrompt, tools: payload.tools ?? null, messages: payload.messages.slice(1) };
    // Wrap onChunk to timestamp each received token — used by the suspension recovery
    // discriminator in init.ts (_lastStreamChunkAt <= _hiddenAtMs → stream died = suspend).
    const _timestampedOnChunk = (chunk: string, ...rest: any[]) => {
        _lastStreamChunkAt = Date.now();
        window._lastStreamChunkAt = _lastStreamChunkAt;
        onChunk(chunk, ...rest);
    };
    // Tool format learning for models not in model-caps' table (see getModelToolFormat).
    // Schema rejected → learn 'none' and resend right away without tools, so the turn goes on.
    let result: any;
    try {
        result = await callLLM(ep, payload, _timestampedOnChunk, { onRequest });
    } catch (e) {
        if (!hasTools || forkPrefix || isToolFormatListed(provider, model) || !isToolsRejectedError(e)) throw e;
        recordToolFormat(provider, model, 'none');
        console.warn(`[tool-format] ${provider}/${model}: tools rejected — now 'none':`, e.message);
        const { tools: _t, tool_choice: _tc, ...noTools } = payload;
        noTools.messages = [{ role: 'system', content: forWorker ? _bwsp(roleOverride) : _bsp() }, ...payload.messages.slice(1)];
        result = await callLLM(ep, noTools, _timestampedOnChunk, { onRequest });
    }
    // Native tool calls from a model that started as fn-tag by default → it is an 'openai' model.
    if (toolFormat === 'fn-tag' && result.tool_calls?.length && !isToolFormatListed(provider, model))
        recordToolFormat(provider, model, 'openai');
    // Fallback parser: also fires for 'openai' models when vLLM fails to parse the model's XML
    // tool-call syntax (e.g. ThinkingCap generating <invoke>/<execute_code> instead of
    // <tool_call>{json}</tool_call>). Safe because parseFnTagCalls is restricted to known tool names.
    if ((toolFormat === 'fn-tag' || toolFormat === 'openai') && result.content && !result.tool_calls?.length) {
        const { tool_calls, cleaned } = parseFnTagCalls(result.content);
        if (tool_calls.length) {
            // Capture the pre-strip text before it's overwritten — this is otherwise gone
            // forever, and it's exactly what's needed to diagnose a model's tool-call
            // compliance (valid tag vs. bare narration vs. a hallucinated fake tag+result).
            sessionSaveRawMessage?.(activeChatId, { role: 'assistant', content: result.content, kind: 'fn_tag_strip' });
            result.content    = cleaned || null;
            result.tool_calls = tool_calls;
        }
    }
    // The max_tokens actually sent: truncation checks compare completion_tokens against it,
    // because streamed vLLM responses report finish_reason "tool_calls" even when cut off.
    result._maxTokens = effectiveMaxTokens;
    return result;
}

// Quick pre-flight probe: GET /v1/models to verify the endpoint is reachable before spending tokens.
// Returns true if the server is up (2xx or 4xx auth error), false on 5xx / network failure / timeout.
async function _probeOAIEndpoint(ep: any): Promise<boolean> {
    const probeUrl = ep.url.replace(/\/chat\/completions.*$/, '/models');
    const headers  = {};
    if (ep.key) headers['Authorization'] = `Bearer ${ep.key}`;
    const signal   = AbortSignal.timeout(5_000);
    try {
        const proxyUrl = ep.proxy ? getLocalApiProxy() : '';
        const resp = proxyUrl
            ? await fetch(proxyUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
                body: JSON.stringify({ url: probeUrl, method: 'GET', headers, body: null }) })
            : await fetch(probeUrl, { method: 'GET', headers, signal });
        return resp.status < 500; // 2xx or 4xx (auth/not-found) = server is up
    } catch { return false; }
}

// Strip <think>/<thinking> blocks, stray close tags, and hallucinated self-completed tool calls
// from model content before storing in history.
// Hallucinated calls: some thinking models (nemotron) emit
//   <tool_call><tool_name>web_search</tool_name><result>{"source":...}</result></tool_call>
// as text — the tool was never actually executed and the result is fabricated. Stripping
// prevents poisoning history. Detection + logging + targeted nudge happen in _agentLoop.
// Note: Format A fn-tag calls use <tool_call><function=name>...</function></tool_call> — they
// do NOT contain <tool_name>, so the pattern below leaves them untouched (and they will
// have already been processed by parseFnTagCalls before _stripThinking runs anyway).
function _stripThinking(text: string): string {
    if (!text) return text;
    return text
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/<thought>[\s\S]*?<\/thought>/gi, '')    // Gemma
        .replace(/(<\/think>|<\/thinking>|<\/thought>)\s*/gi, '')
        .replace(/<tool_call>[\s\S]*?<tool_name>[\s\S]*?<\/tool_call>/gi, '')
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
        .replace(/(<\/tool_call>|<tool_call>)\s*/gi, '')
        .trim();
}

// Window bridge for module consumers (workers, tools, llm-shared, agent-core) and
// headless: in JSDOM, module free-variable reads resolve through globalThis, which the
// bootstrap windowProxy forwards here. (Detectors → detectors.ts, history hygiene →
// history.ts, tool repair → tool-call-repair.ts — each bridges its own exports.)
Object.assign(window, { runTurn, callLLM, callOAI, getLastMainRequest, getTurnStopInfo, _runToolCalls, _validateStepOutput, _saveAnswer, _patchOAIWriteArgs, _stripThinking, clearSessionFallback, clearReplaceState, applyKeywordToolFilter });

// §7: named ES module exports alongside window bridge (harness adapter / headless import paths).
// Note: clearSessionFallback and clearReplaceState are already exported via export function above.
// getAgentMaxSteps is re-exported here so headless callers can import it from a single loop module
// without also importing all of config.js.
export { runTurn, callOAI };
export { getAgentMaxSteps } from './config.js';
