import { openaiHistory, setOpenaiHistory, workflowMode, activeChatId, activeAbortController, setPendingAgentsContextInject, type AgentSession, defaultSession, _reactiveFired, setReactiveFired } from './state.js';
import { type RenderAdapter } from './render-adapter.js';
import { withRetry, _isTimeoutError, parseContextOverflow, fmtDelay } from './retry.js';
import { getCooldownRemaining, specToEndpoint, oaiEndpoint, _isCoolingDown, modelFriendlyName,
         firstFreeEndpoint, _defaultEndpoint, _markCooldown, _markFlatCooldown, _isRateLimit, _isServerError } from './model-router.js';
import { buildSystemPrompt } from './system-prompt.js';
import { buildChatPayload, buildRequestMessages, isCustomEndpoint } from './payload-builder.js';
import { buildOAITools } from './tool-schemas.js';
import { estimateTokens, getOAIContextTokens, getSamplingParams, getActiveMainModelList, getLocalApiProxy, getAgentProactiveCompact, getAgentCompactAt, getAgentCompactTokens } from './config.js';
import { sessionCompactHistory } from './session-store.js';
// llm-shared.js — FreeGent: streaming helpers, retry, context compaction, history conversion
// Depends on: config.js, tools.js, state.js (openaiHistory).
// All top-level consts/lets are module-private; public API exposed via window bridge below.


// How many recent messages to keep verbatim after a compaction (appended after the summary stub).
// Keeping the tail preserves exact values — paths, error strings, line numbers — that prose loses.
const COMPACT_TAIL = 6;
// Output cap for the summary. v0.54 summaries were 467–823 tokens; the old 16K cap made the
// request overflow a 60K window at the compaction threshold (prompt ~45K + 16K) and every
// compaction started with a string of rejected attempts.
const COMPACT_SUMMARY_TOKENS    = 2000;
// Upper cap on tokens kept verbatim in the tail (for ≥128K contexts); smaller windows get the
// dynamic budget from _tailTokenBudget().
const COMPACT_TAIL_TOKEN_BUDGET = 48000;

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

// Task-agnostic: the same sections fit coding, data, API-workflow and CTF tasks.
const COMPACT_PROMPT = `Summarize this agent session so work can continue after older messages are removed.
This is a summarization request — reply in plain text only; do not call tools.
Be concrete: copy exact identifiers, paths, IDs, commands, code and error strings.
The most recent messages are kept verbatim after your summary; you need not restate their exact output.
Target 300–1500 tokens. Omit empty sections.

GOAL: the task in one or two sentences, including any required output format.
DONE: what has been completed, each item with its evidence (the tool result that showed it worked).
STATE: what is true right now in the environment — files changed and whether those edits are currently applied, records created/updated (with IDs), services started, answers already computed.
FAILED: approaches tried that did not work, and why (exact error text). Do not retry these unchanged.
OPEN: unknowns still blocking completion.
NEXT: the next 1–3 concrete actions (tool + target), in order. Include exact code, commands or edits already worked out — the next session must not have to rediscover them.`;

// A usable summary is prose. A confused model sometimes answers the compaction request with a
// tool call instead (fg-chat 2026-07-17: the "summary" was a bare <tool_call> fn-tag block);
// that junk would replace the history and poison every later turn. compactHistory treats it as
// a failed summary.
export function _degenerateSummary(summary: string): boolean {
    const t = (summary || '').trim();
    if (!t) return true;
    return /^\s*(?:<tool_call>|<function=|<invoke\b|\{["'](?:name|function)["']\s*:)/i.test(t);
}

// Facts the harness knows for certain, appended to every summary so they never depend on the
// summarizer: files written this session, and the last few tool calls with their result headline.
function _harnessFacts(hist: any[]): string {
    const written = new Set<string>();
    const calls: string[] = [];
    const results = new Map(hist.filter((m: any) => m.role === 'tool').map((m: any) => [m.tool_call_id, String(m.content ?? '')]));
    for (const m of hist) for (const tc of m.tool_calls ?? []) {
        let a: any = {};
        try { a = JSON.parse(tc.function?.arguments || '{}'); } catch {}
        const name = tc.function?.name ?? '?';
        if (['write_file', 'replace_in_file', 'apply_patch', 'append_file', 'delete_file'].includes(name) && a.path) written.add(a.path);
        const r = results.get(tc.id) ?? '';
        // Result content is "[TOOL ERROR …]\n" / "[EXIT CODE n]\n" prefix + JSON.
        try { for (const p of JSON.parse(r.replace(/^\[[^\]]*\]\n/, '')).files_written ?? []) written.add(p); } catch {}
        calls.push(`${name}(${JSON.stringify(a).slice(0, 120)}) → ${r.split('\n')[0].slice(0, 150)}`);
    }
    const files = [...written];
    return `[Harness facts — authoritative]\nFiles written this session: ${files.slice(0, 30).join(', ') || 'none'}${files.length > 30 ? ` (+${files.length - 30} more)` : ''}\nLast tool calls:\n${calls.slice(-3).join('\n') || 'none'}`;
}

function _compactSummaryText(summary: string, facts: string): string {
    return `[SYSTEM: The conversation history above has been compacted. The following is a read-only summary of what was discussed and accomplished — it is NOT a new request from the user. Continue the work based on this context.]\n\n${summary}\n\n${facts}`;
}

function _fmtK(n) { return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n); }

// Trim a tail array to the given token budget by dropping oldest messages first. The tail may
// start with an assistant tool call (its results follow it); only orphaned tool results are
// dropped from the front.
function _trimTailToTokenBudget(tail, budget: number = COMPACT_TAIL_TOKEN_BUDGET) {
    while (tail.length > 0 && tail[0].role === 'tool') tail = tail.slice(1);
    while (tail.length > 0 && estimateTokens(tail) > budget) {
        tail = tail.slice(1);
        while (tail.length > 0 && tail[0].role === 'tool') tail = tail.slice(1);
    }
    return tail;
}

async function loadAgentsContext() {
    try { agentsContext = await agentReadFile('AGENTS.md'); }
    catch { agentsContext = ''; }
    setPendingAgentsContextInject(true);
}

// Compaction fetch timeout so a hanging connection doesn't stall forever. Local endpoints get
// longer (a ~50K-token prefill plus a ≤2K-token summary), still well inside task timeouts.
function _compactFetchSignal(ep: any = null) {
    const ms      = isCustomEndpoint(ep) ? 3 * 60_000 : 90_000;
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
            if (headroom > 0 && onContextOverflow) { onContextOverflow(headroom); return 0; }
            if (onContextTruncate) {
                const reduced = onContextTruncate();
                if (reduced) return 0;
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

// Compact the session history into anchor + summary + verbatim tail.
// The request is the main loop's own request — same system prompt, tools and messages, so the
// endpoint's prefix cache covers the history — plus one compaction instruction. `prefix` is the
// main loop's last request (system + tools as sent); without it they are rebuilt.
// Never throws: when the summarizer fails, the history is still reduced to anchor + a stub
// summary (harness facts only) + tail, so the context shrinks and the task can continue.
export async function compactHistory(placeholder: RenderAdapter, activeEndpoint: any = null, session?: AgentSession, effectiveHistory?: any[], prefix: { system: string; tools: any[] | null } | null = null): Promise<void> {
    const task = placeholder.addCompactStep();
    const _s = session ?? defaultSession;
    // When a session-derived effectiveHistory is provided, use it for ALL reads. Writes rebuild
    // _s.history so _mirrorCompactionToSession in llm-loops can sync the session surface.
    const _hR = effectiveHistory ?? _s.history;
    const _PIN = '[TASK — do not lose track of this]\n';
    const _origFirst = _hR.find((m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.trim());
    const _firstMsgContent = _origFirst ? _origFirst.content.replace(/^\[TASK[^\]]*\]\n/, '') : null;
    const beforeTokens = estimateTokens(_hR);
    task.setPrompt(`~${_fmtK(beforeTokens)} tokens → Compacting…`);

    const tail = (() => {
        let t = _hR.slice(-COMPACT_TAIL).filter((m: any) => m !== _origFirst);
        return _trimTailToTokenBudget(t, _tailTokenBudget());
    })();
    const facts = _harnessFacts(_hR);

    let summary: string | null = null;
    let failReason = '';
    try {
        // Starting endpoint: the caller's active endpoint if not cooling (same server = warm
        // prefix cache), then first free across all providers, then whatever is configured.
        let ep: any = (activeEndpoint && !_isCoolingDown(activeEndpoint))
            ? activeEndpoint
            : (firstFreeEndpoint() ?? activeEndpoint ?? _defaultEndpoint());
        task.setModel(modelFriendlyName(`${ep.provider}|${ep.model}`));

        const system = prefix?.system ?? buildSystemPrompt();
        const _tools = prefix ? prefix.tools : (buildOAITools(false, _s._toolFilter ?? null) as any[]);
        const tools  = _tools?.length ? _tools : null;
        const instr  = { role: 'user', content: COMPACT_PROMPT };
        let msgs     = buildRequestMessages(_hR, ep.provider ?? 'custom');
        let maxTok   = _effectiveSummaryTokens();

        // Fit prompt + summary into the window: estimate, and drop the oldest messages (keeping
        // the first) before sending rather than learning it from a rejected request.
        const fit = () => {
            if (!isCustomEndpoint(ep) && getOAIContextTokens() >= 50000) { maxTok = _effectiveSummaryTokens(); return; }
            const est = Math.ceil(estimateTokens([{ role: 'system', content: system }, ...msgs, instr]) * 1.1)
                      + (tools ? Math.ceil(JSON.stringify(tools).length / 4) : 0);
            maxTok = Math.min(_effectiveSummaryTokens(), getOAIContextTokens() - est - 512);
        };
        const dropOldest = (): boolean => {
            if (msgs.length <= 3) return false;
            const drop = Math.max(1, Math.floor((msgs.length - 1) / 3));
            let rest = msgs.slice(1 + drop);
            while (rest.length && rest[0].role === 'tool') rest = rest.slice(1);   // orphaned results
            msgs = [msgs[0], ...rest];
            return true;
        };
        fit();
        while (maxTok < 1024 && dropOldest()) fit();
        if (maxTok < 256) throw new Error('history too large to summarize');

        const _compactIsTransient = (e: any) => isCustomEndpoint(ep) ||
            /HTTP 4\d\d.*(?:not found|no endpoint|no model|invalid model|model.*not.*exist|does not exist)/i.test(e.message);
        const data = await withRetry(async () => {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (ep.key) headers['Authorization'] = `Bearer ${ep.key}`;
            // thinkingBudget 0: the summary must land in the content field, not in reasoning.
            const payload = buildChatPayload(ep, {
                messages: [{ role: 'system', content: system }, ...msgs, instr],
                tools, temperature: 0.1, maxTokens: maxTok, stream: false, thinkingBudget: 0,
                sampling: isCustomEndpoint(ep) ? (() => { const sp = getSamplingParams(); delete sp.temperature; return sp; })() : null,
            });
            if ('tool_choice' in payload) payload.tool_choice = 'none';
            const body = JSON.stringify(payload);
            const proxyUrl = ep.proxy ? getLocalApiProxy() : '';
            const resp = proxyUrl
                ? await fetch(proxyUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: _compactFetchSignal(ep), body: JSON.stringify({ url: ep.url, method: 'POST', headers, body }) })
                : await fetch(ep.url!, { method: 'POST', headers, signal: _compactFetchSignal(ep), body });
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
            setEp: (e: any) => { ep = e; fit(); task.setModel(modelFriendlyName(`${e.provider}|${e.model}`)); task.setPrompt(`Compacting… [→ ${e.provider}|${e.model}]`); },
            onNote: (msg: string) => task.setPrompt(`Compacting… ${msg}`),
            onContextOverflow: (max: number) => {
                maxTok = Math.max(256, Math.min(maxTok, max));
                task.setPrompt(`Compacting… [context overflow: summary budget ${maxTok} tokens]`);
            },
            onContextTruncate: () => {
                if (!dropOldest()) return false;
                fit();
                task.setPrompt(`Compacting… [input overflow: ${msgs.length} messages remain]`);
                return true;
            },
        }), 20, _compactIsTransient);

        const raw = (data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || '').trim();
        if (_degenerateSummary(raw)) throw new Error('no usable summary (tool-call or empty output)');
        summary = raw;
    } catch (e: any) {
        failReason = e?.message || String(e);
    }

    // Rebuild: anchor + summary (or failure stub) + verbatim tail.
    const _firedBeforeCompact = [..._reactiveFired];
    const _preCompactHistory = [..._s.history];
    _s.history.length = 0;
    const _anchor = _origFirst
        ? (workflowMode
            ? _firstMsgContent
            : (_origFirst.content.startsWith(_PIN) ? _origFirst.content : _PIN + _origFirst.content))
        : null;
    if (_anchor) _s.history.push({ role: 'user', content: _anchor });
    const body = summary ?? `(The summarizer failed: ${failReason.slice(0, 200)}. Older messages were removed; the facts below and the recent messages that follow are what remains.)`;
    _s.history.push({ role: 'user', content: _compactSummaryText(body, facts) });
    _s.history.push(...tail);
    // History must not end with an assistant message.
    if (_s.history[_s.history.length - 1]?.role === 'assistant') {
        _s.history.push({ role: 'user', content: '[SYSTEM: Continue where you left off.]' });
    }
    setReactiveFired(new Set(_firedBeforeCompact));
    sessionCompactHistory?.(activeChatId, _preCompactHistory, _s.history);
    const afterTokens = estimateTokens(_s.history);
    task.setPrompt(summary
        ? `~${_fmtK(beforeTokens)} → ~${_fmtK(afterTokens)} tokens`
        : `Summary failed (${failReason.slice(0, 80)}) — kept facts + recent messages, ~${_fmtK(afterTokens)} tokens`);
    task.setOutput(body);
    task.complete();
}


// Window bridge for classic scripts.
Object.assign(window, {
    parseContextOverflow,
    compactHistory,
    loadAgentsContext,
});
