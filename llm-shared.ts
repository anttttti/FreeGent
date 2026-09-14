import { openaiHistory, setOpenaiHistory, workflowMode, activeChatId, activeAbortController, setPendingAgentsContextInject, type AgentSession, defaultSession, _reactiveFired, setReactiveFired } from './state.js';
import { type RenderAdapter } from './render-adapter.js';
import { withRetry, _isTimeoutError, parseContextOverflow, fmtDelay } from './retry.js';
import { getCooldownRemaining, specToEndpoint, oaiEndpoint, _isCoolingDown, modelFriendlyName,
         firstFreeEndpoint, _defaultEndpoint, _markCooldown, _markFlatCooldown, _isRateLimit, _isServerError } from './model-router.js';
import { buildSystemPrompt } from './system-prompt.js';
import { buildChatPayload, isCustomEndpoint } from './payload-builder.js';
import { estimateTokens, getOAIContextTokens, getSamplingParams, getActiveMainModelList, getLocalApiProxy, getAgentProactiveCompact, getAgentCompactAt, getAgentCompactTokens } from './config.js';
import { sessionCompactHistory } from './session-store.js';
// llm-shared.js — FreeGent: streaming helpers, retry, context compaction, history conversion
// Depends on: config.js, tools.js, state.js (openaiHistory).
// All top-level consts/lets are module-private; public API exposed via window bridge below.


// How many recent messages to keep verbatim after a compaction (appended after the summary stub).
// Keeping the tail preserves exact values — paths, error strings, line numbers — that prose loses.
const COMPACT_TAIL = 6;
// Max tokens kept verbatim in the tail after compaction. Prevents large tool results from making
// compaction ineffective (tail alone == pre-compaction size → 5-min LLM call with no reduction).
// COMPACT_TAIL_TOKEN_BUDGET is the upper cap (sized for ≥128K context: 16k summary + 48k tail ≈ 64k).
// For smaller context windows the actual budget is computed dynamically by _tailTokenBudget().
const COMPACT_SUMMARY_TOKENS    = 16000;
const COMPACT_TAIL_TOKEN_BUDGET = 48000;

// Scale summary budget for small-context models: COMPACT_SUMMARY_TOKENS (16K) is
// sized for ≥128K windows. Cap at 25% of context so the tail has room to fit.
function _effectiveSummaryTokens(): number {
    return Math.min(COMPACT_SUMMARY_TOKENS, Math.floor(getOAIContextTokens() * 0.25));
}

// Compute the effective tail-token budget for the current context window.
// When proactive compaction is enabled, post-compaction context must stay below the
// compaction threshold — otherwise compaction never reduces the window and spirals.
// Uses the threshold (not ctxWindow) as the ceiling; 5K overhead covers the anchor,
// system prompt, and safety margin. For hard-limit compaction the original formula applies.
function _tailTokenBudget(): number {
    const ctxWindow     = getOAIContextTokens();
    const summaryBudget = _effectiveSummaryTokens();
    if (getAgentProactiveCompact()) {
        const compactAt = getAgentCompactAt();
        const tokens    = getAgentCompactTokens();
        const threshold = tokens > 0 ? Math.min(ctxWindow * compactAt, tokens) : ctxWindow * compactAt;
        return Math.min(COMPACT_TAIL_TOKEN_BUDGET, Math.max(2000, threshold - summaryBudget - 5000));
    }
    return Math.min(COMPACT_TAIL_TOKEN_BUDGET, Math.max(2000, ctxWindow - summaryBudget - 3000));
}

// Store the last compaction summary for ACON-style failure logging
let _lastCompactSummary: string = '';

function compactPrompt(maxTokens) {
    return `Produce the following outputs for a context compaction. Use 2000–${maxTokens} tokens total across all sections. A brief summary is NOT sufficient — include all key findings and a complete forward plan.
This is a summarization request, NOT a task to continue: do not call tools, do not output tool-call tags or JSON tool calls — plain text only.

TASK_COMPLETE:
[If the agent has explicitly declared COMPLETED in the conversation history and provided a final answer, copy that final answer verbatim here. If the task is still in progress, write: no]

SUMMARY:
[One compact paragraph: what was requested, what was done, current workspace file state, key findings.]

FINDINGS:
[What you have discovered about the codebase and the problem:
• Root cause: exactly why the current behaviour is wrong (be specific — function name, line, mechanism)
• Relevant files: exact paths and which functions/lines matter
• What the fix must do — as specific as possible
• Files already fully read (do NOT re-read these after compaction — use start_line/end_line for specific sections)]

NEXT_STEPS:
[Your plan from this point forward — include everything you intended to do, whether concrete tool calls or investigative steps still needed:
1. [next action — specific enough to execute without re-reading: name the file, function, and change]
2. [following step]
...
If you had not yet formed a plan, state what is still unknown and what you would read next to resolve it.
Each step must be specific enough that the next session can act on it without re-reading source files.]

KEY_FACTS:
[Exact values that must survive the compaction — things that will cause the next task to fail if lost:
• Files created or modified: exact path + one-line description of what changed
• Errors, constraints, or warnings discovered (exact messages where relevant)
• Exact strings, paths, values, or line numbers still needed
Omit anything already stated in SUMMARY or FINDINGS above.]

MEMORY_UPDATE:
\`\`\`json
[JSON object with memory file updates — only files that changed, each under 300 words. Keys must start with "memory/":
• memory/project.md — project structure, codebase layout, conventions, decisions
• memory/preferences.md — user preferences and working style
• memory/procedures.md — reusable patterns and solutions learned
• memory/log.md — verbatim facts, findings, or warnings worth preserving (append new entries; keep existing ones; trim oldest to keep total under 4000 chars)
• memory/index.md — one-line summary per page (update whenever other pages change)
If nothing is worth persisting, output: {}]
\`\`\``;
}

export function parseCompactResponse(text) {
    const taskCompleteMatch = text.match(/TASK_COMPLETE:\s*\n([\s\S]*?)(?=\nSUMMARY:|\nFINDINGS:|\nNEXT_STEPS:|\nKEY_FACTS:|\nMEMORY_UPDATE:|$)/i);
    const taskCompleteRaw   = (taskCompleteMatch?.[1] ?? '').trim();
    const taskComplete      = taskCompleteRaw && !/^no$/i.test(taskCompleteRaw) ? taskCompleteRaw : null;
    const summaryMatch    = text.match(/SUMMARY:\s*\n([\s\S]*?)(?=\nFINDINGS:|\nNEXT_STEPS:|\nKEY_FACTS:|\nMEMORY_UPDATE:|$)/i);
    const findingsMatch   = text.match(/FINDINGS:\s*\n([\s\S]*?)(?=\nNEXT_STEPS:|\nKEY_FACTS:|\nMEMORY_UPDATE:|$)/i);
    const nextStepsMatch  = text.match(/NEXT_STEPS:\s*\n([\s\S]*?)(?=\nKEY_FACTS:|\nMEMORY_UPDATE:|$)/i);
    const keyFactsMatch   = text.match(/KEY_FACTS:\s*\n([\s\S]*?)(?=\nMEMORY_UPDATE:|$)/i);
    const summary    = (summaryMatch   ? summaryMatch[1]   : text).trim();
    const findings   = (findingsMatch  ? findingsMatch[1]  : '').trim();
    const nextSteps  = (nextStepsMatch ? nextStepsMatch[1] : '').trim();
    const keyFacts   = (keyFactsMatch  ? keyFactsMatch[1]  : '').trim();
    let memoryUpdates: Record<string, any> = {};
    const jsonBlock = text.match(/```json\s*([\s\S]*?)```/i);
    if (jsonBlock) { try { memoryUpdates = JSON.parse(jsonBlock[1].trim()); } catch {} }
    return { summary, findings, nextSteps, keyFacts, memoryUpdates, taskComplete };
}

// A usable summary is prose. The summarizer runs under the full agent system prompt
// (which teaches the tool-call format), so a confused model sometimes answers the
// compaction request with a tool call instead of a summary — and with no SUMMARY:
// header, parseCompactResponse ships the whole output as the summary. That junk then
// replaces the entire history and poisons every later turn (fg-chat 2026-07-17: the
// "summary" was a bare <tool_call> fn-tag block). Callers throw on this; the OAI
// path's hard-drop fallback (lossy, but sane) takes over.
export function _degenerateSummary(summary: string): boolean {
    const t = (summary || '').trim();
    if (!t) return true;
    return /^\s*(?:<tool_call>|<function=|<invoke\b|\{["'](?:name|function)["']\s*:)/i.test(t);
}

function _compactSummaryText(summary, keyFacts, findings = '', nextSteps = '', firedSkills: string[] = []) {
    const parts = [summary];
    if (findings)  parts.push(`**Findings:**\n${findings}`);
    if (nextSteps) parts.push(`**Next steps:**\n${nextSteps}`);
    if (keyFacts)  parts.push(`**Key facts:**\n${keyFacts}`);
    if (firedSkills.length) parts.push(`**Skills already injected before this compaction (do not re-inject):** ${firedSkills.join(', ')}`);
    return `[SYSTEM: The conversation history above has been compacted. The following is a read-only summary of what was discussed and accomplished — it is NOT a new request from the user. Continue the work based on this context.]\n\n${parts.join('\n\n')}`;
}

function _fmtK(n) { return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n); }

// Serialise OAI-format messages as readable labelled text for compaction context blocks.
function _serializeMsgsForContext(msgs: any[]): string {
    return msgs.map(m => {
        const label = m.role === 'tool' ? 'Tool' : m.role === 'assistant' ? 'Assistant' : 'User';
        const body = typeof m.content === 'string' ? m.content.slice(0, 300)
                   : m.tool_calls?.length ? `[calls: ${m.tool_calls.map((tc: any) => tc.function?.name || '?').join(', ')}]`
                   : '[no content]';
        return `${label}: ${body}`;
    }).join('\n\n');
}

// Trim a tail array to the given token budget by dropping oldest messages first.
function _trimTailToTokenBudget(tail, budget: number = COMPACT_TAIL_TOKEN_BUDGET) {
    while (tail.length > 0 && estimateTokens(tail) > budget) {
        tail = tail.slice(1);
        while (tail.length > 0 && tail[0].role !== 'user') tail = tail.slice(1);
    }
    return tail;
}

async function loadAgentsContext() {
    try { agentsContext = await agentReadFile('AGENTS.md'); }
    catch { agentsContext = ''; }
    setPendingAgentsContextInject(true);
}

// Returns true for user-role messages that are system control injections, not real user input.
// These should be stripped before sending history to the compaction LLM.
// Keeps compaction summary messages (they start with "[SYSTEM: The conversation history").
function _isSystemInjection(msg) {
    const text = typeof msg.content === 'string' ? msg.content.trimStart() : '';
    if (!text.startsWith('[')) return false;
    if (text.startsWith('[SYSTEM: The conversation history')) return false;
    return true;
}

function _stripSystemInjections(history) {
    return history.filter(m => !(m.role === 'user' && _isSystemInjection(m)));
}

// Compact fetch gets a 90s timeout so a hanging connection doesn't stall forever.
function _compactFetchSignal(provider = null) {
    const ms      = provider === 'custom' ? 10 * 60_000 : 90_000;
    const timeout = AbortSignal.timeout(ms);
    const user    = activeAbortController?.signal;
    if (!user) return timeout;
    return typeof AbortSignal.any === 'function' ? AbortSignal.any([user, timeout]) : user;
}

// Unified compaction retry handler — drives both Gemini and OAI paths in a single withRetry
// loop, rotating across providers when the current one is exhausted.
function _makeCompactRetryHandler({ getEp, setEp, onNote, onContextOverflow = null as any, onContextTruncate = null as any }) {
    return (n: number, e: any, d: number) => {
        // Context overflow (OAI "maximum context length" error)
        const headroom = parseContextOverflow(e);
        if (headroom !== null) {
            if (headroom > 0 && onContextOverflow) { onContextOverflow(headroom); return; }
            if (onContextTruncate) {
                const reduced = onContextTruncate();
                if (reduced) return 50;
            }
            return false;
        }
        const is429 = _isRateLimit(e.message);
        const isErr = !is429 && _isServerError(e.message);
        const ep = getEp();
        const key = `${ep.provider}|${ep.model}`;
        const isCustom = ep.provider === 'custom' || ep.provider === 'vllm';
        if (_isTimeoutError(e) && isCustom) {
            onNote(`[${key}][fetch timeout: server unresponsive, not retrying]`);
            return false;
        }
        if (is429 && !e.preFlight) _markCooldown(ep, e.retryAfterMs ?? null);
        else if (isErr) _markFlatCooldown(ep, null);
        if (is429 || isErr) {
            const list: string[] = typeof getActiveMainModelList === 'function' ? getActiveMainModelList() : [];
            const nextSpec = list.find((s: string) => s !== key && getCooldownRemaining(s) === 0);
            if (nextSpec) {
                setEp(specToEndpoint(nextSpec));
                onNote(`[${key}][${is429 ? 'rate limited' : 'server error'}: switching to ${nextSpec}]`);
                return 0;
            }
            if (is429 && e.retryAfterMs != null) return Math.max(e.retryAfterMs, 5_000);
            const remaining = getCooldownRemaining(key) * 1000;
            const isFetchFail = /failed to fetch|networkerror|load failed|econnreset|connection/i.test(e.message);
            const delay = remaining > 0 ? remaining : (isCustom && !isFetchFail ? 5_000 : Math.min(d, 60_000));
            onNote(`[${key}][retry ${n + 1}: ${e.message}, waiting ${fmtDelay(delay)}]`);
            return delay;
        }
        onNote(`[${key}][retry ${n + 1}: ${e.message}, waiting ${fmtDelay(e.retryAfterMs ?? d)}]`);
        if (e.retryAfterMs != null) return Math.max(e.retryAfterMs, 5_000);
    };
}

// Compact the session history with any configured model (Gemini or OAI-compatible).
// Picks the first non-cooling endpoint across all providers; rotates cross-provider on
// rate limits; builds payload as f(ep) per attempt inside withRetry.
export async function compactHistory(placeholder: RenderAdapter, activeEndpoint: any = null, session?: AgentSession, effectiveHistory?: any[]) {
    const task = placeholder.addCompactStep();
    const _s = session ?? defaultSession;
    // When a session-derived effectiveHistory is provided, use it for ALL reads
    // (token estimation, anchor, tail). Writes still rebuild _s.history so
    // _mirrorCompactionToSession in llm-loops can sync the session surface.
    const _hR = effectiveHistory ?? _s.history;
    const _PIN = '[TASK — do not lose track of this]\n';
    const _origFirst = _hR.find((m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.trim());
    const _firstMsgContent = _origFirst ? _origFirst.content.replace(/^\[TASK[^\]]*\]\n/, '') : null;
    try {
    const beforeTokens = estimateTokens(_hR);
    task.setPrompt(`~${_fmtK(beforeTokens)} tokens → Compacting…`);

    // Starting endpoint: prefer the caller's active endpoint if not cooling,
    // then first free across all providers, then whatever is configured.
    let ep: any = (activeEndpoint && !_isCoolingDown(activeEndpoint))
        ? activeEndpoint
        : (firstFreeEndpoint() ?? activeEndpoint ?? _defaultEndpoint());
    task.setModel(modelFriendlyName(`${ep.provider}|${ep.model}`));

    // Context tail: format-independent OAI messages preserved verbatim after the summary.
    // Needed both inside the loop (for [RECENT CONTEXT] block) and after it (rebuilt history).
    const _ctxTailRaw = (() => {
        let t = _hR.slice(-COMPACT_TAIL).filter((m: any) => m !== _origFirst);
        while (t.length > 0 && (t[0].role === 'assistant' || t[0].role === 'tool')) t = t.slice(1);
        return _trimTailToTokenBudget(t, _tailTokenBudget());
    })();

    // OAI-format history — built once, mutated by onContextTruncate between retries.
    // Also populated for the OAI path when the loop starts on Gemini and rotates mid-retry.
    const _sanitizeName = (n: string) => (n || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    let histMsgs: any[] = _stripSystemInjections(_hR.filter((m: any) => m !== _origFirst))
        .filter(m => !(m.role === 'assistant' && m.content == null && !m.tool_calls?.length))
        .map(m => m.role === 'system' ? { role: 'user', content: `<nudge>${m.content ?? ''}</nudge>` } : m)
        .map(m => {
            if (m.role === 'assistant' && m.tool_calls?.length)
                return { ...m, tool_calls: m.tool_calls.map((tc: any) => tc.function?.name?.includes(':')
                    ? { ...tc, function: { ...tc.function, name: _sanitizeName(tc.function.name) } }
                    : tc) };
            if (m.role === 'tool' && m.name?.includes(':'))
                return { ...m, name: _sanitizeName(m.name) };
            return m;
        });
    {
        let cut = histMsgs.length;
        while (cut > 0 && histMsgs[cut - 1].role === 'tool') cut--;
        if (cut < histMsgs.length) {
            if (cut > 0 && histMsgs[cut - 1].role === 'assistant' && histMsgs[cut - 1].tool_calls?.length) cut--;
            histMsgs = histMsgs.slice(0, cut);
        }
    }
    histMsgs = histMsgs.slice(0, Math.max(0, histMsgs.length - _ctxTailRaw.length));

    // OAI output-budget: mutable, reseeded per-attempt when ep changes; only ever shrunk
    // further by onContextOverflow/onContextTruncate.
    let compactMaxTokens = _effectiveSummaryTokens();
    let _isSmallCtx = false;
    let _epKeyForBudget = '';

    // Also treat 4xx "model/endpoint not found" as retryable on custom endpoints.
    const _compactIsTransient = (e: any) => ep.provider === 'custom' ||
        /HTTP 4\d\d.*(?:not found|no endpoint|no model|invalid model|model.*not.*exist|does not exist)/i.test(e.message);

    const data = await withRetry(async () => {
        const _ctxBlock = _ctxTailRaw.length > 0
            ? `[RECENT CONTEXT — these ${_ctxTailRaw.length} turns are already preserved verbatim after your summary, do not repeat them]\n\n${_serializeMsgsForContext(_ctxTailRaw)}\n\n---\n\n`
            : '';

        // OAI-compatible path (all providers, including Google via OAI-compat endpoint).
        // Recompute budget when ep changes, then build payload.
        const _epKey = `${ep.provider}|${ep.model}`;
        if (_epKey !== _epKeyForBudget) {
            _epKeyForBudget = _epKey;
            // isCustomEndpoint covers both 'custom' and 'vllm' providers. vllm endpoints can
            // have any context size; the accurate available-token computation must run for them.
            _isSmallCtx = isCustomEndpoint(ep) || Boolean(ep.url && getOAIContextTokens() < 50000);
            if (_isSmallCtx) {
                const sysPrompt = buildSystemPrompt();
                const promptMsgs = [{ role: 'system', content: sysPrompt }, ...histMsgs, { role: 'user', content: '-' }];
                const ctxWindow = getOAIContextTokens();
                const estInput = Math.ceil(estimateTokens(promptMsgs) * 1.1);
                const available = ctxWindow - estInput - 512;
                compactMaxTokens = Math.max(1024, Math.min(COMPACT_SUMMARY_TOKENS, available));
            } else {
                compactMaxTokens = _effectiveSummaryTokens();
            }
        }
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (ep.key) headers['Authorization'] = `Bearer ${ep.key}`;
        // thinkingBudget 0: compaction must never think — the summary must land in the
        // content field (Qwen3/thinking models put it in reasoning otherwise).
        const body = JSON.stringify(buildChatPayload(ep, {
            messages: [
                { role: 'system', content: buildSystemPrompt() },
                ...(_firstMsgContent ? [{ role: 'user', content: `[FIRST USER TURN — already preserved verbatim]\n\n${_firstMsgContent}` }] : []),
                ...histMsgs,
                { role: 'user', content: _ctxBlock + compactPrompt(compactMaxTokens) },
            ],
            temperature: 0.1,
            maxTokens: compactMaxTokens,
            stream: false,
            thinkingBudget: 0,
            sampling: _isSmallCtx ? (typeof getSamplingParams === 'function' ? (() => { const s = getSamplingParams(); delete s.temperature; return s; })() : {}) : null,
        }));
        const proxyUrl = ep.proxy ? getLocalApiProxy() : '';
        const resp = proxyUrl
            ? await fetch(proxyUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: _compactFetchSignal(ep.provider), body: JSON.stringify({ url: ep.url, method: 'POST', headers, body }) })
            : await fetch(ep.url!, { method: 'POST', headers, signal: _compactFetchSignal(ep.provider), body });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            let msg = `Compaction HTTP ${resp.status}`;
            try {
                const j = JSON.parse(text);
                const detail = j.message || j.detail || j.error?.message || '';
                if (detail) msg += ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300);
            } catch { if (text) msg += ': ' + text.slice(0, 200); }
            throw new Error(msg);
        }
        return resp.json();
    }, _makeCompactRetryHandler({
        getEp: () => ep,
        setEp: (e: any) => { ep = e; task.setModel(modelFriendlyName(`${e.provider}|${e.model}`)); task.setPrompt(`Compacting… [→ ${e.provider}|${e.model}]`); },
        onNote: (msg: string) => task.setPrompt(`Compacting… ${msg}`),
        onContextOverflow: (max: number) => {
            compactMaxTokens = Math.max(max, 1024);
            task.setPrompt(`Compacting… [context overflow: reducing summary tokens to ${compactMaxTokens}]`);
        },
        // Prompt too large: drop oldest third of histMsgs and retry immediately.
        // Returns true if something was removed, false when empty (bail to hard-drop).
        onContextTruncate: () => {
            if (histMsgs.length === 0) return false;
            const drop = Math.max(1, Math.floor(histMsgs.length / 3));
            histMsgs = histMsgs.slice(drop);
            if (_isSmallCtx) {
                const sysPrompt = buildSystemPrompt();
                const promptMsgs = [{ role: 'system', content: sysPrompt }, ...histMsgs, { role: 'user', content: '-' }];
                const ctxWindow = getOAIContextTokens();
                const estInput = Math.ceil(estimateTokens(promptMsgs) * 1.1);
                const available = ctxWindow - estInput - 512;
                compactMaxTokens = Math.max(1024, Math.min(COMPACT_SUMMARY_TOKENS, available));
            } else {
                compactMaxTokens = _effectiveSummaryTokens();
            }
            task.setPrompt(`Compacting… [input overflow: dropped ${drop} oldest messages, ${histMsgs.length} remain]`);
            return true;
        },
    }), 100, _compactIsTransient);

    const raw = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || '';
    if (!raw) throw new Error('Compaction produced no summary');
    const { summary, findings, nextSteps, keyFacts, memoryUpdates, taskComplete } = parseCompactResponse(raw);
    // If the compaction model determined the task is already complete, return the answer
    // directly so the caller can short-circuit instead of rebuilding history and continuing.
    if (taskComplete) {
        task.setPrompt(`Task complete — answer recovered from compaction`);
        task.complete();
        return { taskComplete };
    }
    if (_degenerateSummary(summary)) throw new Error('Compaction produced no usable summary (tool-call or empty output)');
    _lastCompactSummary = summary.slice(0, 200);
    const _firedBeforeCompact = [..._reactiveFired];
    const tail = _ctxTailRaw;
    const _preCompactHistory = [..._s.history];
    _s.history.length = 0;
    const _anchor = _origFirst
        ? (workflowMode
            ? _firstMsgContent
            : (_origFirst.content.startsWith(_PIN) ? _origFirst.content : _PIN + _origFirst.content))
        : null;
    if (_anchor) _s.history.push({ role: 'user', content: _anchor });
    _s.history.push({ role: 'user', content: _compactSummaryText(summary, keyFacts, findings, nextSteps, _firedBeforeCompact) });
    if (tail.length > 0) {
        // Only include the synthetic "Understood" turn when there's a tail to follow it,
        // otherwise history would end with an assistant message → 400 from Mistral/OpenAI.
        _s.history.push({ role: 'assistant', content: 'Understood, continuing from the summary.' });
        _s.history.push(...tail);
    }
    // Final safety: history must not end with an assistant message.
    if (_s.history[_s.history.length - 1]?.role === 'assistant') {
        _s.history.push({ role: 'user', content: '[SYSTEM: Continue where you left off.]' });
    }
    setReactiveFired(new Set(_firedBeforeCompact));
    sessionCompactHistory?.(activeChatId, _preCompactHistory, _s.history);
    const afterTokens = estimateTokens(_s.history);
    task.setPrompt(`~${_fmtK(beforeTokens)} → ~${_fmtK(afterTokens)} tokens`);
    task.setOutput(keyFacts ? `${summary}\n\n${keyFacts}` : summary); task.complete();
    } catch (e) {
        // Hard-drop fallback: if compaction fails completely, drop the oldest half of history
        // so the agent is never permanently stuck waiting for a summary.
        if ((_hR.length > 4) || (_s.history.length > 4)) {
            const _preDropHistory = [..._s.history];
            const drop = Math.floor(_s.history.length / 2);
            _s.history.splice(0, drop);
            while (_s.history.length > 0 && _s.history[0].role !== 'user') _s.history.shift();
            const _hdAnchor = _origFirst
                ? (workflowMode
                    ? _firstMsgContent
                    : (_origFirst.content.startsWith(_PIN) ? _origFirst.content : _PIN + _origFirst.content))
                : null;
            if (_hdAnchor && _s.history[0]?.content !== _hdAnchor) _s.history.unshift({ role: 'user', content: _hdAnchor });
            sessionCompactHistory?.(activeChatId, _preDropHistory, _s.history);
            task.setPrompt(`Compaction failed — hard-dropped ${drop} oldest turns`);
            task.complete();
            return;
        }
        task.abort(); throw e;
    }
}


// Window bridge for classic scripts.
// _lastCompactSummary is mutable module state read cross-file (ACON failure logging) — live accessor.
Object.defineProperty(window, '_lastCompactSummary', { get: () => _lastCompactSummary, configurable: true });
Object.assign(window, {
    parseContextOverflow,
    compactHistory, parseCompactResponse,
    loadAgentsContext,
});
