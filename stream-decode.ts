// stream-decode.ts — FreeGent: SSE reading and LLM response decoding.
//
// Pure input→message functions: take a fetch Response, return the assembled
// assistant message ({role, content, tool_calls?, usage}) while emitting chunks
// to the caller's onChunk(text, 'thinking'|'output') for live rendering.
//
//   readSSE            — SSE line reader with idle-timeout + [DONE] handling
//   streamOAICompat    — OAI-compatible streaming: reasoning/content phase machine
//                        (incl. the boundary-chunk rule — see tests/stream-oai.test.js),
//                        tool-call fragment assembly, Qwen3 name-artifact and
//                        python-kwargs argument sanitization
//   nonStreamOAICompat — non-streaming OAI decode (was stranded in llm-loops while
//                        its streaming sibling lived in llm-shared — reunified here)
//
// This is the layer where the v0.10 first-token-loss bug lived; keeping it a small
// tested module is the guard against that class.
//
// Follows the step-validator/…/model-router pattern: ES module, exports, window bridge.

import { softStopPending } from './state.js';

// 90 s between any SSE bytes — safe for even the slowest streaming models (chunks arrive
// every few seconds at most). Short enough that a browser-killed connection (tab hidden,
// OS sleep, phone lock) is detected and retried by withRetry within ~90 s rather than 5 min.
const SSE_IDLE_TIMEOUT_MS = 90_000;


export async function* readSSE(resp: any) {
    // Safari < 14.1: response.body (ReadableStream) is null for fetch responses.
    // The Streams API was wired up to fetch only in Safari 14.1 (March 2021).
    // Fall back to a single resp.text() read, then parse SSE lines from the
    // accumulated text. No incremental chunks, but correct on Safari 12 / iOS 12.
    if (!resp.body) {
        const text = await resp.text();
        for (const line of text.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (payload === '[DONE]') return;
            try { yield JSON.parse(payload); } catch {}
        }
        return;
    }
    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer: string = '';
    try {
        while (true) {
            let timerId: number;
            const { done, value } = await Promise.race([
                reader.read(),
                new Promise((_, reject) => {
                    timerId = setTimeout(() => {
                        reader.cancel().catch(() => {}); // close connection so server isn't left processing
                        reject(new Error('Stream idle timeout'));
                    }, SSE_IDLE_TIMEOUT_MS);
                }),
            ]).finally(() => clearTimeout(timerId));
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const payload = line.slice(6).trim();
                if (payload === '[DONE]') return;
                try { yield JSON.parse(payload); } catch {}
            }
        }
    } finally { try { reader.releaseLock(); } catch {} }
}

// ── Thinking-tag helpers ──────────────────────────────────────────────────────
//
// Different models use different tag names for inline thinking content:
//   <think>    — Qwen3, many local models
//   <thinking> — DeepSeek, various cloud models
//   <thought>  — Gemma (Google DeepMind)
//
// All three are treated identically: content between tags → 'thinking' kind,
// everything outside → 'output' kind.

type TagMatch = { pos: number; len: number };
const _NO_MATCH: TagMatch = { pos: -1, len: 0 };

/** Find the earliest thinking-open tag at or after index `from`. */
function _thinkStart(s: string, from: number): TagMatch {
    const TAGS: [string, number][] = [['<think>', 7], ['<thinking>', 10], ['<thought>', 9]];
    let best = _NO_MATCH;
    for (const [tag, len] of TAGS) {
        const p = s.indexOf(tag, from);
        if (p !== -1 && (best.pos === -1 || p < best.pos)) best = { pos: p, len };
    }
    return best;
}

/** Find the earliest thinking-close tag at or after index `from`. */
function _thinkEnd(s: string, from: number): TagMatch {
    const TAGS: [string, number][] = [['</think>', 8], ['</thinking>', 11], ['</thought>', 10]];
    let best = _NO_MATCH;
    for (const [tag, len] of TAGS) {
        const p = s.indexOf(tag, from);
        if (p !== -1 && (best.pos === -1 || p < best.pos)) best = { pos: p, len };
    }
    return best;
}

export async function streamOAICompat(resp: any, onChunk: any) {
    const tcMap: Record<string, any> = {};
    let content: string          = '';
    let reasoningContent: string = '';
    let usage: any    = null;
    let finish_reason: string | null = null;
    let inThink: boolean  = false;
    let hasReasoningField: boolean = false;
    let reasoningEnded: boolean    = false;
    try { for await (const chunk of readSSE(resp)) {
        if (chunk.error) throw new Error(`HTTP 500: ${chunk.error.message || 'Stream error'}`);
        if (chunk.usage) usage = chunk.usage;
        // Track finish_reason before the delta guard — some providers send it on a chunk
        // with no delta (or null delta), which the guard below would skip.
        const _chunkFR = chunk.choices?.[0]?.finish_reason;
        if (_chunkFR != null) finish_reason = _chunkFR;
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        // Use ?? so if both fields are present (Nemotron sends same text in both), only one fires.
        const _rc = delta.reasoning_content ?? delta.reasoning;
        if (_rc) {
            hasReasoningField = true; onChunk(_rc, 'thinking'); reasoningContent += _rc;
        }
        // Detect transition: first delta with no reasoning_content after reasoning started = response phase
        if (hasReasoningField && !reasoningEnded && !delta.reasoning_content && !delta.reasoning) {
            reasoningEnded = true;
        }
        if (delta.content) {
            // Strip literal EOS/pad tokens that some quantized models emit mid-stream.
            // <|endoftext|> is Qwen's pad token; if it appears, truncate the stream here.
            const _eosIdx = delta.content.indexOf('<|endoftext|>');
            if (_eosIdx !== -1) {
                if (_eosIdx > 0) {
                    const _pre = delta.content.slice(0, _eosIdx);
                    content += _pre; onChunk(_pre, 'output');
                }
                break; // treat as [DONE]
            }
            // While reasoning_content is actively flowing, content is a duplicate of the reasoning
            // stream (models like Nemotron and Step 3.5 Flash echo thinking in both fields).
            // Suppress content until reasoning ends; then emit normally.
            //
            // Boundary chunk exception: vLLM can pack the LAST reasoning tokens and the FIRST
            // content tokens into one SSE chunk (routine under speculative decoding). Discarding
            // content there ate the first token of every answer produced with reasoning enabled
            // (v0.10: "icoCTF{…}" flags, leading hex digit, "29"→"9"). The echo models this
            // suppression exists for send the SAME text in both fields — so only suppress when
            // content matches this delta's reasoning text; distinct content IS the transition.
            if (hasReasoningField && !reasoningEnded && delta.content !== _rc) {
                reasoningEnded = true;
            }
            if (hasReasoningField && !reasoningEnded) {
                // Still in thinking phase — parse <think>/<thought> for state tracking but discard the text
                let raw: string = delta.content, i: number = 0;
                while (i < raw.length) {
                    if (!inThink) {
                        const s = _thinkStart(raw, i);
                        if (s.pos === -1) { i = raw.length; }
                        else { inThink = true; i = s.pos + s.len; }
                    } else {
                        const e = _thinkEnd(raw, i);
                        if (e.pos === -1) { i = raw.length; }
                        else { inThink = false; i = e.pos + e.len; }
                    }
                }
            } else {
                let raw: string = delta.content, out: string = '', i: number = 0;
                while (i < raw.length) {
                    if (!inThink) {
                        // Match <think> (Qwen3), <thinking> (DeepSeek/others), <thought> (Gemma)
                        const s = _thinkStart(raw, i);
                        if (s.pos === -1) { out += raw.slice(i); i = raw.length; }
                        else { out += raw.slice(i, s.pos); inThink = true; i = s.pos + s.len; }
                    } else {
                        const e = _thinkEnd(raw, i);
                        if (e.pos === -1) { onChunk(raw.slice(i), 'thinking'); i = raw.length; }
                        else { onChunk(raw.slice(i, e.pos), 'thinking'); inThink = false; i = e.pos + e.len; }
                    }
                }
                if (out) { content += out; onChunk(out, 'output'); }
            }
        }
        if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!tcMap[idx]) tcMap[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                if (tc.id)                  tcMap[idx].id                    = tc.id;
                if (tc.function?.name)      tcMap[idx].function.name      += tc.function.name;
                if (tc.function?.arguments) tcMap[idx].function.arguments += tc.function.arguments;
            }
        }
    } } catch (e) {
        // Idle timeout mid-stream: return what arrived rather than retrying from scratch and losing it
        if (/idle timeout/i.test(e.message) && content) { /* fall through */ }
        else if (e.name !== 'AbortError' || !softStopPending) throw e;
    }
    if (!content && reasoningContent) { content = reasoningContent; onChunk('', 'output'); }
    const tool_calls = Object.values(tcMap).filter(tc => tc.function.name);
    // Sanitize tool names and arguments.
    // Qwen3 sometimes embeds the full function-call signature in the name field, e.g.:
    //   name: 'search_workspace(pattern="sql")___function'  args: '{}'
    //   name: 'list_files()</function'                       args: '{}'
    // Strip suffixes and attempt to recover embedded kwargs into args when args are empty.
    for (const tc of tool_calls) {
        const rawName = tc.function.name || '';
        // Strip trailing XML/Qwen artifacts: ___function, </function>, </function_calls>, etc.
        const cleanName = rawName.replace(/\s*\)?\s*<\/function[^>]*>$/, ')').replace(/\s*___function[^(]*$/, '');
        // If the name contains embedded args like `tool_name(key=val, ...)`, extract them.
        const parenIdx = cleanName.indexOf('(');
        if (parenIdx !== -1) {
            const baseName = cleanName.slice(0, parenIdx).trim();
            const kwargsStr = cleanName.slice(parenIdx + 1).replace(/\)\s*$/, '').trim();
            tc.function.name = baseName;
            // If args are empty and we have embedded kwargs, try to convert Python kwargs → JSON.
            const existingArgs = (tc.function.arguments || '').trim();
            if ((!existingArgs || existingArgs === '{}') && kwargsStr) {
                try {
                    // Convert Python-style kwargs: key=val → JSON entries. Quoted string
                    // values are lifted out FIRST so the keyword/literal regexes cannot
                    // mutate text inside them (e.g. code="x=1" or msg='True story') —
                    // regex conversion on raw text produced valid-but-corrupted args.
                    const _strs = [];
                    const skel = kwargsStr.replace(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g,
                        (m, s1, s2) => { _strs.push(s1 ?? s2); return `\u0000${_strs.length - 1}\u0000`; });
                    const jsonStr = '{' + skel
                        .replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null')
                        .replace(/(\w+)\s*=/g, '"$1":')
                        .replace(/\u0000(\d+)\u0000/g, (m, i) => JSON.stringify(_strs[+i])) + '}';
                    JSON.parse(jsonStr); // validate
                    tc.function.arguments = jsonStr;
                } catch { /* leave args as {} — better than nothing */ }
            }
        } else {
            tc.function.name = cleanName.trim();
        }
    }
    // Sanitize arguments: vLLM's _postprocess_messages calls json.loads(arguments) on each
    // tool call in subsequent requests. If the model emitted Python-style dicts (single quotes,
    // unquoted keys), the next request fails with HTTP 500. Ensure arguments is always valid JSON.
    for (const tc of tool_calls) {
        if (typeof tc.function.arguments === 'string') {
            try { JSON.parse(tc.function.arguments); }
            catch {
                // Try simple single-quote → double-quote repair for Python-style dicts
                try { const r = tc.function.arguments.replace(/'/g, '"'); JSON.parse(r); tc.function.arguments = r; }
                catch { tc.function.arguments = '{}'; }
            }
        }
    }
    return { role: 'assistant', content: content || null,
        // Preserve reasoning_content so callers that feed history back to vLLM can re-insert
        // the <think> block via preserve_thinking in chat_template_kwargs (multi-turn continuity).
        ...(reasoningContent && { reasoning_content: reasoningContent }),
        ...(tool_calls.length && { tool_calls }), usage, finish_reason };
}

export async function nonStreamOAICompat(resp: any, onChunk: any) {
    const j = await resp.json();
    if (j.error) throw new Error(j.error.message || 'Provider error');
    const msg = j.choices?.[0]?.message || {};
    const reasoning_content = msg.reasoning_content || msg.reasoning || '';
    const content           = msg.content || '';
    if (reasoning_content) onChunk(reasoning_content, 'thinking');
    if (content)           onChunk(content,            'output');
    const effective = content || reasoning_content || null;
    const tool_calls = (msg.tool_calls || []).filter(tc => tc.function?.name);
    const finish_reason: string | null = j.choices?.[0]?.finish_reason ?? null;
    // Preserve reasoning_content for history — vLLM re-inserts it as <think> via preserve_thinking.
    return { role: 'assistant', content: effective,
        ...(reasoning_content && { reasoning_content }),
        ...(tool_calls.length && { tool_calls }), usage: j.usage, finish_reason };
}

// Dispatches to streamOAICompat or nonStreamOAICompat based on content-type.
// Callers should prefer this over the individual functions to avoid duplicating
// the content-type branch.
export async function decodeOAIResponse(resp: any, onChunk: any) {
    const ct = resp.headers?.get?.('content-type') ?? '';
    return ct.includes('text/event-stream')
        ? streamOAICompat(resp, onChunk)
        : nonStreamOAICompat(resp, onChunk);
}

// Window bridge for free-variable access from sibling modules (house pattern).
Object.assign(window, { readSSE, streamOAICompat, nonStreamOAICompat, decodeOAIResponse });
