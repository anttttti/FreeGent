// history.ts — FreeGent: conversation-history hygiene.
//
// Owns everything about what tool results become in history and how the history
// stays valid and lean:
//   - truncateResultForHistory / _historyResult / _summarizeToolResult /
//     _extractCodeBlocks — result → history representation (size caps, dedup notes,
//     structural code extraction for the Director)
//   - pruneOAIHistory — masks stale duplicate reads ([pruned: …] stubs) and marks
//     _seenReadFiles 'pruned' so the dedup gate lets legitimate re-reads through
//   - repairOAIHistory / repairHistoryArray — removes null entries, orphaned tool
//     blocks, and broken assistant↔tool pairings (strict providers 400 on these)
//   - _normPath / resetSeenReadFiles / _invalidateReadDedup — read-dedup state
//
// repairHistoryArray is the single implementation; workers previously carried
// _repairOAIHistoryCopy, a comment-confessed hand-mirror ("Mirrors repairOAIHistory()
// in llm-loops.js but operates on an arbitrary array") that had already drifted —
// it lacked the orphan-block and think-tag passes. One module, one behavior.
//
// Follows the step-validator/…/tool-call-repair pattern: ES module, exports, window bridge.

import {
    _seenReadFiles, _seenListFiles, setSeenReadFiles, setSeenListFiles,
    openaiHistory, setOpenaiHistory, activeChatId,
} from './state.js';
import type { Session } from './session.js';
import { pruneSurface } from './session.js';

// Normalize path for deduplication: strip leading "local/" so that "local/foo.md" and
// "foo.md" are treated as the same file (the server serves both from the same store).
export function _normPath(p: string): string { return (p || '').replace(/^local\//, ''); }

export function resetSeenReadFiles(): void { setSeenReadFiles(new Map()); setSeenListFiles(new Set()); }

export function _invalidateReadDedup(path: string): void {
    const norm = _normPath(path);
    for (const key of _seenReadFiles.keys())
        if (key.startsWith(norm + ':')) _seenReadFiles.delete(key);
    // Evict list-file dedup for any ancestor directory of the changed file so a
    // subsequent list_files sees the new/deleted file rather than the stale cached note.
    const dir = norm.replace(/[^/]+$/, ''); // 'foo/bar.py' → 'foo/'
    for (const k of [..._seenListFiles]) {
        const kDir = k.endsWith('/') ? k : k ? k + '/' : '';
        if (!k || dir === kDir || dir.startsWith(kDir)) _seenListFiles.delete(k);
    }
}

// ── Result → history representation ─────────────────────────────────────────

// When a read_file result exceeds the Director threshold, extract structural blocks
// (functions/classes) with absolute line numbers instead of LLM-summarising.
// Preserves exact code text.
function _extractCodeBlocks(result: any, threshold: number): any {
    const path      = result.path || '';
    const content   = typeof result.content === 'string' ? result.content : '';
    const startLine = result.start_line || 1;
    if (!content) return result;

    const lines = content.split('\n');

    const isDefLine = l =>
        /^(async\s+)?def\s+\w/.test(l) ||                                              // Python def
        /^class\s+\w/.test(l) ||                                                        // Python/JS class
        /^(export\s+)?(default\s+)?(async\s+)?function[* ]\w/.test(l) ||               // JS function
        /^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?(function|\()/.test(l);  // JS arrow/const fn

    const defIdxs = lines.reduce((acc, l, i) => { if (isDefLine(l)) acc.push(i); return acc; }, []);

    if (!defIdxs.length) {
        // No block structure — return with line numbers, hard-truncated to threshold
        const numbered = lines.map((l, i) => `${startLine + i}: ${l}`).join('\n');
        const note = `[${path}: no block structure detected. Showing with line numbers.]\n`;
        const full = note + numbered;
        if (full.length <= threshold) return { ...result, content: full };
        return { ...result, content: full.slice(0, threshold) + `\n[…truncated. Use start_line/end_line to read more.]` };
    }

    const blocks = defIdxs.map((di, i) => {
        const endIdx = i + 1 < defIdxs.length ? defIdxs[i + 1] - 1 : lines.length - 1;
        return {
            absStart: startLine + di,
            absEnd:   startLine + endIdx,
            sig:      lines[di].trimEnd(),
            body:     lines.slice(di, endIdx + 1).join('\n'),
        };
    });

    const index = blocks.map(b => `  L${b.absStart}: ${b.sig}`).join('\n');
    let out = `[${path} (L${startLine}–${startLine + lines.length - 1}). Definitions:\n${index}\n]\n\n`;

    const omitted = [];
    for (const b of blocks) {
        const chunk = `# L${b.absStart}–${b.absEnd}\n${b.body}\n\n`;
        if (out.length + chunk.length <= threshold) {
            out += chunk;
        } else {
            omitted.push(`L${b.absStart}: ${b.sig}`);
        }
    }
    // If every block was omitted the model will loop forever re-reading the same range.
    // Fall back to hard-truncating the raw content so at least some code is visible.
    if (omitted.length === blocks.length) {
        const numbered = lines.map((l, i) => `${startLine + i}: ${l}`).join('\n');
        const note = `[${path} (L${startLine}–${startLine + lines.length - 1}). Content too large for block extraction — showing raw with line numbers.]\n`;
        const full = note + numbered;
        return { path, start_line: startLine, content: full.length <= threshold
            ? full
            : full.slice(0, threshold) + `\n[…truncated. Use start_line/end_line to read a smaller section.]` };
    }
    if (omitted.length) {
        out += `[Omitted ${omitted.length} block(s): ${omitted.join('; ')}. Re-read with start_line/end_line.]`;
    }

    return { path, start_line: startLine, content: out };
}

// originalResult: raw tool output. truncatedResult: already processed by truncateResultForHistory.
// Replaces LLM-based summarisation with deterministic block extraction for code files.
function _summarizeToolResult(name: string, originalResult: any, truncatedResult: any): any {
    const threshold = typeof getDirectorMaxToolResult === 'function' ? getDirectorMaxToolResult() : 0;
    if (!threshold) return truncatedResult;
    if (JSON.stringify(originalResult).length <= threshold) return truncatedResult;

    if (name === 'read_file' && typeof originalResult.content === 'string') {
        return _extractCodeBlocks(originalResult, threshold);
    }

    // For other tools: truncateResultForHistory already handled size; pass through.
    return truncatedResult;
}

// The history-result computation for a main-loop tool result.
// Director (main agent) gets summarize-on-top-of-truncate with the tighter isDirector
// limit; workers get plain truncation (worker loops pass their own local dedup maps).
export function _historyResult(name: string, result: any, forWorker: boolean, stepBudget: any = null): any {
    const final = forWorker
        ? truncateResultForHistory(name, result, { isDirector: false, stepBudget })
        : _summarizeToolResult(name, result, truncateResultForHistory(name, result, { isDirector: true, stepBudget }));
    // Capture the untruncated original when truncation/summarization actually shortened it —
    // otherwise-lost content, correlatable by chat_id for benchmarking/debugging analysis
    // (same rationale as the fn-tag capture in llm-loops.js's callOAI).
    if (final !== result && typeof sessionSaveRawMessage !== 'undefined' && sessionSaveRawMessage) {
        try {
            const origStr = JSON.stringify(result);
            if (origStr.length > JSON.stringify(final).length) {
                sessionSaveRawMessage(activeChatId, { role: 'tool', content: origStr, name, kind: 'tool_truncate' });
            }
        } catch {}
    }
    return final;
}

// isDirector=true: apply tighter history limits for the main agent context.
// Workers need more content in history to complete their narrow task;
// the Director only needs to remember *what was found*, not the full text.
// seenReadFiles / seenListFiles: pass worker-local maps to isolate dedup state from the
// main loop. When null (default), uses the state.js globals (main agent path).
// stepBudget: shared mutable { remaining: N } object across all results in one step —
// when exhausted, subsequent read_file results are replaced with a "not read" note so
// the agent knows to read them in a separate step instead of silently missing content.
export function truncateResultForHistory(name: string, result: any, { isDirector = false, seenReadFiles = null, seenListFiles = null, stepBudget = null }: any = {}): any {
    if (ls('fg_agent_tool_result_truncation', 'true') === 'false') return result;
    const configLimit = parseInt(ls('fg_agent_max_tool_result', '20000'), 10);
    // Per-result limit: min of configLimit and remaining step budget (if tracking).
    const limit = stepBudget ? Math.min(configLimit, Math.max(0, stepBudget.remaining)) : configLimit;
    const _rf = seenReadFiles ?? _seenReadFiles;
    const _lf = seenListFiles ?? _seenListFiles;

    if (name === 'list_files') {
        // Deduplicate list_files: if we already listed this exact path this turn, suppress the result.
        // Use the original requested path (result.path) as key — don't normalise, since "" and "local"
        // can return different data (IDB vs FSA) even though they share the same normalised prefix.
        const prefix = result.path ?? '';
        if (_lf.has(prefix)) {
            return { note: `Already listed "${prefix}" this session — results are in your prior tool results.` };
        }
        _lf.add(prefix);
        // Director: cap list results to first 20 entries + count note to avoid ledger-sized dumps
        if (isDirector && Array.isArray(result.files) && result.files.length > 20) {
            const kept = result.files.slice(0, 20);
            return { ...result, files: kept, note: `Showing 20 of ${result.files.length} files. Use a more specific path filter or delegate to a worker to process the full list.` };
        }
    }

    if (name === 'read_file' && result.path) {
        // Budget exhausted: return a stub so the agent knows the file exists but wasn't read.
        if (stepBudget && stepBudget.remaining <= 0) {
            return { path: result.path, note: `Not read — step context budget exhausted by earlier results. Read this file in a separate step.` };
        }

        // Per-path cumulative read cap: after 6 reads of the same file (any range combination),
        // suppress further reads. Catches re-read spirals on large files. Counter stored in _rf
        // as a synthetic key so resetSeenReadFiles() and _invalidateReadDedup() clear it automatically.
        const pathNorm   = _normPath(result.path);
        const countKey   = `${pathNorm}::__count__`;
        const readCount  = (_rf.get(countKey) as number) ?? 0;
        if (readCount >= 6) {
            return { path: result.path, note: `Already read "${result.path}" ${readCount} times this session — content is in your prior tool results.` };
        }

        // Suppress duplicate read of the same range whose content is still in history
        // (not yet pruned). If the file was edited since, _invalidateReadDedup already
        // cleared the entry — re-read goes through normally. pruneOAIHistory sets
        // 'pruned' so post-prune re-reads serve content again (never starve the model).
        const rangeKey = `${pathNorm}:${result.start_line||''}:${result.end_line||''}`;
        const priorState = _rf.get(rangeKey);
        if (priorState === 'full' || priorState === 'truncated') {
            return { path: result.path, note: `Already read "${result.path}" — the full content is in your prior tool result for this file. Read a different range if you need other sections.` };
        }

        // Track read state for pruneOAIHistory & dedup check above.
        const contentLen = typeof result.content === 'string' ? result.content.length : 0;
        _rf.set(rangeKey, contentLen > limit ? 'truncated' : 'full');
        // Only count full (unranged) reads — ranged reads are targeted navigation and should not be capped.
        if (!result.start_line && !result.end_line) _rf.set(countKey, readCount + 1);
    }

    const strField = { read_file:'content', execute_code:'stdout' }[name];
    if (strField) {
        const val = result[strField];
        const effectiveLen = val?.length ?? 0;
        if (typeof val === 'string' && effectiveLen > limit) {
            const truncated = val.slice(0, limit);
            if (stepBudget) stepBudget.remaining -= truncated.length;
            if (name === 'read_file') {
                const startLine = result.start_line || 1;
                const shownLines = (truncated.match(/\n/g) || []).length + 1;
                const totalLines = (val.match(/\n/g) || []).length + 1;
                const shownEnd = startLine + shownLines - 1;
                const totalEnd = startLine + totalLines - 1;
                const _remaining = totalEnd - shownEnd;
                const _hint = _remaining > 500
                    ? `use start_line/end_line to read a specific range`
                    : `use start_line=${shownEnd + 1} to read more`;
                return { ...result, [strField]: truncated + `\n[…lines ${shownEnd + 1}–${totalEnd} not shown — ${_hint}]` };
            }
            return { ...result, [strField]: truncated + `\n[…${effectiveLen - limit} chars not shown]` };
        }
        if (stepBudget) stepBudget.remaining -= effectiveLen;
    }
    if (name === 'execute_code' && typeof result.stderr === 'string' && result.stderr.length > limit) {
        return { ...result, stderr: result.stderr.slice(0, limit) + `\n[…${result.stderr.length - limit} chars not shown]` };
    }

    if (name === 'web_search' && Array.isArray(result.results)) {
        if (JSON.stringify(result).length > limit) {
            return { ...result, results: result.results.map(r => ({
                title: r.title, url: r.url,
                snippet: (r.snippet || r.summary || '').slice(0, 250),
            })) };
        }
    }

    if (name === 'run_workers' && result.warning && !(result.incomplete?.length)) {
        const { warning, ...rest } = result;
        return rest;
    }

    if (name === 'repo_map' && typeof result.map === 'string' && result.map.length > limit) {
        return { ...result, map: result.map.slice(0, limit) + `\n[…truncated, ${result.files_mapped} files total]` };
    }

    if (name === 'search_workspace' && Array.isArray(result.matches)) {
        const joined = result.matches.join('\n---\n');
        if (joined.length > limit) {
            const truncated = joined.slice(0, limit);
            const matches = truncated.split('\n---\n');
            return { ...result, matches, note: `Truncated to ${matches.length} of ${result.matches.length} matches.` };
        }
    }

    return result;
}

// ── History pruning ──────────────────────────────────────────────────────────
// Removes stale/duplicate file read results in-place. No LLM call — pure heuristic.
// Duplicate read: a later read of the same file covers this read's line range, with no write to
// the file in between → stub this one. Reads separated by a write are kept (pre-edit state).

const _PRUNE_READ_TOOLS  = new Set(['read_file']);
const _PRUNE_WRITE_TOOLS = new Set(['write_file', 'replace_in_file', 'apply_patch', 'delete_file', 'append_file']);
const _PRUNE_MIN_CHARS   = 800;

function _clen(c: any): number { return typeof c === 'string' ? c.length : JSON.stringify(c).length; }

type _CallMeta = { name: string; path: string | null; from: number; to: number };
// tool_call_id → tool name, path, and read line range (a whole-file read is [1, Infinity]).
function _callMetaMap(msgs: any[]): Map<string, _CallMeta> {
    const callMeta = new Map<string, _CallMeta>();
    for (const m of msgs) {
        if (m.role !== 'assistant' || !m.tool_calls) continue;
        for (const tc of m.tool_calls) {
            const name = tc.function?.name; if (!name) continue;
            let a: any = {};
            try { a = JSON.parse(tc.function.arguments || '{}'); } catch {}
            callMeta.set(tc.id, { name, path: a.path ?? a.file_path ?? a.filename ?? null,
                from: Number(a.start_line) || 1, to: Number(a.end_line) || Infinity });
        }
    }
    return callMeta;
}

// True when a later read of the same file covers this read's line range with no write to the file
// in between — only then is this read redundant. Pruning every earlier read of the path left the
// model one range at a time, and it re-read two ranges alternately until the step limit (v0.55).
function _readCovered(pos: number, meta: _CallMeta, results: Array<{ pos: number; meta: _CallMeta }>): boolean {
    for (const r of results) {
        if (r.pos <= pos || r.meta.path !== meta.path) continue;
        if (_PRUNE_WRITE_TOOLS.has(r.meta.name)) return false;   // file changed before any covering read
        if (_PRUNE_READ_TOOLS.has(r.meta.name) && r.meta.from <= meta.from && r.meta.to >= meta.to) return true;
    }
    return false;
}

export function pruneOAIHistory(history: any[]): number {
    const callMeta = _callMetaMap(history);
    const results: Array<{ pos: number; msg: any; meta: _CallMeta }> = [];
    for (let i = 0; i < history.length; i++) {
        const msg = history[i]; if (msg.role !== 'tool') continue;
        const meta = callMeta.get(msg.tool_call_id); if (meta) results.push({ pos: i, msg, meta });
    }
    let saved = 0;
    for (const { pos: idx, msg, meta } of results) {
        if (!_PRUNE_READ_TOOLS.has(meta.name) || !meta.path) continue;
        const cl = _clen(msg.content); if (cl < _PRUNE_MIN_CHARS) continue;
        if (_readCovered(idx, meta, results)) {
            history[idx] = { ...msg, content: `[pruned: dup read "${meta.path}", ${cl} chars]` }; saved += cl;
            // Mark _seenReadFiles entries for this path as 'pruned' so the dedup
            // gate in truncateResultForHistory lets future re-reads through.
            const pNorm = _normPath(meta.path);
            for (const key of _seenReadFiles.keys())
                if (key.startsWith(pNorm + ':')) _seenReadFiles.set(key, 'pruned');
        }
    }
    return saved;
}

/**
 * Session-native duplicate-read pruning.
 * Equivalent to pruneOAIHistory() but operates on the session event log via
 * pruneSurface() instead of mutating a history array.
 * Called for native-format models with an active session; pruneOAIHistory is
 * still used for fn-tag / no-session paths.
 */
export function pruneSessionHistory(sess: Session): number {
    const callMeta = _callMetaMap(sess.deriveMessages());
    // tool/result events in surface (message) order; pos is the surface position.
    const results: Array<{ pos: number; seq: number; d: any; meta: _CallMeta }> = [];
    sess.surface.forEach((seq, pos) => {
        const ev = sess.events[seq];
        if (ev?.type !== 'tool/result') return;
        const d = ev.data as any;
        const meta = callMeta.get(d.callId);
        if (meta) results.push({ pos, seq, d, meta });
    });
    let saved = 0;
    for (const { pos, seq, d, meta } of results) {
        if (!_PRUNE_READ_TOOLS.has(meta.name) || !meta.path) continue;
        const cl = _clen(d.content); if (cl < _PRUNE_MIN_CHARS) continue;
        if (!_readCovered(pos, meta, results)) continue;
        if ((d.content as string)?.startsWith('[pruned:')) continue; // already pruned
        const prunedContent = `[pruned: dup read "${meta.path}", ${cl} chars]`;
        pruneSurface(sess, seq, d.callId, meta.name, d.turn ?? 0, d.step ?? 0, prunedContent);
        saved += cl;
        const pNorm = _normPath(meta.path);
        for (const key of _seenReadFiles.keys())
            if (key.startsWith(pNorm + ':')) _seenReadFiles.set(key, 'pruned');
    }
    return saved;
}

// ── History repair ───────────────────────────────────────────────────────────
// Strict providers (Mistral, Devstral) reject histories with null entries, orphaned
// tool results, tool blocks not preceded by their assistant message, or assistant
// tool_calls without responses. Repair removes the broken structures.

// Single implementation operating on any history array. Mutates in place where
// possible and RETURNS the (possibly re-created) array — callers must use the
// return value. The global-history wrapper below feeds it openaiHistory.
export function repairHistoryArray(hist: any[]): any[] {
    // Purge any null/undefined entries that can creep in via provider conversions.
    // They must be removed before the API call, not just skipped, or they serialize as null.
    hist = hist.filter(m => m != null);

    // Strip any trailing tool-result messages whose tool_call_ids may be
    // orphaned (e.g. after a model switch mid-step or after compaction).
    while (hist.length && hist[hist.length - 1].role === 'tool') hist.pop();
    // Remove a trailing assistant message that declared tool_calls but
    // whose results were just stripped (or never arrived).
    const last = hist[hist.length - 1];
    if (last?.role === 'assistant' && last.tool_calls?.length) hist.pop();

    // Verify each assistant+tool_calls turn has exactly one matching tool response per id.
    // Remove whole turns where the tool_call/response pairing is broken.
    const answeredIds = new Set(hist.filter(m => m?.role === 'tool').map(m => m.tool_call_id));
    for (let i = hist.length - 1; i >= 0; i--) {
        const m = hist[i];
        if (!m || m.role !== 'assistant' || !m.tool_calls?.length) continue;
        const missing = m.tool_calls.some(tc => !answeredIds.has(tc.id));
        if (missing) {
            // Remove this assistant message and any immediately following tool messages
            let end = i + 1;
            while (end < hist.length && hist[end].role === 'tool') end++;
            hist.splice(i, end - i);
        }
    }

    // Full-history pass: remove ANY tool message not immediately preceded by
    // an assistant message that declared its tool_call_id. This catches the
    // case where a sliding-window or compaction trim left a user-nudge message
    // between an assistant turn and its tool results, producing the sequence
    // [..., user, tool] which Mistral rejects with "Unexpected role 'tool'
    // after role 'user'". Scan backwards so splice indices stay valid.
    const declaredIds = new Set(
        hist
            .filter(m => m?.role === 'assistant' && m.tool_calls?.length)
            .flatMap(m => m.tool_calls.map(tc => tc.id))
    );
    for (let i = hist.length - 1; i >= 0; i--) {
        const m = hist[i];
        if (!m || m.role !== 'tool') continue;
        if (!declaredIds.has(m.tool_call_id)) {
            // Orphaned tool result — remove this block and its preceding assistant msg.
            let start = i;
            while (start > 0 && hist[start - 1].role === 'tool') start--;
            if (start > 0 && hist[start - 1].role === 'assistant' && hist[start - 1].tool_calls?.length) start--;
            hist.splice(start, i - start + 1);
            i = start;
            continue;
        }
        // tool_call_id is declared — but verify the immediately preceding message
        // is either another tool or the assistant that owns these tool_calls.
        // If it's a user message, remove all tool messages in this block.
        let blockStart = i;
        while (blockStart > 0 && hist[blockStart - 1].role === 'tool') blockStart--;
        const prev = hist[blockStart - 1];
        if (prev && prev.role !== 'assistant') {
            // Tool block is not preceded by its assistant message — remove it.
            let removeStart = blockStart;
            if (removeStart > 0 && hist[removeStart - 1].role === 'assistant' && hist[removeStart - 1].tool_calls?.length) removeStart--;
            hist.splice(removeStart, i - removeStart + 1);
            i = removeStart;
        }
    }
    // Strip <think>/<thinking> tags from stored tool results so they don't leak
    // into the API request or prime the model to emit similar tags in its output.
    // (_stripThinking lives in llm-shared; guard for bare test environments.)
    if (typeof _stripThinking === 'function') {
        for (let i = 0; i < hist.length; i++) {
            const m = hist[i];
            if (m?.role === 'tool' && typeof m.content === 'string' && /<think/i.test(m.content)) {
                hist[i] = { ...m, content: _stripThinking(m.content) };
            }
            if (m?.role === 'assistant' && typeof m.content === 'string' && /<think/i.test(m.content)) {
                hist[i] = { ...m, content: _stripThinking(m.content) };
            }
        }
    }
    return hist;
}

// Repairs the global openaiHistory in place (the main loop's canonical history).
export function repairOAIHistory(): void {
    setOpenaiHistory(repairHistoryArray(openaiHistory));
}

// Window bridge for free-variable access from sibling modules (house pattern).
Object.assign(window, {
    _normPath, resetSeenReadFiles, _invalidateReadDedup,
    _historyResult, truncateResultForHistory,
    pruneOAIHistory, pruneSessionHistory, repairHistoryArray, repairOAIHistory,
});
