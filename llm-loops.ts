import { openaiHistory, activeAbortController, softStopPending, activeChatId, mainAgentRole, workflowMode, lastUserMessageText, type AgentSession, defaultSession, setReactiveFired, _reactiveFired, currentTurnSkills, setSessionToolFilter, setLastTurnDoneToken, setLastTurnBlockedToken } from './state.js';
import { _fpTrunc, _updateBlankSteps, _updateStuckDetector, _checkTextResponse, _updateEnvFailureDetector } from './detectors.js';
import { _BLOCKED_DECLARATION_RE, _isComplete, _handleTurnState, _stripTerminal } from './turn-protocol.js';
import { validateOutput, AGENT_TOOL_NAMES } from './step-validator.js';
import { emitNudge } from './nudge-emitter.js';
import { parseContextOverflow, fmtDelay, sleepInterruptible, withRetry, _makeOAIRetryHandler, _httpErrorFromResponse, _parseRetryAfter } from './retry.js';
import { _endpointNeedsProbe, knownLimitWaitMs, recordRequest, recordSuccess, recordCacheCapable, _isRateLimit, _isServerError, _markCooldown, _markFlatCooldown, _markExactCooldown, _isCoolingDown, getCooldownRemaining, oaiEndpoint, _defaultEndpoint, specToEndpoint, _anyFreeSpec, getRateLimitFallbackEndpoint, _nextRotationSpec, modelFriendlyName } from './model-router.js';
import { _normPath, _invalidateReadDedup, resetSeenReadFiles, _historyResult, pruneOAIHistory, pruneSessionHistory, repairOAIHistory } from './history.js';
import { stripInjected, parseArgs } from './history-util.js';
import { _repairToolCallArgs, _repairToolNames, _repairExecCodeArgs, _repairXmlPseudoCalls, _repairBracketPseudoCalls, _repairArgEnvelope, repairAllToolCalls } from './tool-call-repair.js';
import { buildSystemPrompt } from './system-prompt.js';
import { reactiveSkillGuidance, completionGateGuidance } from './skill-guidance.js';
import { getModelToolFormat, parseFnTagCalls } from './model-caps.js';
import { isCustomEndpoint, buildChatPayload } from './payload-builder.js';
import { buildOAITools, activeTools } from './tool-schemas.js';
import { streamOAICompat, nonStreamOAICompat, decodeOAIResponse } from './stream-decode.js';
import { compactHistory } from './llm-shared.js';
import { _lcsDiff, _diffContent } from './diff-utils.js';
import { type RenderAdapter, NULL_RENDER_ADAPTER } from './render-adapter.js';
import { KEYS, getProvider, getTemperature, modelSupportsThinking, getWorkerThinkingBudget, thinkingLevelBudget, getOAIContextTokens, getAgentMaxSteps, getAgentProactiveCompact, getAgentCompactTokens, getContextThreshold, isContextSizeKnown, getAgentCompactAt, estimateTokens, getSamplingParams, getLocalApiProxy, ls, enabledTools, getActiveMainModelList, getEndpointRotation, getPreserveThinking } from './config.js';
import { executeToolAsync, toolLabel } from './tools.js';
import { agentReadFile, agentFileMtime } from './workspace.js';
import { convoLogTurn, _updateLogBadge } from './convo-log.js';
import { sessionSaveRawMessage } from './session-store.js';
import { registry } from './session-registry.js';
import { compactSurface, type Session } from './session.js';
import { type SurfaceIntent } from './session-event.js';

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
 * Return the Session for the given AgentSession, falling back to the global
 * registry's active session (main agent path).
 * Returns null in the browser when no session has been created yet.
 */
function _getEvtSession(s: AgentSession): Session | null {
    return s._session ?? registry.active();
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

/**
 * Dual-write helper — appends a user/message to both _s.history (fn-tag path) and the event log.
 *
 * Every user-role content injection must write to BOTH sinks:
 *   1. _s.history  — only for fn-tag and no-session paths (histLegacy=true);
 *                    native sessions read from deriveMessages(), not _s.history.
 *   2. event log   — always; deriveMessages() is the sole source of truth for
 *                    native sessions, so omitting this would silently drop the message.
 *
 * Use this helper for any "append user message" that belongs to the simple path
 * (identical guards on both sinks).  Complex cases with different shapes on each
 * sink (e.g. nudge re-injection: history receives the full entry object; event log
 * wraps system-role content in <nudge> before storing as user/message) keep their
 * inline writes.
 */
function _dualWriteUser(s: AgentSession, content: string, histLegacy: boolean): void {
    if (histLegacy) s.history.push({ role: 'user', content });
    _evtAppend(s, 'user/message', { role: 'user', content }, { surfaceOp: 'append' });
}

/**
 * mirror a compaction of _s.history to the event-log surface.
 * Called after compactHistory() rebuilds _s.history so deriveMessages() stays
 * in sync with what the LLM will receive on the next callOAI() call.
 *
 * @param sess       - active Session; caller verifies it is non-null
 * @param oldSurf    - snapshot of session.surface taken BEFORE compactHistory ran
 * @param newHistory - _s.history AFTER compactHistory rebuilt it
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
        // Guard: also bail if newHistory[1] is not a proper compaction summary — this can
        // happen when compactHistory took the hard-drop fallback (no summary is produced);
        // in that case the surface already holds the pre-drop history, which is still valid.
        const summaryMsg = newHistory[1];
        if (!summaryMsg?.content) return; // unexpected: no summary
        if (typeof summaryMsg.content !== 'string' ||
            !summaryMsg.content.startsWith('[SYSTEM: The conversation history')) return;

        // Shadow [firstHidden..lastHidden] with the summary.
        compactSurface(sess, summaryMsg.content, firstHidden, lastHidden);

        // Re-append items from newHistory[2+] as new surface events
        // (they were in the old surface and are now shadowed; we create fresh events
        //  so the surface ordering is correct: summary → understood → tail).
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

/**
 * canonical history reader.
 * For native-format models with an active session, reads from deriveMessages() so
 * control-flow logic (token estimation, task message search, nudge detection) sees
 * the live event-log state rather than the stale _s.history array.
 * For fn-tag / no-session: falls back to _s.history (unchanged path).
 */
function _histR(s: AgentSession): any[] {
    const sess = _getEvtSession(s);
    return sess ? sess.deriveMessages() : s.history;
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
const _FR_TOKEN_CAP = new Set(['length', 'MAX_TOKENS', 'max_tokens', 'OTHER', 'other']);
const _FR_FILTERED  = new Set(['content_filter', 'SAFETY', 'filtered', 'RECITATION']);
const _FR_ERROR     = new Set(['error', 'abort']);
// Normal finish reasons (stop, end_turn, tool_calls, …) are never checked — fall-through is the normal path.

// Per-turn tool-call cap — legitimate parallel batches never exceed this; higher counts
// indicate runaway call storms (e.g. astropy-7746: 163 calls in one turn).
const _MAX_CALLS_PER_TURN = 20;

// Fraction of the response-token budget at which we treat output as truncated and discard
// the response, compact, and retry.
const _TOKEN_FILL_RATIO = 0.98;

// Tail chars kept from a file-read result for the per-file snippet map (used in step diffs).
const _FILE_SNIP_TAIL = 500;

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
        execute_code:    'Fix the error above. Pyodide notes: no subprocess/os.system; install missing packages with `import micropip; await micropip.install(["pkg"])`; use the fetch_url tool for HTTP requests.',
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
        const preview = content.length > 3000 ? content.slice(0, 2800) + '\n...[truncated — ' + content.length + ' chars total]' : content;
        return `[EDIT FAILED ${n}x on "${fp}"] Current file content:\n\`\`\`\n${preview}\n\`\`\`\nCopy the old_string character-for-character from the content above. Do not paraphrase or reconstruct from memory.`;
    }
    return null;
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

// Fixed protocol-violation reminder — fires when a no-tool-call response ended with none of
// the three declared states. Identical text every call so endpoint prefix cache absorbs the cost.
const _COMPLETION_NUDGE = 'Protocol reminder: Previous response missing final state declaration. Reply with ONLY:\nCOMPLETED — task done\nBLOCKED: <exact reason> — cannot proceed\nOr call the next tool. No other text.';

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

async function _runToolCalls(normCalls: Array<{name: string; args: any}>, toolTasks: any[] | null, { forWorker, context = null as any, onStart = null as ((name: string, args: any, i: number) => void) | null, onTaskDone = null as (() => void) | null, onResult = null as ((name: string, args: any, result: any) => void) | null, onRepeat = null as ((name: string) => void) | null, repeatCache = null as Map<string, any> | null, replFails = null as Map<string, number> | null, replNudge = null as Map<string, number> | null }): Promise<Array<{name: string; args: any; result: any}>> {
    return Promise.all(normCalls.map(async ({ name, args }, i) => {
        const task = toolTasks?.[i];
        task?.setPrompt(JSON.stringify({ tool: name, args }, null, 2));
        onStart?.(name, args, i);
        let result;
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
        try { result = await executeToolAsync(name, args, context); }
        catch (e) { result = { error: e.message, hint: _toolErrorHint(name) }; }
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
            repeatCache.set(key, result);
            // Evict oldest entries when the cache grows beyond the cap.
            while (repeatCache.size > _REPEAT_CACHE_MAX)
                repeatCache.delete(repeatCache.keys().next().value);
            if (_WRITE_TOOLS.has(name)) {
                repeatCache.clear();
            } else if (name === 'execute_code') {
                // Any execute_code call may change the environment (pip install, make, etc.).
                // Evict all OTHER execute_code entries so subsequent identical commands
                // re-run rather than returning a result from before the environment changed.
                // Keep this call's own entry so same-step duplicate calls still deduplicate.
                for (const k of repeatCache.keys())
                    if (k !== key && k.startsWith('execute_code|')) repeatCache.delete(k);
            }
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
async function _gracefulSynthesis(reason: string, lastContent: string = ''): Promise<string> {
    if (typeof callLLMComplete !== 'function') return `*(stopped: ${reason})*`;
    try {
        const ctx = lastContent ? `Last agent output:\n${lastContent.slice(0, 600)}\n\n` : '';
        const text = await callLLMComplete(
            `${ctx}An autonomous agent was force-stopped (${reason}). In 1-2 sentences summarise what was accomplished and state why it stopped. End with: BLOCKED: <reason>.`,
            { maxTokens: 160, label: 'termination:synthesis', maxAttempts: 1 }
        );
        return text?.trim() || `*(stopped: ${reason})*`;
    } catch { return `*(stopped: ${reason})*`; }
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
    if (_stripTerminal(text ?? '').trim() || !ps.saved) ps.saved = text;
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
        re_pass: t => t.includes('<handover>') || /^```handover\b/m.test(t)
            || (_isComplete(t) && !new RegExp('"name"\\s*:\\s*"(?:' + _toolNamesRe() + ')"').test(t))
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
        // Handover blocks are intentional structured output, not text-format tool calls —
        // skip the fail check entirely when one is present (re_pass already passes it).
        // Returns the matched tool name (string) when recognisable, true for generic
        // pseudo-call formats (invoke/tool_name XML), false when no violation found.
        // step-validator.ts preserves the string and exposes it as vc.toolName.
        re_fail: t => {
            if (t.includes('<handover>')) return false;
            // Strip inline code spans so "`update_task_status(path, status)`" in
            // documentation does not trigger a deterministic pseudo-call nudge.
            // Code fences are NOT stripped — a tool call inside ``` is a real pseudo-call.
            const _bare = t.replace(/`[^`\n]+`/g, '…');
            const m = new RegExp(`\\b(${_toolNamesRe()})(?:_tool)?\\s*\\(`).exec(_bare)
                   ?? new RegExp(`"name"\\s*:\\s*"(${_toolNamesRe()})"`).exec(t)
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
        name: 'missing_state_line', phase: 'post-state', max: 5,
        re_pass: t => _isComplete(t),   // already has COMPLETED/BLOCKED — pass
        re_fail: t => !_isComplete(t) && mainAgentRole?.name?.toLowerCase() !== 'director',
        llmPrompt: '',                   // deterministic: no LLM judge needed
        nudge: (_text: string, _payload: any, n: number) => {
            if ((n ?? 1) >= 5) return 'You have written text five times in a row without a terminal state token. Declare COMPLETED: <answer> or BLOCKED: <reason> immediately — no further narration.';
            return 'Your response must end with a state token: COMPLETED (task done) or BLOCKED: <reason> (cannot proceed without user input). Add one now.';
        },
        // Save the answer text when this check fires so a subsequent bare "COMPLETED"
        // (the model's next reply after the state-token nudge) can be accepted without
        // requiring the answer to be repeated.  Uses _saveAnswer so an empty text arg
        // (e.g. from a reasoning-only step) cannot overwrite an already-saved answer.
        onFire: (ps: any, text: string) => { _saveAnswer(ps, text); },
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
    vc.check.onFire?.(ps, text);
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

// Unified turn function: always uses openaiHistory as canonical format.
// Main turn loop — dispatches through callOAI (all providers including Google via OAI-compat).
// Cross-provider fallback is handled by changing activeEndpoint with no history conversion.
async function runTurn(endpoint: any, placeholder: RenderAdapter, { forWorker = false, toolFilterOverride = null as Set<string> | null, session, forceToolCall = false }: { forWorker?: boolean; toolFilterOverride?: Set<string> | null; session?: AgentSession; forceToolCall?: boolean } = {}): Promise<string> {
    const _s = session ?? defaultSession;
    // Every nudge must land in THIS turn's history. emitNudge() defaults to the
    // module-level openaiHistory, which is only the same array when _s is defaultSession
    // (the browser path, where .history is a getter proxying it). Headless entry points
    // call createSession(), which allocates a fresh array — so the default silently sent
    // every nudge to an array the run never reads, and the model saw none of them from
    // 8028033 (2026-07-13, AgentSession) until this fix. Bind it once here so a new call
    // site cannot reintroduce the bug. See docs/dead-code-audit-2026-07-25.md §4.5.
    const _emitNudge = (name: string, entry: any, opts: any = {}) => {
        emitNudge(name, entry, { history: _s.history, ...opts });
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
    repairOAIHistory();
    if (!forWorker) resetSeenReadFiles();
    setLastTurnDoneToken(false);
    setLastTurnBlockedToken(false);
    // Director kicks pass forceToolCall:true to prevent step-0 planning-text exits.
    // The flag is consumed+cleared by callOAI on the first LLM request of this turn.
    if (forceToolCall) _forceToolCall = true;
    let _stepCount = 0, resultHashes = [], blankSteps = 0, consecutiveStalls = 0, consecutiveToolFails = 0, _garbledState = { count: 0 }, _envFailSig = '', _envFailCount = 0, _envFailTotal = 0, _overflowStreak = 0;
    const _repeatCache = new Map();
    const ps: { finalCheck: number; cont: number; saved: any; substCheck: number; checkFires: Record<string, number>; blockedCheck?: number; emptyBodyCount?: number; _lastCompactionStep?: number; _postCompactionTurns?: number } = { finalCheck: 0, cont: 0, saved: null, substCheck: 0, checkFires: {} };
    let _editsThisRun = false;      // any successful write_file/replace_in_file/apply_patch — feeds the completion gate
    let _execsThisRun = false;      // any successful execute_code (exit 0) — feeds step_validation advisory mode (T3.3/T3.7)
    let _emptyFsNudged = false;     // empty-FS fallback fires at most once per turn
    const _emptyListTargets = new Map(); // path → count of consecutive empty list_files results
    let _nudgeFn;
    const _oaiAdapter = {
        pushNudge: text => _emitNudge('turn_state', _nudgeFn(text)),
        spliceFromSecondLast: count => {
            // only splice _s.history for fn-tag / no-session; session handles native via surface replace.
            // Guard: only splice when history.length >= count + 2, so the first user message
            // (anchor at history[0]) is never removed — same invariant as the session surface guard.
            const _splSessCheck = _getEvtSession(_s);
            if (!_splSessCheck && _s.history.length >= count + 2) _s.history.splice(_s.history.length - 2, count);
            // mirror the splice to the session surface via a tombstone replace.
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
    if (!forWorker) {
        _sessionFallback = null;
        _rotState.step = 0;
        const _ep0 = endpoint ?? _defaultEndpoint();
        if (_isCoolingDown(_ep0)) {
            const fb = getRateLimitFallbackEndpoint();
            if (fb) _sessionFallback = fb;
        }
    }
    let activeEndpoint    = endpoint ?? _sessionFallback ?? null;
    let oaiMaxTokens      = null;
    let _forceCompact     = false;
    let _lastInputTokens  = 0;
    let _lastHistoryLen   = 0;    // last history.length seen by the estimator (for cache hit check)
    let _lastEstTokens    = 0;    // cached result of estimateTokens for that length

    const _loopMax = getAgentMaxSteps();

    // On the first user turn: apply keyword matching on top of the LLM-classified set.
    // Classification itself is the caller's responsibility (agentSend / runAgentTurn /
    // headless-runner) and must be awaited before runTurn is called.
    if (!forWorker && _histR(_s).filter((m: any) => m.role === 'user').length === 1) {
        const _firstUser = _histR(_s).find((m: any) => m.role === 'user');
        applyKeywordToolFilter(typeof _firstUser?.content === 'string' ? _firstUser.content : '', _s);
    }

    // ── Compaction inner function ───────────────────────────────────────────
    // Called when the token budget is full.  Compacts history, re-classifies tools,
    // and re-injects any pending nudge.  Returns the taskComplete string if the
    // compaction summariser declared done, or null to continue the step loop.
    async function _doCompact(step: number): Promise<string | null> {
        _forceCompact = false;
        // Capture any pending nudge so it can be re-injected if compaction drops it.
        const _lastPre = _histR(_s).at(-1);  // read from session
        const _pendingNudge = (_lastPre?.role === 'user' && typeof _lastPre.content === 'string' && _lastPre.content.startsWith('<nudge>'))
            || (_lastPre?.role === 'system' && typeof _lastPre.content === 'string')
            ? _lastPre : null;
        convoLogTurn({ type: 'history_snapshot', history: _histR(_s).slice() });
        // snapshot session surface BEFORE compactHistory wipes _s.history,
        // so we can mirror the compaction to the event log afterwards.
        // pass session's deriveMessages() as effectiveHistory so compactHistory
        // reads from the live event log instead of the stale _s.history array.
        const _evtSessC = _getEvtSession(_s);
        const _preSurfC = _evtSessC ? [..._evtSessC.surface] : null;
        const _effectiveForCompact = _evtSessC ? _evtSessC.deriveMessages() : undefined;
        const _compact = await compactHistory(placeholder, activeEndpoint, _s, _effectiveForCompact);
        if (_compact?.taskComplete) {
            setLastTurnDoneToken(true);
            return _compact.taskComplete;
        }
        // Mirror compaction: shadow old surface events with summary + tail items.
        if (_evtSessC && _preSurfC && _preSurfC.length > 1) {
            _mirrorCompactionToSession(_evtSessC, _preSurfC, _s.history);
        }
        ps._lastCompactionStep = step;
        ps._postCompactionTurns = 2;
        // Re-inject the nudge if compaction dropped it from the tail (rare safety net —
        // pending nudge is always the last message and thus always in the tail, so the
        // mirror already handles it in the common case; this fires only on unusual tail gaps).
        // push to _s.history only for fn-tag (callOAI reads _s.history for fn-tag).
        if (_pendingNudge) {
            const _lastAfter = _histR(_s).at(-1);
            // Native sessions: deriveMessages() returns new objects on every call so
            // identity always mismatches even when the nudge is already present (mirror
            // already re-appended it). Use content equality for native sessions to avoid
            // a duplicate event-log entry; keep identity for fn-tag where the same
            // _s.history array object is read back.
            const _nudgeStillPresent = _evtSessC
                ? (typeof _lastAfter?.content === 'string' &&
                   typeof _pendingNudge.content === 'string' &&
                   _lastAfter.content === _pendingNudge.content)
                : _lastAfter === _pendingNudge;
            if (!_nudgeStillPresent) {
                const _isFnTagC = getModelToolFormat(
                    (activeEndpoint ?? _defaultEndpoint()).provider ?? getProvider(),
                    (activeEndpoint ?? _defaultEndpoint()).model) === 'fn-tag';
                if (!_evtSessC || _isFnTagC) _s.history.push(_pendingNudge);
                // System-role nudges (NVIDIA) must be wrapped in <nudge> before storing
                // as user/message — matches the _emitNudge dual-write pattern.
                if (typeof _pendingNudge.content === 'string') {
                    const _reInjectContent = _pendingNudge.role === 'user'
                        ? _pendingNudge.content
                        : `<nudge>${_pendingNudge.content}</nudge>`;
                    _evtAppend(_s, 'user/message',
                        { role: 'user', content: _reInjectContent },
                        { surfaceOp: 'append' });
                }
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
            const c: string = val.content;
            _fileSnips.set(val.path, { label, snippet: c.length > _FILE_SNIP_TAIL ? c.slice(-_FILE_SNIP_TAIL) : c });
        }
        if (_fileSnips.size) {
            const body = [..._fileSnips.values()].map(({ label, snippet }) => `${label}:\n${snippet}`).join('\n\n');
            const _flsContent = `[Files read before compaction — last-read content retained so you can verify fix state without re-reading:\n\n${body}]`;
            const _isFnTagC2 = getModelToolFormat(
                (activeEndpoint ?? _defaultEndpoint()).provider ?? getProvider(),
                (activeEndpoint ?? _defaultEndpoint()).model) === 'fn-tag';
            _dualWriteUser(_s, _flsContent, !_evtSessC || _isFnTagC2);
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
        // After compaction the context window is fresh — the prelude guidance that was
        // injected on earlier turns is gone.  Re-enable those skills by removing them
        // from _reactiveFired so buildTriggeredGuidance re-injects them on the next turn.
        // currentTurnSkills holds the skills triggered at the start of this turn and
        // accurately tracks what was prelude-injected.  Reactive/event-driven skills
        // (triggered mid-turn by tool failures etc.) stay deduplicated — they'll re-fire
        // if their trigger condition occurs again in the fresh context.
        for (const skill of currentTurnSkills) _reactiveFired.delete(skill);
        return null;
    }

    // ── Text-only step inner function ─────────────────────────────────────────
    // Called when the model returns text with no tool calls.
    // All control-flow exits (return / continue / step--+continue) are returned
    // as StepAction sentinels so the caller can drive the outer for-loop.
    // histLegacy is a per-iteration local (re-derived inside the loop); passed explicitly
    // because this function is defined before the for-loop.
    async function _handleTextOnlyStep(
        textContent: string, usage: any, step: number,
        thinkTask: any, histLegacy: boolean,
        nudge: (text: string) => any,
    ): Promise<StepAction> {
        const _ep2 = activeEndpoint ?? _defaultEndpoint();
        // Use 65536 for Google models (supports up to 65536 output tokens, more with thinking).
        let _maxTok = oaiMaxTokens ?? (_ep2.provider === 'google' ? 65536 : (_ep2.provider === 'custom' ? (getOAIContextTokens?.() ?? 32768) : 32768));
        if (_ep2.provider === 'custom') {
            const _ctxWin     = getOAIContextTokens();
            const _exactInput = usage?.prompt_tokens ?? _lastInputTokens;
            const _pctCap     = Math.floor(_ctxWin * 0.25);
            _maxTok = Math.max(256, Math.min(_maxTok, _ctxWin - _exactInput - 200, _pctCap));
        }
        if ((usage?.completion_tokens ?? 0) >= _maxTok * _TOKEN_FILL_RATIO && step < _loopMax - 1) {
            thinkTask.append('\n[output cut off at token limit — discarding response, compacting before retry]\n', 'error');
            // only pop from _s.history for fn-tag / no-session.
            if (histLegacy) _s.history.pop();
            // tombstone the last assistant event so deriveMessages() excludes it.
            _replaceLastAssistantSurface(_s, step, _m => ({ role: 'assistant', content: null }), 'pop-tombstone');
            _forceCompact = true;
            return { do: 'retry' };  // caller: step--; continue
        }
        // Quality gate before turn-state checks
        const qc = _checkTextResponse(textContent, step, _loopMax, _garbledState);
        if (qc) {
            // only mutate _s.history for fn-tag / no-session; native sessions use surface replace.
            if (histLegacy) {
                const lastMsg = _s.history[_s.history.length - 1];
                _s.history[_s.history.length - 1] = { ...lastMsg, content: qc.truncated };
            }
            // Surface-replace the last assistant event with truncated content.
            _replaceLastAssistantSurface(_s, step, m => ({ role: 'assistant', content: qc.truncated, ...(m?.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) }), 'truncation');
            // Re-inject original task so the agent doesn't lose context on
            // generation collapse (no fg-tasks/current.md in headless/Docker).
            const _origTask = _histR(_s).find((m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.trim());
            if (_origTask && !_origTask.content.startsWith('[TASK')) {
                const _taskSnippet = typeof _origTask.content === 'string'
                    ? _origTask.content.slice(0, 2000)
                    : '';
                if (_taskSnippet) qc.nudge += `\n\nOriginal task:\n${_taskSnippet}`;
            }
            _emitNudge('quality_check', nudge(qc.nudge));
            if (qc.action === 'bail')
                return { do: 'return', value: await _gracefulSynthesis('persistent garbled output after 3 consecutive attempts', textContent) };
            return { do: 'continue' };
        }
        // Generic step-output validation, pre-state phase: deterministic gates first,
        // minimal LLM yes/no for what regexes can't decide (see _STEP_CHECKS).
        const _origTaskMsg = _histR(_s).find((m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.trim());
        const _taskGoal = (_origTaskMsg && !_origTaskMsg.content.startsWith('[TASK'))
            ? _origTaskMsg.content.slice(0, 400) : '';
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
                const _svFirstFire = ((ps.checkFires?.[vc.name] ?? 0) <= 1);
                if (_svFirstFire && !_execsThisRun) {
                    _forceToolCall = true;
                    return { do: 'continue' };
                }
                // Advisory mode: nudge in history, model not forced to loop.
            }
        }
        // Completion gate: context-dependent rules (trigger_on_completion in skills.js)
        // fire once when the model first declares completion. _reactiveFired dedup in
        // completionGateGuidance makes this a single bounce per turn.
        // _editsThisRun guard: skip gate entirely for data-query tasks (no file writes) —
        // gate re-checks cause models to second-guess correct answers (v0.33 db/10).
        if (!forWorker && _isComplete(textContent) && step < _loopMax - 1 && !softStopPending
            && _editsThisRun && ps.finalCheck < 1) {
            const _blocked = _BLOCKED_DECLARATION_RE.test(textContent);
            let _gate = completionGateGuidance(_editsThisRun, _blocked);
            // SWE-bench graded-test directive: when the task text lists `pytest path::name`
            // identifiers (injected by the runner), require them to pass before COMPLETED.
            // Fires once per session (_reactiveFired dedup); skipped when blocked.
            if (!_blocked && _editsThisRun && !_reactiveFired.has('graded_test')) {
                const _taskText = typeof _origTaskMsg?.content === 'string' ? _origTaskMsg.content : '';
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
                    _reactiveFired.add('graded_test');
                    const _ftpMsg = `Run the graded test now: \`pytest ${_ftpIds.join(' ')}\` — it must exit 0 before you declare COMPLETED.`;
                    _gate = _gate ? `${_gate}\n\n${_ftpMsg}` : `~~~guidance\n${_ftpMsg}\n~~~`;
                }
            }
            if (_gate) {
                _saveAnswer(ps, textContent); ps.finalCheck++;
                _emitNudge('completion_gate', nudge(_gate)); _forceToolCall = true;
                return { do: 'continue' };
            }
        }

        // Declared turn state (COMPLETED / BLOCKED)
        const _ts = await _handleTurnState(textContent, step, ps, _oaiAdapter);
        if (_ts.kind === 'return')   return { do: 'return', value: _ts.text };
        if (_ts.kind === 'continue') return { do: 'continue' };

        if (textContent.includes('<handover>')) return { do: 'return', value: textContent };
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
                if (_isEmptyReasoning) {
                    // Remove the null-content assistant entry so it does not accumulate.
                    // fn-tag/no-session: pop from _s.history (_histR returns the live array).
                    // Native sessions: _histR returns a new deriveMessages() array each call,
                    // so _h.pop() would be a no-op AND at(-1) returns the previous non-null
                    // message (content:null is already filtered by deriveMessages()), making
                    // the guard fail too. Skip entirely — deriveMessages() already excludes
                    // content:null assistant entries (session.ts:191), so the entry is
                    // invisible to callOAI without any explicit removal.
                    if (histLegacy) {
                        const _h = _histR(_s);
                        const _last = _h.at(-1);
                        if (_last?.role === 'assistant' && !_last?.content && !_last?.tool_calls?.length) {
                            _h.pop();
                        }
                    }
                }
                _emitNudge('step_validation', nudge(vcPost.nudge));
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

        // ── history pruning ────────────────────────────────────────────────────
        // Native sessions prune directly on the event-log surface;
        // fn-tag/no-session uses the array-based pruner on _s.history directly.
        const _pruSess = _getEvtSession(_s);
        if (_pruSess) { pruneSessionHistory(_pruSess); }
        else          { pruneOAIHistory(_s.history); }

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
            const _compactDone = await _doCompact(step);
            if (_compactDone !== null) return _compactDone;
        }

        if ((ps._postCompactionTurns ?? 0) > 0) ps._postCompactionTurns!--;

        let thinkTask = placeholder.addThinkingTask();

        // Revert fallback when primary recovered
        if (!forWorker && !endpoint && activeEndpoint && _sessionFallback && !getEndpointRotation()) {
            const ep0 = _defaultEndpoint();
            if (!_isCoolingDown(ep0) && activeEndpoint.model !== ep0.model) {
                activeEndpoint = null; _sessionFallback = null;
            }
        }
        // Endpoint rotation
        if (!forWorker && !endpoint) {
            const ep = activeEndpoint ?? _defaultEndpoint();
            const currentKey = `${ep.provider ?? getProvider()}|${ep.model}`;
            const nextSpec = _nextRotationSpec(currentKey, _rotState);
            if (nextSpec) { activeEndpoint = specToEndpoint(nextSpec); _sessionFallback = activeEndpoint; }
        }

        const ep    = activeEndpoint ?? _defaultEndpoint();
        const _epKey = `${ep.provider ?? getProvider()}|${ep.model}`;

        // Pre-flight probe
        if (!forWorker && _endpointNeedsProbe.has(_epKey)) {
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
                        { localHistory: _s.history, endpointOverride: activeEndpoint, maxTokens: oaiMaxTokens, inputTokensHint: _lastInputTokens, toolFilterOverride: _s._toolFilter ?? toolFilterOverride, evtSession: _s, evtStep: step });
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
                    if (_frTokenCap || _frFiltered || _frError || _missingFR || _shortTrunc || _emptyResponse) {
                        const _truncReason = _frTokenCap ? `finish_reason:${_fr}`
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
                        if (_frFiltered) _e.isFiltered = true;
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
                    forWorker,
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
            if (e.isTruncated) { thinkTask.markTruncated?.(e.truncReason ?? 'pool_exhausted'); continue; }
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
            if ((_is429 || _isErr) && !forWorker) {
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
        sessionSaveRawMessage?.(activeChatId, {
            role: 'assistant', kind: 'response', name: _epKey,
            content: message.content ?? null,
            ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
        });
        const { usage, ...msg } = message;
        // Capture raw content for hallucinated-call detection before _stripThinking removes it.
        const _rawMsgContent = typeof msg.content === 'string' ? msg.content : '';
        if (typeof msg.content === 'string') msg.content = _stripThinking(msg.content) || null;
        const _isFnTag = getModelToolFormat(ep.provider ?? getProvider(), ep.model) === 'fn-tag';
        const _evtSessActive = !!_getEvtSession(_s);
        // _histLegacy: true when _s.history must be mutated directly — fn-tag (callOAI reads from
        // it) or no active event-log session (pre-Phase-4 path). False for native sessions where
        // the event log is the sole source of truth and _s.history mutations are skipped.
        const _histLegacy = _isFnTag || !_evtSessActive;
        // Dual-write: assistant/message.  Cannot use _dualWriteUser — this variant has
        // fn-tag-specific shape differences (tool_calls stripped from the history copy so
        // callOAI doesn't see them twice) and carries usage metadata in the event payload.
        // Native sessions: the event log append below IS the sole write.
        if (_histLegacy) {
            if (_isFnTag && msg.tool_calls?.length) { const { tool_calls: _tc, ...msgNoTC } = msg; _s.history.push(msgNoTC); }
            else _s.history.push(msg);
        }
        // Event log append (sole write for native sessions).
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
            const _xmlCalls = _repairXmlPseudoCalls(textContent, AGENT_TOOL_NAMES);
            if (_xmlCalls) {
                const _synCalls = _xmlCalls.map((c, i) => ({
                    id: `xml_${step}_${i}`, type: 'function' as const,
                    function: { name: c.name, arguments: JSON.stringify(c.args) },
                }));
                sessionSaveRawMessage?.(activeChatId, { role: 'assistant', content: textContent, kind: 'xml_pseudo_call_repaired', tool_calls: _synCalls });
                thinkTask.append(`\n[repair: xml_pseudo_call → ${_xmlCalls.map(c => c.name).join(', ')}]\n`, 'warn');
                // only mutate _s.history for fn-tag / no-session; native sessions use surface replace below.
                if (_histLegacy) _s.history[_s.history.length - 1] = { ..._s.history[_s.history.length - 1], tool_calls: _synCalls };
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
                // only mutate _s.history for fn-tag / no-session; native sessions use surface replace below.
                if (_histLegacy) _s.history[_s.history.length - 1] = { ..._s.history[_s.history.length - 1], tool_calls: _synCalls };
                _replaceLastAssistantSurface(_s, step, m => ({ role: 'assistant', content: m?.content ?? null, tool_calls: _synCalls }), 'bracket-repair');
                calls = _synCalls;
            }
        }

        // Detect consecutive blank visible responses (e.g. thinking-mode models).
        const blankStall = _updateBlankSteps(!!calls.length, !!textContent.trim(), blankSteps, consecutiveStalls);
        blankSteps = blankStall.blankSteps; consecutiveStalls = blankStall.consecutiveStalls;
        const stallNudge = blankStall.stallMsg;

        // Log no-tool-call turns; tool-call turns are logged after _exec with results.
        if (!calls.length) {
            convoLogTurn({
                step, model: ep.model, provider: ep.provider ?? getProvider(),
                promptTokens: usage?.prompt_tokens, responseTokens: usage?.completion_tokens,
                response: textContent, toolCalls: [], loopDetected: !!stallNudge,
                systemPrompt: buildSystemPrompt(),
                lastUserMessage: (() => { try { const u = _histR(_s).filter(m => m.role === 'user'); return typeof u[u.length-1]?.content === 'string' ? u[u.length-1].content : JSON.stringify(u[u.length-1]?.content); } catch { return ''; } })(),
            });
            _updateLogBadge?.();
        }

        if (!calls.length) {
            const _sa = await _handleTextOnlyStep(textContent, usage, step, thinkTask, _histLegacy, _nudge);
            if (_sa.do === 'return') return _sa.value;
            if (_sa.do === 'retry') { step--; }
            continue;
        }

        ps.substCheck = 0;
        ps.checkFires = {};
        // Role mode gets a tighter, explicit cap that emits BLOCKED rather than a silent synthesis.
        if (!forWorker && _s.workflowMode && _s.role) {
            const _roleCap = Math.min(_ROLE_STEP_CAP, getAgentMaxSteps());
            if (_stepCount + 1 >= _roleCap)
                return await _gracefulSynthesis(`role step cap (${_roleCap} steps) reached`, textContent);
        }
        if (++_stepCount >= getAgentMaxSteps()) return await _gracefulSynthesis('step budget exhausted', textContent);

        // Intercept <handover> emitted as a function call name
        const _hoFC = calls.find(tc => /^<handover[\s>]/i.test(tc.function?.name || '') || tc.function?.name === 'handover');
        if (_hoFC) {
            const _raw = _hoFC.function.name;
            return _raw.includes('</handover>') ? _raw : `${_raw}\n</handover>`;
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
        const _exec = await _runToolCalls(_normCalls, toolTasks, {
            forWorker,
            repeatCache: _repeatCache,
            onTaskDone: () => { _taskDoneCalledThisStep = true; },
            onRepeat: (name) => _repeatedNames.push(name),
            replFails: _s._replaceFailures,
            replNudge: _s._replaceNudgeSent,
        });
        const _execOk = _exec.filter(r => !r.result?.error).length;
        consecutiveToolFails = _execOk > 0 ? 0 : consecutiveToolFails + _exec.length;
        if (consecutiveToolFails >= _MAX_CONSEC_TOOL_FAILS) return await _gracefulSynthesis(`${_MAX_CONSEC_TOOL_FAILS} consecutive tool failures with no progress`, textContent);
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
        const results = _exec.map((r, i) => ({ tc: calls[i], name: r.name, args: r.args, result: r.result }));

        const oaiDiffs = _buildWriteDiffs(
            results.map(({ tc, name, args, result }) => ({ name, args, result, key: tc.id })),
            oaiOldContents
        );
        // for native sessions apply write-arg diff via surface replace so the LLM
        // (reading from deriveMessages()) sees the patched tool_call arguments.
        if (oaiDiffs.size) {
            if (_histLegacy) {
                // fn-tag / no-session: mutate _s.history directly.
                _patchOAIWriteArgs(_s.history[_s.history.length - 1], oaiDiffs);
            } else {
                // Native session: apply patch to a mutable copy, then surface-replace.
                const _pwaSess = _getEvtSession(_s);
                if (_pwaSess) {
                    const _pwaSeq = _pwaSess.surface[_pwaSess.surface.length - 1];
                    if (_pwaSeq !== undefined && _pwaSess.events[_pwaSeq]?.type === 'assistant/message') {
                        const _pwaD = _pwaSess.events[_pwaSeq].data;
                        const _pwaMsg = { ..._pwaD.message };
                        if (_pwaMsg.tool_calls?.length) {
                            _pwaMsg.tool_calls = _pwaMsg.tool_calls.map((tc: any) => {
                                const d = oaiDiffs.get(tc.id); if (!d) return tc;
                                try {
                                    const a = JSON.parse(tc.function.arguments);
                                    a.content = d; a._contentCompressed = true;
                                    return { ...tc, function: { ...tc.function, arguments: JSON.stringify(a) } };
                                } catch { return tc; }
                            });
                        }
                        try {
                            (_pwaSess.append as _AppendSurface)('assistant/message',
                                { turn: _pwaD.turn ?? 0, step: _pwaD.step ?? step, message: _pwaMsg },
                                { surfaceOp: { op: 'replace', start: _pwaSeq, end: _pwaSeq } });
                        } catch (_e) { console.warn('[session-event] patchWriteArgs surface replace failed:', _e); }
                    }
                }
            }
        }

        const replaceFailNudge = forWorker ? null : await _getReplaceFailNudge(_s._replaceFailures, _s._replaceNudgeSent);

        const resSig = JSON.stringify(results.map(r => ({ n: r.name, res: r.result })), _fpTrunc);
        const stalledPaths = new Set(calls.map(tc => parseArgs(tc.function.arguments)?.path).filter(Boolean).map(_normPath)) as Set<string>;
        let stuckNudge;
        ({ resultHashes, stuckMsg: stuckNudge } = _updateStuckDetector(resSig, stalledPaths, resultHashes));
        let envFailNudge: string | null;
        ({ envFailSig: _envFailSig, envFailCount: _envFailCount, envFailTotal: _envFailTotal, envFailMsg: envFailNudge } = _updateEnvFailureDetector(results, _envFailSig, _envFailCount, _envFailTotal));

        const _stepBudgetChars = parseInt(ls(KEYS.AGENT_STEP_BUDGET, String(parseInt(ls(KEYS.AGENT_MAX_TOOL_RESULT, '20000'), 10))), 10);
        const stepBudget = { remaining: _stepBudgetChars };

        const _errPrefix = (r: any): string => {
            if (r?.error) return `[TOOL ERROR: ${String(r.error).slice(0, 200)}]\n`;
            if (r?.exit_code != null && r.exit_code !== 0) return `[EXIT CODE ${r.exit_code}]\n`;
            return '';
        };
        // Dual-write: tool/result.  Cannot use _dualWriteUser — this variant has different
        // history shapes for fn-tag (all results merged into one user message) vs native
        // (individual role:'tool' entries), and the event log always gets one event per call.
        if (_histLegacy) {
            if (_isFnTag) {
                const parts = results.map(({ tc, name, result }) => {
                    const _pfx = _errPrefix(result);
                    return `<tool_response>\n<tool_name>${name}</tool_name>\n<result>\n${_pfx}${JSON.stringify(_historyResult(name, result, forWorker, stepBudget))}\n</result>\n</tool_response>`;
                });
                if (parts.length) _s.history.push({ role: 'user', content: parts.join('\n\n') });
            } else {
                for (const { tc, name, result } of results) {
                    const _pfx = _errPrefix(result);
                    _s.history.push({ role: 'tool', tool_call_id: tc.id, name, content: _pfx + JSON.stringify(_historyResult(name, result, forWorker, stepBudget)) });
                }
            }
        }
        // Append one tool/result event per tool call to the event log (sole write for native sessions;
        // always individual regardless of fn-tag vs. native — the event log captures semantic truth).
        for (const { tc, name, result } of results) {
            const _pfx = _errPrefix(result);
            const _histContent = _pfx + JSON.stringify(_historyResult(name, result, forWorker, stepBudget));
            _evtAppend(_s, 'tool/result', {
                turn: _s._evtTurn ?? 0,
                step,
                callId:  tc.id,
                name,
                content: _histContent,
                ...(result?.error || (result?.exit_code != null && result.exit_code !== 0) ? { isError: true } : {}),
            }, { surfaceOp: 'append' });
        }

        if (!forWorker) {
            const _reactive = !(ps._postCompactionTurns ?? 0) && reactiveSkillGuidance(results.map(r => ({ name: r.name, result: r.result })));
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
            // Track successful execute_code — feeds step_validation advisory mode.
            // A prior successful exec means the model can already use tools; further
            // step_validation fires should warn rather than block (T3.3/T3.7).
            if (results.some(r => r.name === 'execute_code' && !r.result?.error && (r.result?.exit_code ?? 0) === 0))
                _execsThisRun = true;
        }

        // ── Post-results nudge zone ─────────────────────────────────────────
        // Phase contract: this is the ONLY place user-role guidance may be appended
        // after tool execution — tool results are already in history above, so the
        // assistant tool_calls → role:'tool' pairing is intact.
        if (_callsOverflowNudge)               _emitNudge('calls_overflow', _nudge(_callsOverflowNudge));
        if (stallNudge)                       _emitNudge('stall_detected', _nudge(stallNudge));
        // stuck_detected: 3 consecutive identical full-result signatures — the model is in a
        // genuine loop with no new information. Nudge and force a tool call; the model may still
        // find a way forward (e.g. switching from read_file to execute_code for file access).
        // Do NOT _gracefulSynthesis here: for SWE tasks !_editsThisRun is true throughout the
        // entire exploration phase, so early termination kills tasks that would have recovered.
        if (stuckNudge)                     { _emitNudge('stuck_detected', _nudge(stuckNudge)); _forceToolCall = true; }
        else if (envFailNudge)                _emitNudge('env_failure', _nudge(envFailNudge));
        else if (consecutiveToolFails >= 5)   _emitNudge('tool_failures', _nudge('Multiple consecutive tool calls are failing. Diagnose the root cause before retrying, or end with BLOCKED: if you cannot proceed.'));
        else if (replaceFailNudge)            _emitNudge('replace_fail', _nudge(replaceFailNudge));
        if (!stuckNudge && !forWorker) {
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
        if (!_emptyFsNudged && !forWorker) {
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
                        _dualWriteUser(_s, _lsContent, _histLegacy);
                        break;
                    }
                }
            }
        }

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
    // partner-tier quota allocation. opencode sends the same pair.
    if (provider === 'openrouter') {
        headers['HTTP-Referer'] = 'https://freegent.app/';
        headers['X-Title'] = 'FreeGent';
    }

    const _effectiveProxy = ep.proxy ? getLocalApiProxy() : '';

    // Two-phase abort: connection-establishment timeout clears once headers arrive so it
    // cannot fire during the stream body read. AbortSignal.timeout() as a static timer
    // would kill active SSE streams mid-response (e.g. thinking models streaming past 90s).
    const _connCtrl  = new AbortController();
    const _connTimer = setTimeout(
        () => _connCtrl.abort(new DOMException('signal timed out', 'TimeoutError')),
        isCustom ? FETCH_TIMEOUT_CUSTOM_MS : FETCH_TIMEOUT_MS,
    );
    const _userSig = activeAbortController?.signal;
    const _connSig = _userSig && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([_userSig, _connCtrl.signal])
        : (_userSig ?? _connCtrl.signal);

    let resp: Response;
    try {
        resp = _effectiveProxy
            ? await fetch(_effectiveProxy, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: _connSig,
                body: JSON.stringify({ url, method: 'POST', headers, body: JSON.stringify(payload) }),
            })
            : await fetch(url, { method: 'POST', headers, signal: _connSig, body: JSON.stringify(payload) });
    } finally {
        clearTimeout(_connTimer); // release timer — cannot abort the body reader after headers received
    }
    if (!resp.ok) throw await _httpErrorFromResponse(resp, `[${provider}|${model}]`);
    return decodeOAIResponse(resp, onChunk);
}

async function callOAI(onChunk: (chunk: string, ...rest: any[]) => void, onRequest: (r: any) => void, { localHistory = null as any[] | null, forWorker = false, endpointOverride = null as any, roleOverride = null as any, toolFilterOverride = null as Set<string> | null, maxTokens = null as number | null, inputTokensHint = 0, evtSession = null as AgentSession | null, evtStep = 0 } = {}): Promise<any> {
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
    const sysPrompt = (forWorker ? _bwsp(roleOverride) : _bsp()) + _fnTagNote;
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
    // when an event-log session is active and we're NOT in fn-tag format,
    // derive the LLM history from deriveMessages() instead of the mutable _s.history array.
    // fn-tag is excluded because it merges N tool results into one user message in _s.history —
    // deriveMessages() produces native 1:1 format which would change the message structure.
    // Workers are excluded: their localOH is the authoritative history (it includes the task
    // message which is never added to the worker's event session). On step 0 deriveMessages()
    // returns [] (only turn/start is logged) and the task would be silently lost.
    const _evtSessOAI = (evtSession && !forWorker && toolFormat !== 'fn-tag') ? _getEvtSession(evtSession) : null;
    const _effectiveHist: any[] = _evtSessOAI ? _evtSessOAI.deriveMessages() : (localHistory ?? openaiHistory);
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
        effectiveMaxTokens = Math.max(256, Math.min(effectiveMaxTokens, available, pctCap));
    }
    // Sanitize history before sending:
    // 1. Drop bare assistant messages (content:null, no tool_calls) — these arise when
    //    _stripThinking empties a response; strict providers (Mistral, Devstral) reject them
    //    with HTTP 400 "Invalid assistant message: content=None tool_calls=None".
    // 2. Normalize mid-conversation role:'system' messages (NVIDIA nudges) to role:'user' —
    //    Mistral/Devstral reject system after position 0.
    const _sanitizeToolName = n => (n || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const _rawHist = _effectiveHist
        .filter(m => !(m.role === 'assistant' && m.content == null && !m.tool_calls?.length))
        .map(m => {
            if (m.role === 'assistant' && m.tool_calls?.some(tc => tc.function?.name?.match(/[^a-zA-Z0-9_-]/)))
                return { ...m, tool_calls: m.tool_calls.map(tc => tc.function?.name?.match(/[^a-zA-Z0-9_-]/)
                    ? { ...tc, function: { ...tc.function, name: _sanitizeToolName(tc.function.name) } } : tc) };
            if (m.role === 'tool' && m.name?.match(/[^a-zA-Z0-9_-]/))
                return { ...m, name: _sanitizeToolName(m.name) };
            return m;
        });
    let _hist = provider !== 'nvidia'
        ? _rawHist.map(m => m.role === 'system' ? { role: 'user', content: `<nudge>${m.content ?? ''}</nudge>` } : m)
        : _rawHist;
    // Guard: vLLM (Qwen3 Jinja2 template) raises "No user query found in messages." when
    // the messages array contains no user-role entry. This should never happen — the
    // invariant is that the first event appended to a session is the task's user message.
    // If it is violated (e.g. by surface corruption), fall back to the _s.history anchor
    // so the request remains valid and a warning is logged for diagnosis.
    if (isCustom && !_hist.some((m: any) => m.role === 'user')) {
        console.warn('[callOAI] invariant: no user message in effective history —',
            'surface.length=', _evtSessOAI?.surface?.length ?? -1,
            'hist.length=', _hist.length,
            'last surface seqs=', JSON.stringify(_evtSessOAI?.surface?.slice(-5) ?? []));
        const _anchor = (localHistory ?? openaiHistory ?? []).find((m: any) => m.role === 'user');
        if (_anchor) _hist = [_anchor, ..._hist];
    }
    // All provider quirks (thinking kwargs, cache keys, tool_choice suppression, top_p)
    // live in buildChatPayload — do not add per-provider fields here.
    const _ftc = _forceToolCall; _forceToolCall = false; // consume and reset before the call
    const payload = buildChatPayload(ep, {
        messages: [{ role: 'system', content: sysPrompt }, ..._hist],
        tools: hasTools ? buildOAITools(forWorker, toolFilterOverride) : null,
        temperature: getTemperature(),
        maxTokens: effectiveMaxTokens,
        stream: true,
        thinkingBudget: thinkBudget || customThinkBudget || googleThinkBudget,
        preserveThinking: getPreserveThinking(),
        sampling: isCustom ? getSamplingParams() : null,
        forceToolCall: _ftc,
    });
    // Wrap onChunk to timestamp each received token — used by the suspension recovery
    // discriminator in init.ts (_lastStreamChunkAt <= _hiddenAtMs → stream died = suspend).
    const _timestampedOnChunk = (chunk: string, ...rest: any[]) => {
        _lastStreamChunkAt = Date.now();
        window._lastStreamChunkAt = _lastStreamChunkAt;
        onChunk(chunk, ...rest);
    };
    const result = await callLLM(ep, payload, _timestampedOnChunk, { onRequest });
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
Object.assign(window, { runTurn, callLLM, callOAI, _runToolCalls, _validateStepOutput, _saveAnswer, _patchOAIWriteArgs, _stripThinking, clearSessionFallback, clearReplaceState, applyKeywordToolFilter });

// §7: named ES module exports alongside window bridge (harness adapter / headless import paths).
// Note: clearSessionFallback and clearReplaceState are already exported via export function above.
// getAgentMaxSteps is re-exported here so headless callers can import it from a single loop module
// without also importing all of config.js.
export { runTurn, callOAI };
export { getAgentMaxSteps } from './config.js';
