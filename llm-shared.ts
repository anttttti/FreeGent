import { workflowMode, activeChatId, activeAbortController, setPendingAgentsContextInject, type AgentSession, defaultSession } from './state.js';
import { type RenderAdapter } from './render-adapter.js';
import { withRetry, asTransportError, _isTimeoutError, parseContextOverflow, fmtDelay, _httpErrorFromResponse } from './retry.js';
import { getCooldownRemaining, specToEndpoint, _isCoolingDown, modelFriendlyName, withEndpointSlot,
         firstFreeEndpoint, _defaultEndpoint, _markCooldown, _markFlatCooldown, _isRateLimit, _isServerError } from './model-router.js';
import { buildSystemPrompt } from './system-prompt.js';
import { buildChatPayload, buildRequestMessages, isCustomEndpoint } from './payload-builder.js';
import { buildOAITools } from './tool-schemas.js';
import { estimateTokens, getOAIContextTokens, getEndpointContextTokens, getSamplingParams, getActiveMainModelList, getMainModelList, getLocalApiProxy, getAgentProactiveCompact, getAgentCompactAt, getAgentCompactTokens } from './config.js';
import { sessionCompactHistory } from './session-store.js';
import { combineSignals } from './abort.js';
// llm-shared.js — FreeGent: context compaction (and the AGENTS.md loader).
// Depends on: config.js, state.js, payload-builder.js, retry.js, model-router.js.
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

// The window of the endpoint the summary goes to (its own model's, when the catalog knows it, under the shared setting): an 8K model behind a shared 50K setting
// was asked for a summary and a tail that do not fit it (codex R60).
const _window = (ep?: any): number => ep ? getEndpointContextTokens(ep) : getOAIContextTokens();
function _effectiveSummaryTokens(ep?: any): number {
    return Math.min(COMPACT_SUMMARY_TOKENS, Math.floor(_window(ep) * 0.25));
}

// Compute the effective tail-token budget for the current context window.
// When proactive compaction is enabled, post-compaction context must stay below the
// compaction threshold — otherwise compaction never reduces the window and spirals.
// Uses the threshold (not ctxWindow) as the ceiling; 5K overhead covers the anchor,
// system prompt, and safety margin. For hard-limit compaction the original formula applies.
function _tailTokenBudget(ep?: any): number {
    const ctxWindow     = _window(ep);
    const summaryBudget = _effectiveSummaryTokens(ep);
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
function _degenerateSummary(summary: string): boolean {
    const t = (summary || '').trim();
    if (!t) return true;
    return /^\s*(?:<tool_call>|<function=|<invoke\b|\{["'](?:name|function)["']\s*:)/i.test(t);
}

// Facts the harness knows for certain, appended to every summary so they never depend on the
// summarizer: files written this session, and the last few tool calls with their result headline.
// Did a write tool's recorded result say the write failed? Results start with "[TOOL ERROR …]" when the call failed, or hold an error / success:false field.
function _writeResultFailed(result: string): boolean {
    if (/^\s*\[(?:TOOL )?ERROR/i.test(result)) return true;
    try {
        const v = JSON.parse(result.replace(/^\[[^\]]*\]\n/, ''));
        return !!(v && typeof v === 'object' && (v.error || v.success === false || v.ok === false));
    } catch { return false; }
}
function _harnessFacts(hist: any[]): string {
    const written = new Set<string>();
    const failed = new Map<string, string>();   // path → why the last attempt did not apply
    const calls: string[] = [];
    // The receipts of earlier compactions: their calls are gone from the history, and the only record left is the facts block that compaction wrote into its
    // summary message. Carried forward from there, so that a second and third compaction do not depend on the summarizer remembering them (codex R58).
    for (const m of hist) {
        const t = typeof m?.content === 'string' ? m.content : '';
        const at = t.indexOf('[Harness facts — authoritative]');
        if (at < 0) continue;
        const line = /Files written this session: ([^\n]*)/.exec(t.slice(at))?.[1];
        if (line && line.trim() !== 'none') for (const p of line.replace(/\s*\(\+\d+ more\)\s*$/, '').split(', ')) if (p.trim()) written.add(p.trim());
    }
    const results = new Map(hist.filter((m: any) => m.role === 'tool').map((m: any) => [m.tool_call_id, String(m.content ?? '')]));
    for (const m of hist) for (const tc of m.tool_calls ?? []) {
        let a: any = {};
        try { a = JSON.parse(tc.function?.arguments || '{}'); } catch {}
        const name = tc.function?.name ?? '?';
        const r = results.get(tc.id) ?? '';
        // "Authoritative" must mean written. A call is a write only when its recorded result does not say it failed; an attempt that failed is listed as that, so a
        // model resuming after the compaction does not take an edit that never applied for a done one (codex R3-001).
        if (['write_file', 'replace_in_file', 'apply_patch', 'append_file', 'delete_file'].includes(name) && a.path) {
            if (_writeResultFailed(r)) failed.set(a.path, r.replace(/^\[[^\]]*\]\n/, '').replace(/\s+/g, ' ').slice(0, 100));
            else { written.add(a.path); failed.delete(a.path); }
        }
        // Result content is "[TOOL ERROR …]\n" / "[EXIT CODE n]\n" prefix + JSON.
        try { for (const p of JSON.parse(r.replace(/^\[[^\]]*\]\n/, '')).files_written ?? []) written.add(p); } catch {}
        calls.push(`${name}(${JSON.stringify(a).slice(0, 120)}) → ${r.split('\n')[0].slice(0, 150)}`);
    }
    const files = [...written];
    const notApplied = [...failed].filter(([p]) => !written.has(p)).slice(-10);
    return `[Harness facts — authoritative]\nFiles written this session: ${files.slice(0, 100).join(', ') || 'none'}${files.length > 100 ? ` (+${files.length - 100} more)` : ''}${notApplied.length ? `\nWrites that did NOT apply (the file is unchanged by them): ${notApplied.map(([p, why]) => `${p} (${why})`).join('; ')}` : ''}\nLast tool calls:\n${calls.slice(-3).join('\n') || 'none'}`;
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

// One tool result may take at most half the tail budget. The budget is checked with a chars/4
// estimate, and a path-heavy result tokenizes far denser than that: a 129K-char worker result
// passed as ~32K tokens, was really more than the 60K window, and every request after the
// compaction overflowed again — 119 compactions in a row (TerminalBench v0.66 sanitize-git-repo).
export function _capTailToolResults(tail: any[], budget: number): any[] {
    const maxChars = Math.max(4000, Math.floor(budget * 4 / 2 / 1.5));   // /1.5: dense-tokenizing content
    return tail.map((m: any) => {
        if (m?.role !== 'tool' || typeof m.content !== 'string' || m.content.length <= maxChars) return m;
        const head = Math.floor(maxChars * 0.7), end = maxChars - head;
        return { ...m, content: `${m.content.slice(0, head)}\n[… ${m.content.length - maxChars} chars removed when the conversation was compacted — run the call again with a narrower request if you need them …]\n${m.content.slice(-end)}` };
    });
}

async function loadAgentsContext() {
    try { agentsContext = await agentReadFile('AGENTS.md'); }
    catch { agentsContext = ''; }
    setPendingAgentsContextInject(true);
}

// Compaction fetch timeout so a hanging connection doesn't stall forever. Local endpoints get
// longer (a ~50K-token prefill plus a ≤2K-token summary), still well inside task timeouts.
// A local 27B prefills ~500 tokens/s and writes ~20/s: a 20k-token history plus a 2k-token summary is ~150 s idle, and
// the old flat 3 minutes cut it off ("the summarizer failed: signal timed out", the facts were lost). Allow 8 ms per prompt token on top.
function _compactFetchSignal(ep: any = null, promptTokens = 0) {
    const local = 3 * 60_000 + Math.max(0, promptTokens) * 8;
    return combineSignals(activeAbortController?.signal, isCustomEndpoint(ep) ? local : 90_000)!;
}

// Compaction retry handler: a deliberately smaller sibling of retry.ts _makeOAIRetryHandler.
// Differences, all intentional: rotation walks the whole active model list (no rate-limit
// fallback endpoint, no tool-format lock — compaction sends no tool calls); 'vllm' counts as a
// local endpoint; no 401/404 model pausing and no truncated-response cycling (a failed summary
// is retried or replaced by a stub, never worth pausing the user's model); no worker mode.
// Keep the shared behaviour (context-overflow headroom, cooldown marking, delays) in step with
// _makeOAIRetryHandler — tests/retry-consistency.test.ts pins the classifier contract.
function _makeCompactRetryHandler({ getEp, setEp, onNote, onContextOverflow = null as any, onContextTruncate = null as any }) {
    return (n: number, e: any, d: number) => {
        // Context overflow (OAI "maximum context length" error)
        const headroom = parseContextOverflow(e, 256);   // a summary can be short: the answer-sized floor is for the main loop
        if (headroom !== null) {
            if (headroom > 0 && onContextOverflow) { onContextOverflow(headroom); return 0; }
            if (onContextTruncate) {
                const reduced = onContextTruncate();
                if (reduced) return 0;
            }
            return false;
        }
        const ep = getEp();
        const is429 = _isRateLimit(e.message, ep);   // with the endpoint: a busy local server's 503 is a server error, not a quota (opencode §23)
        const isErr = !is429 && _isServerError(e.message);
        const key = `${ep.provider}|${ep.model}`;
        const isCustom = ep.provider === 'custom' || ep.provider === 'vllm';
        if (_isTimeoutError(e) && isCustom) {
            onNote(`[${key}][fetch timeout: server unresponsive, not retrying]`);
            return false;
        }
        if (is429 && !e.preFlight) _markCooldown(ep, e.retryAfterMs ?? null, e);
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

/** The text of a user message: its string content, or the text parts of array (multimodal) content. */
export function _userText(m: any): string {
    if (typeof m?.content === 'string') return m.content;
    if (Array.isArray(m?.content)) return m.content.filter((p: any) => p?.type === 'text' && typeof p.text === 'string').map((p: any) => p.text).join('\n');
    return '';
}

// Compact the session history into anchor + summary + verbatim tail.
// The request is the main loop's own request — same system prompt, tools and messages, so the
// endpoint's prefix cache covers the history — plus one compaction instruction. `prefix` is the
// main loop's last request (system + tools as sent); without it they are rebuilt.
// Never throws: when the summarizer fails, the history is still reduced to anchor + a stub
// summary (harness facts only) + tail, so the context shrinks and the task can continue.
export async function compactHistory(placeholder: RenderAdapter, activeEndpoint: any = null, session?: AgentSession, effectiveHistory?: any[], prefix: { system: string; tools: any[] | null } | null = null): Promise<any[]> {
    const task = placeholder.addCompactStep();
    const _s = session ?? defaultSession;
    const _sig = activeAbortController?.signal;   // the stop signal in force when compaction began
    // Reads come from effectiveHistory, else the session's event log. The compacted history is
    // returned, not written: the caller applies it (the loop shadows the surface with it, the
    // manual /compact replaces the chat's history).
    const _hR = effectiveHistory ?? _s._session?.deriveMessages() ?? [];
    const _PIN = '[TASK — do not lose track of this]\n';
    // The task is the first user message with text, whatever its shape. Only string content was
    // accepted, so a first message sent with an attachment (array content) was skipped and the next
    // string message — a later request, or a harness <nudge> — was pinned as the task instead.
    const _origFirst = _hR.find((m: any) => m.role === 'user' && _userText(m).trim() && !/^\s*<nudge>/.test(_userText(m)));
    const _origText: string | null = _origFirst
        ? _userText(_origFirst) + (Array.isArray(_origFirst.content) && _origFirst.content.some((p: any) => p?.type && p.type !== 'text')
            ? '\n[The attachments sent with this message are not repeated here.]' : '')
        : null;
    const _firstMsgContent = _origText !== null ? _origText.replace(/^\[TASK[^\]]*\]\n/, '') : null;
    const beforeTokens = estimateTokens(_hR);
    // On a local model a ~20k-token history takes ~5 minutes to summarise; the step said only "Compacting…" and a running timer.
    task.setPrompt(`~${_fmtK(beforeTokens)} tokens → Compacting…${isCustomEndpoint(activeEndpoint) && beforeTokens > 8000 ? ' (a local model can take a few minutes for this)' : ''}`);

    // Starting endpoint: the caller's active endpoint if not cooling (same server = warm prefix cache), then first free across all providers.
    const _freeEp = (activeEndpoint && !_isCoolingDown(activeEndpoint)) ? null : firstFreeEndpoint();
    const _startEp = (activeEndpoint && !_isCoolingDown(activeEndpoint)) ? activeEndpoint : (_freeEp ?? activeEndpoint ?? null);
    const tail = (() => {
        let t = _hR.slice(-COMPACT_TAIL).filter((m: any) => m !== _origFirst);
        return _trimTailToTokenBudget(_capTailToolResults(t, _tailTokenBudget(_startEp)), _tailTokenBudget(_startEp));
    })();
    const facts = _harnessFacts(_hR);

    let summary: string | null = null;
    let failReason = '';
    try {
        // Starting endpoint: the caller's active endpoint if not cooling (same server = warm
        // prefix cache), then first free across all providers, then whatever is configured.
        // Nothing usable and no endpoint given (a manual /compact with every model paused or the list empty): no request, as for a turn; the caller's
        // fallback (facts plus the tail) applies, and the default provider is not tried (codex R63).
        if (!_startEp && !getActiveMainModelList().length)
            throw new Error(getMainModelList().length ? 'every model in the priority list is paused, switched off or has no API key' : 'the priority list is empty');
        let ep: any = _startEp ?? _defaultEndpoint();
        task.setModel(modelFriendlyName(`${ep.provider}|${ep.model}`));

        const system = prefix?.system ?? buildSystemPrompt();
        const _tools = prefix ? prefix.tools : (buildOAITools(false, _s._toolFilter ?? null) as any[]);
        const tools  = _tools?.length ? _tools : null;
        const instr  = { role: 'user', content: COMPACT_PROMPT };
        let msgs     = buildRequestMessages(_hR, ep.provider ?? 'custom');
        let maxTok   = _effectiveSummaryTokens(ep);

        // Fit prompt + summary into the window: estimate, and drop the oldest messages (keeping
        // the first) before sending rather than learning it from a rejected request.
        const fit = () => {
            if (!isCustomEndpoint(ep) && _window(ep) >= 50000) { maxTok = _effectiveSummaryTokens(ep); return; }
            const est = Math.ceil(estimateTokens([{ role: 'system', content: system }, ...msgs, instr]) * 1.1)
                      + (tools ? estimateTokens(tools) : 0);
            maxTok = Math.min(_effectiveSummaryTokens(ep), _window(ep) - est - 512);
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
        const data = await withRetry(() => withEndpointSlot(ep, null, async () => {
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
            const resp = await (proxyUrl
                ? fetch(proxyUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: _compactFetchSignal(ep, estimateTokens(msgs)), body: JSON.stringify({ url: ep.url, method: 'POST', headers, body }) })
                : fetch(ep.url!, { method: 'POST', headers, signal: _compactFetchSignal(ep, estimateTokens(msgs)), body })
            ).catch(e => { throw asTransportError(e); });
            if (!resp.ok) throw await _httpErrorFromResponse(resp, 'Compaction');
            return resp.json();
        }), _makeCompactRetryHandler({
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

        // The summary request is a model request like any other; it was in no token total.
        try { if (typeof metricsNote === 'function') metricsNote({ type: 'compaction', promptTokens: data.usage?.prompt_tokens, responseTokens: data.usage?.completion_tokens }); } catch {}
        const raw = (data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || '').trim();
        if (_degenerateSummary(raw)) throw new Error('no usable summary (tool-call or empty output)');
        summary = raw;
    } catch (e: any) {
        failReason = e?.message || String(e);
    }

    // Stopped while summarising: nothing was compacted, and no new generation is written for a summary nobody applies
    // (TUI report case 055 saved a cancelled compaction's late summary as a success).
    if (_sig?.aborted) { task.setPrompt('Compaction stopped'); task.complete(); return _hR; }

    // Rebuild: anchor + summary (or failure stub) + verbatim tail.
    const _preCompactHistory = [..._hR];
    const _newHistory: any[] = [];
    const _anchor = _origFirst
        ? (workflowMode
            ? _firstMsgContent
            : (_origText!.startsWith(_PIN) ? _origText : _PIN + _origText))
        : null;
    if (_anchor) _newHistory.push({ role: 'user', content: _anchor });
    const body = summary ?? `(The summarizer failed: ${failReason.slice(0, 200)}. Older messages were removed; the facts below and the recent messages that follow are what remains.)`;
    _newHistory.push({ role: 'user', content: _compactSummaryText(body, facts) });
    _newHistory.push(...tail);
    // History must not end with an assistant message.
    if (_newHistory[_newHistory.length - 1]?.role === 'assistant') {
        _newHistory.push({ role: 'user', content: '[SYSTEM: Continue where you left off.]' });
    }
    sessionCompactHistory?.(activeChatId, _preCompactHistory, _newHistory);
    const afterTokens = estimateTokens(_newHistory);
    task.setPrompt(summary
        ? `~${_fmtK(beforeTokens)} → ~${_fmtK(afterTokens)} tokens`
        : `Summary failed (${failReason.slice(0, 80)}) — kept facts + recent messages, ~${_fmtK(afterTokens)} tokens`);
    task.setOutput(body);
    task.complete();
    return _newHistory;
}


// Window bridge for classic scripts.
Object.assign(window, {
    parseContextOverflow,
    compactHistory,
    loadAgentsContext,
});
