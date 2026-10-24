// history.ts — FreeGent: conversation-history hygiene.
//
// Owns everything about what tool results become in history and how the history
// stays valid and lean:
//   - truncateResultForHistory / _historyResult / _summarizeToolResult /
//     _extractCodeBlocks — result → history representation (size caps, dedup notes,
//     structural code extraction for the Director)
//   - pruneSessionHistory — masks stale duplicate reads ([pruned: …] stubs) and marks
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
    activeChatId,
} from './state.js';
import { getChatHistory, setChatHistory } from './chat-history.js';
import { WORKSPACE_WRITE_TOOLS } from './tool-effects.js';
import type { Session } from './session.js';
import { pruneSurface } from './session.js';

// Normalize path for deduplication: strip leading "local/" so that "local/foo.md" and
// "foo.md" are treated as the same file (the server serves both from the same store).
export function _normPath(p: string): string { return (p || '').replace(/^local\//, ''); }

export function resetSeenReadFiles(): void { setSeenReadFiles(new Map()); setSeenListFiles(new Set()); }

// Cheap content fingerprint (FNV-1a over UTF-16 code units, plus length) for read dedup.
function _contentHash(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return `${s.length}:${(h >>> 0).toString(36)}`;
}

export function _invalidateReadDedup(path: string): void {
    const norm = _normPath(path);
    for (const key of _seenReadFiles.keys())
        if (key.startsWith(norm + ':')) _seenReadFiles.delete(key);
    // Evict list-file dedup for any ancestor directory of the changed file so a
    // subsequent list_files sees the new/deleted file rather than the stale cached note.
    const dir = norm.replace(/[^/]+$/, ''); // 'foo/bar.py' → 'foo/'
    for (const key of [..._seenListFiles]) {
        const k = String(key).split('\u0000')[0];   // "<path>\0<listing hash>"
        const kDir = k.endsWith('/') ? k : k ? k + '/' : '';
        if (!k || dir === kDir || dir.startsWith(kDir)) _seenListFiles.delete(key);
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
        return { ...result, path, start_line: startLine, content: full.length <= threshold
            ? full
            : full.slice(0, threshold) + `\n[…truncated. Use start_line/end_line to read a smaller section.]` };
    }
    if (omitted.length) {
        out += `[Omitted ${omitted.length} block(s): ${omitted.join('; ')}. Re-read with start_line/end_line.]`;
    }

    return { ...result, path, start_line: startLine, content: out };   // the rest of the result (end_line, ...) stays: the read bookkeeping keys on end_line (hermes C15)
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

// A run_workers result had no size limit in history: its path lists (each worker's `wrote`, and
// `applied`, which repeats them) reached 128K chars in one result, more than the context window,
// and compaction could not drop it (TerminalBench v0.66 sanitize-git-repo). Long path lists keep
// their first entries and a count; if the result is still over the limit, the per-worker tool-call
// lists go, then the longest texts are cut.
const _WORKER_PATHS_SHOWN = 30;
function _capWorkerResult(result: any, limit: number): any {
    const size = (v: any) => { try { return JSON.stringify(v)?.length ?? 0; } catch { return 0; } };
    if (!result || typeof result !== 'object' || size(result) <= Math.min(limit, 8000)) return result;
    const capList = (v: any) => Array.isArray(v) && v.length > _WORKER_PATHS_SHOWN
        ? [...v.slice(0, _WORKER_PATHS_SHOWN), `… and ${v.length - _WORKER_PATHS_SHOWN} more (${v.length} in total)`] : v;
    let out: any = { ...result };
    for (const k of ['applied', 'incomplete', 'conflictsFound', 'conflictsResolved', 'blocked']) if (k in out) out[k] = capList(out[k]);
    if (Array.isArray(out.agents)) out.agents = out.agents.map((a: any) => a && typeof a === 'object' ? { ...a, wrote: capList(a.wrote) } : a);
    if (size(out) <= limit) return out;
    if (Array.isArray(out.agents)) out.agents = out.agents.map((a: any) => { if (!a?.toolCalls) return a; const { toolCalls, ...rest } = a; return rest; });
    for (let i = 0; i < 20 && size(out) > limit; i++) {
        // Cut the longest remaining string (a worker note, the output, an incomplete file's content) by half.
        let best: { o: any; k: string; n: number } | null = null;
        const walk = (o: any, depth: number) => {
            if (!o || typeof o !== 'object' || depth > 4) return;
            for (const k of Object.keys(o)) {
                const v = o[k];
                if (typeof v === 'string') { if (!best || v.length > best.n) best = { o, k, n: v.length }; }
                else if (v && typeof v === 'object') { o[k] = Array.isArray(v) ? [...v] : { ...v }; walk(o[k], depth + 1); }
            }
        };
        walk(out, 0);
        if (!best || (best as any).n < 400) break;
        const b = best as { o: any; k: string; n: number };
        b.o[b.k] = `${b.o[b.k].slice(0, Math.floor(b.n / 2))}\n[…${b.n - Math.floor(b.n / 2)} chars not shown]`;
    }
    // Still over: many individually short entries. Counts replace the lists, then the text is cut to the limit.
    if (size(out) > limit) {
        const brief = (v: any): any => {
            if (typeof v === 'string') return v.length > 200 ? `${v.slice(0, 200)}…` : v;
            if (Array.isArray(v)) return { count: v.length, first: v.slice(0, 3).map(x => typeof x === 'string' ? brief(x) : '…') };
            return v;
        };
        const compact: any = {};
        for (const k of Object.keys(out)) {
            if (k === 'agents' && Array.isArray(out.agents)) compact.agents = out.agents.map((a: any) => a && typeof a === 'object'
                ? { ...(a.id !== undefined ? { id: a.id } : {}), ...(a.role !== undefined ? { role: a.role } : {}), ...(a.status !== undefined ? { status: a.status } : {}), wrote: Array.isArray(a.wrote) ? a.wrote.length : a.wrote }
                : brief(a));
            else compact[k] = brief(out[k]);
        }
        compact.truncated = true;
        out = compact;
        if (size(out) > limit) {
            const text = JSON.stringify(out);
            out = limit > 120 ? { truncated: true, summary: `${text.slice(0, limit - 60)}…` } : { truncated: true, note: 'worker result not shown (no room left in this step)' };
        }
    }
    return out;
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
    // The main agent has its own cap ("Max result size — main agent", 0 = no cap); the worker setting used to decide for both, so the main
    // agent's setting capped nothing but the block extraction of read_file (opencode §15).
    const _directorCap = isDirector && typeof getDirectorMaxToolResult === 'function' ? getDirectorMaxToolResult() : null;
    const configLimit = _directorCap !== null ? (_directorCap > 0 ? _directorCap : Infinity) : getAgentMaxToolResult();
    // What a result keeps is charged to the step's budget, whichever tool made it: results that were free let one step's mixed batch
    // hold far more than the budget (a repository map, a research report and stderr cost nothing: codex R42-001).
    const charge = (n: number) => { if (stepBudget) stepBudget.remaining = Math.max(0, stepBudget.remaining - Math.max(0, n)); };
    // Per-result limit: min of configLimit and remaining step budget (if tracking).
    const limit = stepBudget ? Math.min(configLimit, Math.max(0, stepBudget.remaining)) : configLimit;
    const _rf = seenReadFiles ?? _seenReadFiles;
    const _lf = seenListFiles ?? _seenListFiles;

    if (name.startsWith('browser_')) {
        let text: string;
        try { text = JSON.stringify(result) ?? ''; } catch { text = String(result); }   // BigInt or a cycle must not throw out of truncation
        const kept = text.length > limit ? { url: result?.url, observation: text.slice(0, limit), truncated: true } : result;
        if (stepBudget) stepBudget.remaining = Math.max(0, stepBudget.remaining - Math.min(text.length, limit));
        return kept;
    }

    if (name === 'list_files') {
        // Deduplicate list_files: if we already listed this exact path this turn, suppress the result.
        // Use the original requested path (result.path) as key — don't normalise, since "" and "local"
        // can return different data (IDB vs FSA) even though they share the same normalised prefix.
        // Only while the listing is unchanged: files made or removed since (bash, Python, another
        // worker) must show — answering "already listed" sent the model back to a stale list.
        // The key holds a hash of the names and sizes; a different listing replaces it.
        const prefix = result.path ?? '';
        const key = `${prefix}\u0000${_contentHash(JSON.stringify((result.files ?? []).map((f: any) => [f?.name ?? f, f?.size ?? null])))}`;
        if (_lf.has(key)) {
            return { note: `Already listed "${prefix}" this session, and nothing has changed since — results are in your prior tool results.` };
        }
        for (const k of [..._lf]) if (k === prefix || k.startsWith(prefix + '\u0000')) _lf.delete(k);
        _lf.add(key);
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
        const rangeKey   = `${pathNorm}:${result.start_line||''}:${result.end_line||''}`;
        // Outside the `${pathNorm}:` prefix, which the pruners rewrite to 'pruned'.
        const hashKey    = `__hash__:${rangeKey}`;
        // Suppression is only safe when the content is what the model already has. Edits made
        // through write_file/replace_in_file invalidate explicitly, but shell edits (sed -i in
        // WASM bash, Pyodide, nativeExec) cannot be tracked per file — a hash of the fresh read
        // catches them all. Before this, a read after `sed -i` was answered "Already read" and
        // the model reasoned from the pre-edit copy (fg-chat 2026-09-27-01-29-29).
        const contentHash = typeof result.content === 'string' ? _contentHash(result.content) : null;
        const changed = contentHash !== null && _rf.has(hashKey) && _rf.get(hashKey) !== contentHash;
        if (changed) {
            for (const k of [..._rf.keys()]) if (k.startsWith(pathNorm + ':')) _rf.delete(k);
        }
        const readCount  = (_rf.get(countKey) as number) ?? 0;
        if (readCount >= 6) {
            return { path: result.path, note: `Already read "${result.path}" ${readCount} times this session — content is in your prior tool results.` };
        }

        // Suppress duplicate read of the same range whose content is still in history
        // (not yet pruned) and unchanged. pruneSessionHistory sets 'pruned' so post-prune
        // re-reads serve content again (never starve the model).
        // Only a read that showed everything is "already read". One that was cut is not: the model asking for the same range again wants what
        // was left out, and was told the full content was in its history (opencode §14).
        const priorState = _rf.get(rangeKey);
        if (priorState === 'full') {
            return { path: result.path, note: `Already read "${result.path}" — the full content is in your prior tool result for this file. Read a different range if you need other sections.` };
        }

        // Track read state for pruneSessionHistory & dedup check above.
        const contentLen = typeof result.content === 'string' ? result.content.length : 0;
        _rf.set(rangeKey, contentLen > limit ? 'truncated' : 'full');
        if (contentHash !== null) _rf.set(hashKey, contentHash);
        // Only count full (unranged) reads — ranged reads are targeted navigation and should not be capped.
        if (!result.start_line && !result.end_line) _rf.set(countKey, readCount + 1);
    }

    const strField = { read_file:'content', execute_code:'stdout' }[name];
    if (strField) {
        const val = result[strField];
        const effectiveLen = val?.length ?? 0;
        if (typeof val === 'string' && effectiveLen > limit) {
            const truncated = val.slice(0, limit);
            charge(truncated.length);
            if (name === 'read_file') {
                const startLine = result.start_line || 1;
                const shownLines = (truncated.match(/\n/g) || []).length + 1;
                const totalLines = (val.match(/\n/g) || []).length + 1;
                const shownEnd = startLine + shownLines - 1;
                const totalEnd = startLine + totalLines - 1;
                const _remaining = totalEnd - shownEnd;
                // Cut inside the last line (a one-line file, a very long line): there are no further lines to point at, and "lines 2–1" is nonsense.
                if (_remaining <= 0) return { ...result, [strField]: truncated + `\n[…${effectiveLen - limit} more characters of line ${shownEnd} not shown]` };
                const _hint = _remaining > 500
                    ? `use start_line/end_line to read a specific range`
                    : `use start_line=${shownEnd + 1} to read more`;
                return { ...result, [strField]: truncated + `\n[…lines ${shownEnd + 1}–${totalEnd} not shown — ${_hint}]` };
            }
            const out = { ...result, [strField]: truncated + `\n[…${effectiveLen - limit} chars not shown]` };
            // stderr has its own cap below, which this return used to skip.
            if (typeof out.stderr === 'string' && out.stderr.length > limit)
                out.stderr = out.stderr.slice(0, limit) + `\n[…${out.stderr.length - limit} chars not shown]`;
            if (typeof out.stderr === 'string') charge(out.stderr.length);
            return out;
        }
        charge(effectiveLen);
    }
    if (name === 'execute_code' && typeof result.stderr === 'string') {
        if (result.stderr.length > limit) {
            charge(limit);
            return { ...result, stderr: result.stderr.slice(0, limit) + `\n[…${result.stderr.length - limit} chars not shown]` };
        }
        charge(result.stderr.length);
    }

    if (name === 'web_search' && Array.isArray(result.results)) {
        if (JSON.stringify(result).length > limit) {
            return { ...result, results: result.results.map(r => ({
                title: r.title, url: r.url,
                snippet: (r.snippet || r.summary || '').slice(0, 250),
            })) };
        }
    }

    if (name === 'run_workers') {
        if (result.warning && !(result.incomplete?.length)) { const { warning, ...rest } = result; result = rest; }
        const capped = _capWorkerResult(result, limit);
        // Like every other result in the step, what is kept counts against the step's budget.
        if (stepBudget) { try { stepBudget.remaining -= JSON.stringify(capped)?.length ?? 0; } catch {} }
        return capped;
    }

    if (name === 'repo_map' && typeof result.map === 'string') {
        charge(Math.min(result.map.length, limit));
        if (result.map.length > limit) return { ...result, map: result.map.slice(0, limit) + `\n[…truncated, ${result.files_mapped} files total]` };
        return result;
    }

    if (name.startsWith('mcp__') && typeof result.content === 'string') {
        charge(Math.min(result.content.length, limit));
        if (result.content.length > limit) return { ...result, content: result.content.slice(0, limit) + `\n[…${result.content.length - limit} chars not shown]` };
        return result;
    }

    if (name === 'search_workspace' && Array.isArray(result.matches)) {
        const joined = result.matches.join('\n---\n');
        charge(Math.min(joined.length, limit));
        if (joined.length > limit) {
            const truncated = joined.slice(0, limit);
            const matches = truncated.split('\n---\n');
            return { ...result, matches, note: `Truncated to ${matches.length} of ${result.matches.length} matches.` };
        }
    }

    // Any other tool (context7_docs, deep_research, check_page, run_git, academic_search, an MCP
    // result that is not a single string, a tool added later): bounded by the configured limit, so
    // no single result can exceed it. Handler-side caps normally keep these far below it.
    // With the step's budget in play the cap is what is left of it (never below a floor: a result is cut, not dropped), and what is kept is charged.
    const capped = _capAnyResult(result, stepBudget ? Math.min(configLimit, Math.max(limit, GENERIC_RESULT_FLOOR)) : configLimit);
    if (stepBudget) { try { charge(JSON.stringify(capped)?.length ?? 0); } catch {} }
    return capped;
}
const GENERIC_RESULT_FLOOR = 2000;

// Bound a result of any shape: the longest strings are cut in half until it fits; a result that
// is still too large (many short entries) is replaced by the start of its JSON.
export function _capAnyResult(result: any, limit: number): any {
    const size = (v: any) => { try { return JSON.stringify(v)?.length ?? 0; } catch { return 0; } };
    if (!result || typeof result !== 'object' || !(limit > 0) || size(result) <= limit) return result;
    let out: any = Array.isArray(result) ? [...result] : { ...result };
    for (let i = 0; i < 20 && size(out) > limit; i++) {
        let best: { o: any; k: string; n: number } | null = null;
        const walk = (o: any, depth: number) => {
            if (!o || typeof o !== 'object' || depth > 4) return;
            for (const k of Object.keys(o)) {
                const v = o[k];
                if (typeof v === 'string') { if (!best || v.length > best.n) best = { o, k, n: v.length }; }
                else if (v && typeof v === 'object') { o[k] = Array.isArray(v) ? [...v] : { ...v }; walk(o[k], depth + 1); }
            }
        };
        walk(out, 0);
        if (!best || (best as any).n < 400) break;
        const b = best as { o: any; k: string; n: number };
        // Cut by what is over the limit (plus room for the note and JSON escaping), not by half:
        // a result slightly over the limit should lose slightly more than the excess.
        const keep = Math.max(200, Math.min(b.n - 1, b.n - (size(out) - limit) - 80));
        b.o[b.k] = `${b.o[b.k].slice(0, keep)}\n[…${b.n - keep} chars not shown]`;
    }
    if (size(out) > limit) {
        const text = JSON.stringify(out);
        // Whether the tool succeeded is not data volume: the status fields stay outside the excerpt, so a cut-off result of a failed tool still says it failed (codex R55).
        const meta: Record<string, any> = {};
        if (!Array.isArray(result)) for (const k of ['error', 'success', 'ok', 'status', 'exit_code', 'signal', 'warning']) {
            const v = (result as any)[k];
            if (v !== undefined && (v === null || typeof v !== 'object')) meta[k] = typeof v === 'string' ? v.slice(0, 500) : v;
        }
        out = { truncated: true, ...meta, content: `${text.slice(0, limit)}\n[…${text.length - limit} chars not shown]` };
    }
    return out;
}

// ── History pruning ──────────────────────────────────────────────────────────
// Removes stale/duplicate file read results in-place. No LLM call — pure heuristic.
// Duplicate read: a later read of the same file covers this read's line range, with no write to
// the file in between → stub this one. Reads separated by a write are kept (pre-edit state).

const _PRUNE_READ_TOOLS  = new Set(['read_file']);
// undo_write changes the file too: a read before it is not a copy of what is there now.
const _PRUNE_WRITE_TOOLS = new Set<string>(WORKSPACE_WRITE_TOOLS);
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
// Returns the covering read's meta, or null.
// The covering read must hold the lines: a later "Already read" note, refusal or pruned stub does not
// (v0.59 xarray-6744: full copies were pruned in favour of "Already read" notes, so the window was in
// no result at all and the model re-read it ~40 times).
// Whether a retained read_file result holds the lines it was asked for. The request says what was asked, not what was kept: a whole-file read returns only the first
// lines inline, and history clipping cuts a long result (codex R62). A result that was cut is not a copy of the range.
function _retainsRange(content: any, meta: _CallMeta): boolean {
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    if (/\[…\d+ chars not shown\]|chars not shown\]|"truncated":\s*true/.test(text)) return false;
    try {
        const j = JSON.parse(text.replace(/^\[[^\]]*\]\n/, ''));
        if (j && typeof j === 'object') {
            if (j.truncated) return false;
            if (typeof j.content === 'string' && typeof j.length === 'number') {
                const whole = meta.from <= 1 && meta.to === Infinity && !j.start_line && !j.end_line;
                if (whole && j.content.length < j.length) return false;   // only part of the file came back
            }
        }
    } catch { /* not JSON: judged by the markers above */ }
    return true;
}

function _readCovered(pos: number, meta: _CallMeta, results: Array<{ pos: number; meta: _CallMeta; content?: any }>): _CallMeta | null {
    for (const r of results) {
        if (r.pos <= pos || r.meta.path !== meta.path) continue;
        if (_PRUNE_WRITE_TOOLS.has(r.meta.name)) return null;   // file changed before any covering read
        if (_PRUNE_READ_TOOLS.has(r.meta.name) && r.meta.from <= meta.from && r.meta.to >= meta.to
            && _clen(r.content) >= _PRUNE_MIN_CHARS && !String(r.content).startsWith('[') && _retainsRange(r.content, r.meta)) return r.meta;
    }
    return null;
}

const _rangeLabel = (m: _CallMeta) => (m.from <= 1 && m.to === Infinity) ? 'whole file' : `lines ${m.from}–${m.to === Infinity ? 'end' : m.to}`;

// Stub for a pruned read. It names where the lines are now: a bare "[pruned: dup read …]" read as
// "content lost", and the model re-read the range — which pruned the overlapping reads in turn,
// so it cycled through ~6 ranges of one file for 88 steps (SWE-bench Lite v0.55 sympy-18189).
function _prunedReadStub(meta: _CallMeta, cover: _CallMeta, chars: number): string {
    return `[pruned: dup read "${meta.path}" (${_rangeLabel(meta)}), ${chars} chars — these lines are in a later read_file result of the same file (${_rangeLabel(cover)}). Do not read them again; use that result.]`;
}

/**
 * Duplicate-read pruning on the session event log, via pruneSurface(): an earlier read_file result
 * that a later read of the same file covers is replaced by a stub that names the covering read.
 */
export function pruneSessionHistory(sess: Session): number {
    const callMeta = _callMetaMap(sess.deriveMessages());
    // tool/result events in surface (message) order; pos is the surface position.
    const results: Array<{ pos: number; seq: number; d: any; meta: _CallMeta; content: any }> = [];
    sess.surface.forEach((seq, pos) => {
        const ev = sess.events[seq];
        if (ev?.type !== 'tool/result') return;
        const d = ev.data as any;
        const meta = callMeta.get(d.callId);
        if (meta) results.push({ pos, seq, d, meta, content: d.content });
    });
    let saved = 0;
    for (const { pos, seq, d, meta } of results) {
        if (!_PRUNE_READ_TOOLS.has(meta.name) || !meta.path) continue;
        const cl = _clen(d.content); if (cl < _PRUNE_MIN_CHARS) continue;
        const cover = _readCovered(pos, meta, results);
        if (!cover) continue;
        if ((d.content as string)?.startsWith('[pruned:')) continue; // already pruned
        const prunedContent = _prunedReadStub(meta, cover, cl);
        pruneSurface(sess, seq, d.callId, meta.name, d.turn ?? 0, d.step ?? 0, prunedContent);
        saved += cl;
        const pNorm = _normPath(meta.path);
        for (const key of _seenReadFiles.keys())
            if (key.startsWith(pNorm + ':') && !key.endsWith('::__count__')) _seenReadFiles.set(key, 'pruned');   // the per-file read counter is not a range (opencode §24)
    }
    return saved;
}

// ── History repair ───────────────────────────────────────────────────────────
// Strict providers (Mistral, Devstral) reject histories with null entries, orphaned
// tool results, tool blocks not preceded by their assistant message, or assistant
// tool_calls without responses. Repair removes the broken structures.

// Single implementation operating on any history array. Mutates in place where
// possible and RETURNS the (possibly re-created) array — callers must use the
// return value. The wrapper below feeds it the active chat's history.
export function repairHistoryArray(hist: any[]): any[] {
    // Purge any null/undefined entries that can creep in via provider conversions.
    // They must be removed before the API call, not just skipped, or they serialize as null.
    hist = hist.filter(m => m != null);

    // A tool call and its results are one block: an assistant message with tool_calls, followed at once by exactly one tool message per call id.
    // Each block is checked as such (not by sets over the whole history, which let a result stand under the wrong assistant, or twice), and a block
    // that is whole stays wherever it is. The old pass stripped every trailing tool message "because it might be orphaned": after a hard stop (no
    // closing line is written) that erased all the completed steps at the end of the turn (hermes C14), and its later passes left unanswered calls
    // and misattached or doubled results behind (codex R11-001).
    const repaired: any[] = [];
    for (let i = 0; i < hist.length;) {
        const m = hist[i];
        if (m.role === 'assistant' && m.tool_calls?.length) {
            let j = i + 1;
            const first = new Map<string, any>();                     // call id → the first tool message that answers it in this block
            while (j < hist.length && hist[j].role === 'tool') { if (!first.has(hist[j].tool_call_id)) first.set(hist[j].tool_call_id, hist[j]); j++; }
            if (m.tool_calls.every((tc: any) => first.has(tc.id))) {
                repaired.push(m);
                const done = new Set<string>();
                for (const tc of m.tool_calls) if (!done.has(tc.id)) { done.add(tc.id); repaired.push(first.get(tc.id)); }
            }
            // else: calls without all their results (interrupted, or separated from them): the whole block goes; so do its leftover results
            i = j;
        } else if (m.role === 'tool') {
            i++;                                                      // a result that does not follow its own assistant message
        } else { repaired.push(m); i++; }
    }
    hist = repaired;
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

// Repairs the active chat's history (the main loop's canonical history). The chat's Session is
// only replaced when the repair changed something.
export function repairOAIHistory(): void {
    const before = getChatHistory();
    const after  = repairHistoryArray(before.slice());
    if (JSON.stringify(after) !== JSON.stringify(before)) setChatHistory(after);
}

// Window bridge for free-variable access from sibling modules (house pattern).
Object.assign(window, {
    _normPath, resetSeenReadFiles, _invalidateReadDedup,
    _historyResult, truncateResultForHistory,
    pruneSessionHistory, repairHistoryArray, repairOAIHistory,
});
