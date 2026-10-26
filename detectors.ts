// detectors.ts — FreeGent: loop-health detectors shared by the main turn loop and workers.
//
// Detection is a pure-ish decision layer: functions take the loop's counters/state,
// return updated counters plus a nudge message (or null) — they never touch history,
// DOM, or logs. Callers apply the effect (emitNudge / retry / fallback).
//
// Both runTurn (llm-loops.ts) and runWorkerTurn (workers.ts) run these on every step.
// They previously lived inside llm-loops.ts; workers reached them through the window
// bridge, and the two call sites had already started to drift (workers fingerprinted
// results without _fpTrunc). One module, one behavior.
//
// seen: optional {rf, lf} read/list dedup maps to evict — workers pass their local maps
// to keep dedup state isolated from the main loop; omitted → the state.js globals.
//
// Follows the step-validator/nudge-emitter/payload-builder pattern: ES module, exports,
// window bridge.

import { shellWrites } from './shell-writes.js';
import { isCheckCommand } from './verification.js';
import { runtime } from './runtime.js';
import { _degenerateTail } from './stream-decode.js';

import { _seenReadFiles, _seenListFiles } from './state.js';

// ── Result fingerprinting ────────────────────────────────────────────────────
// Long strings are collapsed to head + full-content hash + tail + length so identical
// results compare equal cheaply while ANY single-char difference (head, middle, or tail)
// still produces a distinct fingerprint. (A sampled hash collided on middle diffs —
// hash every char.)

export function _fpHash(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
}

// JSON.stringify replacer: use as JSON.stringify(value, _fpTrunc).
export function _fpTrunc(k: string, v: any): any {
    return (typeof v === 'string' && v.length > 512)
        ? `${v.slice(0, 128)}#${_fpHash(v)}#${v.slice(-64)}#len${v.length}`
        : v;
}

// ── Stuck-result detection ───────────────────────────────────────────────────
// Advice per repeated tool. v0.54: 454 of 467 main-loop stuck nudges were for execute_code,
// which got the read/search advice below ('' = default).
const _BLOCKED_TAIL = ' If genuinely stuck, declare BLOCKED: <exact reason> — do not declare COMPLETED without a verified answer.';
const _STUCK_MSGS: Record<string, string> = {
    write_file:   'Your last 3 write_file calls wrote identical byte counts — the file was not changed. Read the current file with read_file before writing again.',
    execute_code: 'Your last 3 execute_code calls produced identical results — running the same command again will not change the outcome. If that output already answers the task, give the answer now. Otherwise change the command, or first find out why nothing changes (check logs, process state, file contents, error output).' + _BLOCKED_TAIL,
    fetch_url:    'Your last 3 fetch_url calls returned identical responses — the same request will keep returning the same thing. Change the URL, method, parameters or body, or use a different endpoint.' + _BLOCKED_TAIL,
    run_workers:  'Your last 3 run_workers calls returned identical results — delegating the same task again will not help. Do the step yourself, or give the workers a different, more specific task.' + _BLOCKED_TAIL,
    '':           'Your last 3 steps produced identical results. Try a different approach: use start_line/end_line to read a specific section, or search_workspace with a literal string from the error message or function name to find the right file. Do not search by filename — search by content.' + _BLOCKED_TAIL,
};
// Three *different* execute_code calls with the same output: the probes aren't telling the cases
// apart. The same-command wording was wrong there — v0.60 pylint-7993 got it 16 times while varying
// a regex whose every version printed `[]`, and never edited the file. But the code-edit advice that
// fixed that was wrong for API tasks: in v0.61 17 of 29 TAC transcripts (and 10 AutomationBench
// runs) got "make the change in the code itself, or give your answer" while their requests kept
// returning the same page, and the tasks that got it most lost points. Same trigger, wording that
// holds for both kinds of work.
export const STUCK_SAME_OUTPUT_MSG = 'Your last 3 execute_code calls were different but all printed the same output — these variations are not distinguishing anything. Read that output literally and change what you are asking for: for a request, the URL, method, headers or payload; for code, the code itself or the file you are editing. Do not send another variation of the same probe.' + _BLOCKED_TAIL;
// The repeated output is a web page, not data: the request is reaching the wrong thing (a UI
// route, a login page, a proxy error), and no rewording of the body or query will change that.
export const STUCK_SAME_HTML_MSG = 'Your last 3 execute_code calls were different but all printed the same HTML web page, not data. The address you are requesting is serving a web page (a UI route, login page or error page), so changing the body or query will not help. Check the exact URL: host, port, path (is there an /api/ prefix or a different endpoint for this operation?), method and Accept/content-type headers — and print the status code and Content-Type before parsing. Do not re-parse this page.' + _BLOCKED_TAIL;
const _HTML_PAGE_RE = /^\s*(?:<!doctype html|<html[\s>])/i;
export function sameOutputMsg(outputs: string[]): string {
    return outputs.length && outputs.every(o => _HTML_PAGE_RE.test(String(o ?? ''))) ? STUCK_SAME_HTML_MSG : STUCK_SAME_OUTPUT_MSG;
}
// Maintains a rolling window of the last 3 result fingerprints; when all 3 match,
// evicts read caches (targeted by path when possible) and returns a stuck nudge.
// Returns {resultHashes, stuckMsg} — caller must reassign resultHashes.
export function _updateStuckDetector(resSig: string, stalledPaths: Set<string>, resultHashes: string[], seen: any = null) {
    const _rf = seen ? seen.rf : _seenReadFiles;
    const _lf = seen ? seen.lf : _seenListFiles;
    resultHashes = [...resultHashes, resSig];
    if (resultHashes.length > 3) resultHashes = resultHashes.slice(1);
    if (resultHashes.length === 3 && resultHashes.every(h => h === resultHashes[0])) {
        resultHashes = [];
        if (stalledPaths.size) {
            for (const key of [..._rf.keys()])
                if (stalledPaths.has(key.split(':')[0])) _rf.delete(key);
            for (const key of [..._lf]) {
                const p = String(key).split('\u0000')[0];   // "<path>\0<listing hash>" (history.ts)
                if (stalledPaths.has(typeof _normPath === 'function' ? _normPath(p) : p)) _lf.delete(key);
            }
        }
        // else: stuck on non-read calls (execute_code etc.) — don't clear the read cache;
        // doing so doesn't help and forces redundant re-reads of already-seen files.
        let _stuckTool = '';
        try { _stuckTool = (JSON.parse(resSig)?.[0]?.n ?? ''); } catch {}
        const stuckMsg = _STUCK_MSGS[_stuckTool] ?? _STUCK_MSGS[''];
        return { resultHashes, stuckMsg };
    }
    return { resultHashes, stuckMsg: null };
}

// ── Repeat guard ─────────────────────────────────────────────────────────────
// Steps making the same tool call(s) with the same result — digits ignored, since PIDs, timestamps
// and request IDs change between otherwise identical runs. Once a call has returned the same result
// REPEAT_LIMIT times within the last REPEAT_WINDOW steps, the next identical call is refused instead
// of executed. v0.54: 9 tasks looped like this (e.g. `ps aux | grep postgres` 72 times). Counted in a
// window, not a streak: v0.55 OS task 38 slipped one variant (`ls -ld`) between runs of `ls -l`,
// which reset a streak each time. Refusals accumulate over the turn for the same reason.
export const REPEAT_LIMIT = 8;
export const REPEAT_WINDOW = 12;
// recentPaths: the same steps keyed by endpoint instead of exact call (see _pathSig).
// tried / seen: hashes of every call and every result of the turn (see _pathEscapeAvailable and
// _creditProgress); pathEscapes: untried-query probes already let through per endpoint; credits:
// refusals already forgiven for progress.
type RepeatGuard = {
    recent: Array<[callSig: string, resSig: string]>; refused: number;
    recentPaths?: Array<[pathSig: string, resSig: string]>;
    tried?: number[]; seen?: number[]; pathEscapes?: Record<string, number>; credits?: number;
};
const _TURN_HISTORY = 500;   // bound on tried / seen
export const newRepeatGuard = (): RepeatGuard => ({ recent: [], refused: 0 });

// The text of a shell/Python call as far as repeating it is concerned: comment-only lines, blank lines and
// indentation do not make it a different call. DSAEval 5290 and CTF 71 (v0.70) re-ran the same find/ls/grep
// probes for dozens of steps with a changed `# comment` line, which kept every one out of the repeat window.
export function _normCode(code: string): string {
    if (runtime.guardOff('call_norm')) return code;
    return code.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).join('\n');
}
export function _callSig(calls: Array<{ name: string; args: any }>): string {
    return JSON.stringify(calls.map(c => {
        const a = c.args ?? {};
        return [c.name, c.name === 'execute_code' && typeof a.code === 'string' ? { ...a, code: _normCode(a.code) } : a];
    }));
}
export function _resultSig(results: Array<{ name: string; result: any }>): string {
    const digitless = (k: string, v: any) => {
        if (typeof v !== 'string') return v;
        const d = v.replace(/\d+/g, '#');
        return d.length > 512 ? `${d.slice(0, 128)}#${_fpHash(d)}#${d.slice(-64)}#len${d.length}` : d;
    };
    return JSON.stringify(results.map(r => ({ n: r.name, res: r.result })), digitless);
}
// Array.prototype.findLast needs Safari 15.4; older iPads throw on it, so search from the end by hand.
function _findLast<T>(a: T[], pred: (x: T) => boolean): T | undefined {
    for (let i = a.length - 1; i >= 0; i--) if (pred(a[i])) return a[i];
    return undefined;
}
// How many recent steps ran this call and got the same result as its latest run.
export function _repeatCount(g: RepeatGuard, callSig: string): number {
    const last = _findLast(g.recent, ([c]) => c === callSig);
    return last ? g.recent.filter(([c, r]) => c === callSig && r === last[1]).length : 0;
}
export function _repeatRefused(g: RepeatGuard, callSig: string): boolean {
    return _repeatCount(g, callSig) >= REPEAT_LIMIT;
}
// After executing (not after a refusal).
export function _updateRepeatGuard(g: RepeatGuard, callSig: string, resSig: string, pathSig: string | null = null): RepeatGuard {
    const next: RepeatGuard = { ...g, recent: [...g.recent, [callSig, resSig] as [string, string]].slice(-REPEAT_WINDOW) };
    next.tried = [...(g.tried ?? []), _fpHash(callSig)].slice(-_TURN_HISTORY);
    if (pathSig) {
        // An endpoint already at its limit that still executed was let through as an untried-query probe.
        if (_pathRepeatCount(g, pathSig) >= PATH_REPEAT_LIMIT)
            next.pathEscapes = { ...(g.pathEscapes ?? {}), [pathSig]: (g.pathEscapes?.[pathSig] ?? 0) + 1 };
        next.recentPaths = [...(g.recentPaths ?? []), [pathSig, resSig] as [string, string]].slice(-REPEAT_WINDOW);
    }
    return next;
}

// ── Endpoint repeat guard ────────────────────────────────────────────────────
// The exact-call guard above hashes the whole URL, so a model that rewords a query string every time
// (`/search?query=name:checklist` → `name:return` → `get+lead` → …) is never "repeating" — even when
// every reply is byte-identical. v0.61 AutomationBench hr-5075: 97 `/search` calls, 0 `/execute`, 38
// tool_repeat + 12 stuck nudges ignored, 2.6M tokens; 77 tasks that searched over 20 times resolved
// none (the 98 that didn't resolved 15). So GET fetch_url calls are also keyed by method + endpoint
// without the query, and refused once one endpoint has returned the same result PATH_REPEAT_LIMIT
// times in the window. Only GETs: POSTs to one endpoint (/execute) legitimately return alike.
export const PATH_REPEAT_LIMIT = 5;
export function _pathSig(calls: Array<{ name: string; args: any }>): string | null {
    if (calls.length !== 1 || calls[0].name !== 'fetch_url') return null;
    const a = calls[0].args ?? {};
    if (!/^(GET|HEAD)$/i.test(String(a.method ?? 'GET'))) return null;
    try { const u = new URL(String(a.url)); return `GET|${u.origin}${u.pathname}`; } catch { return null; }
}
export function _pathRepeatCount(g: RepeatGuard, pathSig: string | null): number {
    if (!pathSig) return 0;
    const rp = g.recentPaths ?? [];
    const last = _findLast(rp, ([p]) => p === pathSig);
    return last ? rp.filter(([p, r]) => p === pathSig && r === last[1]).length : 0;
}
// Untried-query escape. The endpoint guard ignores the query, so five empty `partnership` searches
// also blocked the first `email` search (AutomationBench simple-3139): the refusal came before the
// server could answer. A call whose exact URL has not been tried this turn is therefore let
// through PATH_NOVEL_ESCAPES times per endpoint. Rewordings of a query already tried, and further
// probes once the allowance is spent, are still refused; a probe that returns something different
// restarts the endpoint's count by itself (_pathRepeatCount compares against the latest result).
export const PATH_NOVEL_ESCAPES = 2;
function _pathEscapeAvailable(g: RepeatGuard, pathSig: string, callSig: string): boolean {
    if ((g.tried ?? []).includes(_fpHash(callSig))) return false;
    return (g.pathEscapes?.[pathSig] ?? 0) < PATH_NOVEL_ESCAPES;
}
// callSig (optional) enables the escape; without it the endpoint is refused as soon as it is at the limit.
export function _pathRepeatRefused(g: RepeatGuard, pathSig: string | null, callSig?: string): boolean {
    if (_pathRepeatCount(g, pathSig) < PATH_REPEAT_LIMIT) return false;
    return !(callSig !== undefined && _pathEscapeAvailable(g, pathSig!, callSig));
}
export function _pathRepeatRefusalResult(n: number, pathSig: string): { error: string } {
    return { error: `Not executed: ${n} requests to ${pathSig.slice(4)} in your last ${REPEAT_WINDOW} steps returned the same result, and the allowance for trying a genuinely new query is used up. Another search will not show anything new: use what it returned. If it listed a tool or endpoint for your task, call it now with the arguments its schema describes; if it has nothing for this task, declare BLOCKED: <exact reason>.` };
}
export function _repeatRefusalResult(n: number): { error: string } {
    return { error: `Not executed: this exact call already ran ${n} times in your last ${REPEAT_WINDOW} steps with the same result. Running it again will not change the result. If the output you already have answers the task, give that answer now; otherwise change the command or arguments, find out why nothing changes, or declare BLOCKED: <exact reason>.` };
}
// Refusals in a turn before the loop gives up on it.
export const REPEAT_REFUSALS_BEFORE_STOP = 3;

// Progress credit. Refusals accumulate over the turn on purpose (a variant slipped between repeats
// must not reset them, v0.55 OS 38), so a long trajectory that makes real progress between a few
// refusals still met the stop (AutomationBench finance-4071 stopped at step 23 of 100). A step
// that executes without error and returns a result the turn has never seen forgives one refusal.
// "Never seen" is what keeps the v0.55 loophole closed: an interleaved variant repeats its own
// result and earns credit once, not each time. At most PROGRESS_CREDITS_MAX refusals are forgiven
// per turn, so the stop is delayed by a bounded number of steps, not removed.
export const PROGRESS_CREDITS_MAX = 3;
export function _creditProgress(g: RepeatGuard, resSig: string, ok: boolean): RepeatGuard {
    const h = _fpHash(resSig);
    const seen = g.seen ?? [];
    const novel = !seen.includes(h);
    const next: RepeatGuard = { ...g, seen: novel ? [...seen, h].slice(-_TURN_HISTORY) : seen };
    if (ok && novel && g.refused > 0 && (g.credits ?? 0) < PROGRESS_CREDITS_MAX) {
        next.refused = g.refused - 1;
        next.credits = (g.credits ?? 0) + 1;
    }
    return next;
}

// ── Text-response quality gate ───────────────────────────────────────────────
// Checks a no-tool-call text response for quality issues that need a nudge.
// Returns null when the response is acceptable, or {action, nudge, truncated?} when not.
// action is 'runaway' for the first 1–2 consecutive bad responses, 'bail' on the 3rd —
// the caller should exit the loop/return when it sees 'bail'.
// Pass a shared garbledState = { count: 0 } object; reset it when the response is clean.
// Does NOT handle the very-short / truncated-stream case — that requires per-loop fallback
// switching logic and stays inline in each loop.
// A long reply is a runaway only when it loops (the repetition check the stream decoder applies while a
// reply streams); a real long document passes. The hard cap bounds what one reply may add to the history.
export const LONG_TEXT_HARD_CAP = 400_000;

export function _checkTextResponse(textContent: string, step: number, maxSteps: number,
                                   garbledState: { count: number } = { count: 0 }) {
    // On the final step the caller handles the response directly as-is; don't interfere.
    if (step >= maxSteps - 1) return null;

    let result: { action: string; truncated: string; nudge: string } | null = null;

    // Detect EOS-token degeneration: model emits a stop token instead of a tool call.
    // These tokens are too short to trigger the length-based checks below.
    if (/<\|endoftext\|>|<\/s>|\[EOS\]/.test(textContent)) result = {
        action:    'runaway',
        truncated: textContent.slice(0, 100),
        nudge:     'Your last response appeared malformed (EOS token with no tool calls). The original task is re-injected below — continue with a tool call.'
    };
    else if (textContent.length > 30_000 && (textContent.length > LONG_TEXT_HARD_CAP || _degenerateTail(textContent) !== null)) result = {
        action:    'runaway',
        truncated: textContent.slice(0, 2000) + `\n[…truncated: response was ${textContent.length.toLocaleString()} chars with no tool calls]`,
        nudge:     'Your last response was very long and repeated itself, with no tool calls. Please call a tool to get the information you need, or give a short final answer.'
    };
    else {
        // Detect low-entropy garbage responses. Two bands:
        // - one character dominating (>80%): "!!!!...", "......"
        // - a tiny alphabet (≤4 distinct chars over 80+): catches MULTI-char repetition
        //   units like the v0.10 "陪着陪着陪着…" loops, where two alternating characters
        //   sit at 50% each and the dominance check never fires. No legitimate 80+-char
        //   response uses ≤4 distinct non-whitespace characters.
        // Operates on non-whitespace chars so that legitimately indented code isn't flagged.
        const _nonWS = textContent.replace(/\s/g, '');
        if (_nonWS.length > 80) {
            const _freq: Record<string, number> = {};
            for (const c of _nonWS) _freq[c] = (_freq[c] || 0) + 1;
            const _topFreq = Math.max(...Object.values(_freq));
            const _distinct = Object.keys(_freq).length;
            if (_topFreq / _nonWS.length > 0.8 || _distinct <= 4) result = {
                action:    'runaway',
                truncated: textContent.slice(0, 100),
                nudge:     'Your last response appeared malformed (repetitive characters with no tool calls). The original task is re-injected below — continue with a tool call.'
            };
        }
    }

    if (!result) {
        garbledState.count = 0;
        return null;
    }
    if (++garbledState.count >= 3) result = { ...result, action: 'bail' };
    return result;
}

// ── Broken-environment failure detector ─────────────────────────────────────
// Tracks consecutive execute_code failures in two ways:
//   envFailCount — same stderr first-line in a row (fires at 3)
//   envFailTotal — any exec failure in a row regardless of sig (fires at 8)
// Both reset on any successful exec.  The total counter catches the common
// "innovative failure" pattern where the model tries a different workaround
// each step (different error sigs) but never makes progress.
// Returns {envFailSig, envFailCount, envFailTotal, envFailMsg}.
// ── Consecutive-failure streak ───────────────────────────────────────────────
// Feeds the "N consecutive tool failures with no progress" stop. Each tool call is:
//   progress — a write tool that succeeded, or execute_code that exited 0 and printed or wrote
//              something: resets the streak;
//   fail     — a tool error, or execute_code that exited non-zero: counts;
//   neutral  — read-only tools, execute_code that exited 0 silently (mkdir, cp, sed -i, curl with
//              an empty body, a grep with no match), and missing-environment failures.
// v0.56 stopped 12 runs on this streak. 33 of the counted calls had exited 0 silently (TAC
// pm-schedule-meeting-1 was stopped at step 11 after nine empty `curl` bodies; in v0.55 it scored
// 5/5), and SWE runs were stopped on missing pytest / blocked pip before editing anything
// (pytest-8365: 14 steps, empty patch). Missing-environment failures get the env_failure nudge
// instead; they don't mean the task is hopeless, only that the tool can't be installed.
// The benchmark-log corpus (error taxonomy) found the gaps: a package the installed
// version doesn't carry ("cannot import name 'X' from astropy.utils.state", "module 'x' has no
// attribute") and a file the run can't read ("Permission denied") are all the environment, and
// all were counting as real failures that eventually stop the run.
// A bare `ImportError` is deliberately not matched: an import typo or circular import in the
// agent's own code raises it too ("ImportError while loading conftest"), and that is a bug to
// fix, not an environment to give up on. "cannot import name" counts only when the source is an
// installed package (site-/dist-packages), i.e. a version that doesn't carry the name.
export const ENV_MISSING_RE = /No module named|ModuleNotFoundError|externally-managed-environment|command not found|: not found$|type: \w+: not found|cannot import name '[^']+' from '[^']+' \([^)]*(?:site|dist)-packages|Permission denied|EACCES|mkdir: cannot create directory|Read-only file system|not in the sudoers file/m;

// "module 'x' has no attribute 'y'" means the environment (an installed package that lacks the
// name, e.g. cv2 built without a contrib module) unless `x` is a module the agent itself wrote or
// edited: `module 'app' has no attribute 'serve'` is a bug in its own code and must count as a
// failure. The loop reports the paths of the Python files it touches (noteAgentFiles); that is the
// module-origin evidence, since the error text names no file.
const _MODULE_ATTR_RE = /module '([\w.]+)' has no attribute/;
const _agentModuleNames = new Set<string>();

/** Record the files the agent wrote or edited, so their modules are not mistaken for installed ones. */
export function noteAgentFiles(paths: Iterable<string | null | undefined>): void {
    for (const p of paths) {
        if (!p) continue;
        const segs = String(p).split(/[\\/]/).filter(Boolean);
        if (!/\.py$/i.test(segs[segs.length - 1] ?? '')) continue;
        segs[segs.length - 1] = segs[segs.length - 1].replace(/\.py$/i, '');
        for (const seg of segs) _agentModuleNames.add(seg);
    }
}
export function resetAgentFiles(): void { _agentModuleNames.clear(); }

function _moduleAttrIsEnvironment(text: string): boolean {
    const hit = _MODULE_ATTR_RE.exec(text);
    if (!hit) return false;
    return !hit[1].split('.').some(part => _agentModuleNames.has(part));
}

/** True when the failure text says the environment lacks something, not that the agent's code is wrong. */
export function isEnvMissing(text: string): boolean {
    return ENV_MISSING_RE.test(text) || _moduleAttrIsEnvironment(text);
}

// Query tasks and invented data. AgentBench OS tasks 43, 47 and 52 (v0.70) asked a question about files that
// were already there; the agent wrote its own example files (or overwrote the real one) and answered from
// them. For a question that names no action, a data file created this turn is the sign.
const _ACTION_RE = /\b(?:creat\w*|writ\w*|mak\w*|add\w*|append\w*|generat\w*|sav\w*|set|chang\w*|modif\w*|updat\w*|delet\w*|remov\w*|renam\w*|mov\w*|copy|copi\w*|install\w*|configur\w*|edit\w*|fix\w*|build|compil\w*|replac\w*|insert\w*|stor\w*|export\w*|put|touch|chmod|chown|mkdir|kill|start|stop|restart|run|execut\w*|download\w*|upload\w*|send|post|implement\w*|refactor\w*|turn|enable|disable|clean\w*|sort|merge|split|convert\w*)\b/i;
export function isQuestionOnlyTask(task: string): boolean {
    const t = String(task ?? '').trim();
    if (!t || t.length > 1500) return false;
    return !_ACTION_RE.test(t);
}
// A task that asks for the supplied data itself to be changed ("fix the bad value in data.csv", "clean up the
// log", "convert the CSV"). Overwriting a supplied data file is then the work, not a way of inventing data, so the
// invented_data gate leaves it alone (s6-misleading-error: the nudge made the model restore a correct fix).
const _DATA_CHANGE_RE = /\b(?:fix\w*|repair\w*|correct\w*|updat\w*|edit\w*|modif\w*|chang\w*|clean\w*|convert\w*|replac\w*|renam\w*|sort\w*|dedup\w*|reformat\w*|normali[sz]\w*|patch\w*|delet\w*|remov\w*|append\w*|insert\w*|overwrit\w*|rewrit\w*|trim\w*|redact\w*|mask\w*|merge\w*)\b/i;
export function taskChangesData(task: string): boolean {
    return _DATA_CHANGE_RE.test(String(task ?? ''));
}

// Git commands that throw away work that cannot be got back from the repository: untracked files (git clean),
// uncommitted edits (reset --hard, checkout/restore of the whole tree, forced checkout/switch), saved stashes (stash
// drop/clear), modified files (rm -f), unmerged branches (branch -D) and remote history (push --force/--delete).
// An agent reaches for them to "leave the tree clean" and deletes the user's own untracked files (s5-git-branch-tag:
// setup.sh was removed). Allowed only when the user's request asks for that operation; "leave the working tree clean",
// a negated or explained mention ("do not run git clean"), or a dry run ("git clean -n") does not count, and permission
// for one operation is not permission for another (hermes N2; codex Review657/667/671/694/695/742-744/747).
type _GitOp = 'clean' | 'reset' | 'discard' | 'stash' | 'rm' | 'branch' | 'push';
const _GIT_OP_REASON: Record<_GitOp, string> = {
    clean: 'git clean -f deletes untracked files that git cannot restore',
    reset: 'git reset --hard discards uncommitted changes that git cannot restore',
    discard: 'a whole-tree or forced git checkout/restore/switch discards uncommitted changes that git cannot restore',
    stash: 'git stash drop/clear deletes saved stashes that git cannot restore',
    rm: 'git rm -f deletes modified files whose changes git cannot restore',
    branch: 'git branch -D deletes a branch whose unmerged commits git may not keep',
    push: 'a forced or deleting git push rewrites remote history that git cannot restore here',
};
const _DISCARD_WORDS = String.raw`\b(?:discard|throw\s+away|blow\s+away|nuke|wipe|hard[\s-]reset)\b`;
const _GIT_ASK: Record<_GitOp, RegExp> = {
    clean: new RegExp(String.raw`\bgit\s+clean\b((?:\s+-[-\w]*)*)|\b(?:delete|remove|wipe|get\s+rid\s+of)\s+(?:all\s+)?(?:the\s+|my\s+)?untracked\b`, 'gi'),
    reset: new RegExp(String.raw`\b(?:git\s+)?reset\s+--hard\b|${_DISCARD_WORDS}`, 'gi'),
    discard: new RegExp(String.raw`\bgit\s+(?:checkout\s+(?:-f|--force|\.)|restore\s+\.|switch\s+(?:-f|--force|--discard-changes))|${_DISCARD_WORDS}`, 'gi'),
    stash: /\bgit\s+stash\s+(?:drop|clear)\b|\b(?:drop|clear|delete|remove)\s+(?:the\s+|all\s+|my\s+|old\s+)*stash(?:es)?\b/gi,
    rm: /\bgit\s+rm\b/gi,
    branch: /\bgit\s+branch\s+(?:-D|-d|--delete)\b|\b(?:delete|remove|drop)\b[^.\n]{0,40}\bbranch(?:es)?\b/gi,
    push: /\bgit\s+push\b[^.\n]*?(?:--force|\s-f\b|--delete|--mirror)|\bforce[\s-]push\w*/gi,
};
// Words that turn a mention in the request into something other than permission, when they come earlier in its clause.
const _NOT_ASKED_RE = /\b(?:not|never|don'?t|no|without|avoid|explain\w*|describe\w*|what\s+(?:does|would|is)|how\s+does|why)\b/i;
function _userAsked(op: _GitOp, userText: string): boolean {
    const re = _GIT_ASK[op];
    re.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = re.exec(userText)); ) {
        if (op === 'clean' && m[1] && m[1].split(/\s+/).some(f => /^--dry-run$|^-[a-zA-Z]*n/.test(f))) continue;   // a dry run is not a deletion
        const before = userText.slice(0, m.index);
        const clause = before.slice(Math.max(before.lastIndexOf('.'), before.lastIndexOf(';'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf('\n'), before.search(/,\s*but\b[^,]*$/)) + 1);
        if (!_NOT_ASKED_RE.test(clause)) return true;
    }
    return false;
}
// The operation an argv (after `git`) performs, if it is one of the above.
function _gitOp(argv: string[]): _GitOp | null {
    let i = 0;
    while (i < argv.length && argv[i].startsWith('-')) i += /^-[Cc]$/.test(argv[i]) ? 2 : 1;   // -C dir, -c k=v, --no-pager, --git-dir=…
    const sub = argv[i], rest = argv.slice(i + 1);
    const flags = rest.filter(t => t.startsWith('-') && t !== '--'), words = rest.filter(t => !t.startsWith('-'));
    const has = (re: RegExp) => flags.some(f => re.test(f));
    const dry = has(/^--dry-run$|^-[a-zA-Z]*n/);
    switch (sub) {
        case 'clean': return !dry && has(/^--force$|^-[a-zA-Z]*f/) ? 'clean' : null;
        case 'reset': return has(/^--hard$/) ? 'reset' : null;
        case 'restore': if (has(/^--staged$|^-S$/) && !has(/^--worktree$|^-W$/)) return null;   // index only
        // falls through
        case 'checkout':
            if (words.some(w => /^(?:\.\/?|:\/\*?|\*|:\(top\)\S*)$/.test(w))) return 'discard';
            return sub === 'checkout' && has(/^-f$|^--force$/) ? 'discard' : null;
        case 'switch': return has(/^-f$|^--force$|^--discard-changes$/) ? 'discard' : null;
        case 'stash': return words[0] === 'drop' || words[0] === 'clear' ? 'stash' : null;
        case 'rm': return !dry && !has(/^--cached$/) && has(/^--force$|^-[a-zA-Z]*f/) ? 'rm' : null;
        case 'branch': return has(/^-D$/) || (has(/^-d$|^--delete$/) && has(/^-f$|^--force$/)) ? 'branch' : null;
        case 'push': return has(/^--force(?:-with-lease)?(?:=|$)|^-f$|^--delete$|^-d$|^--mirror$/) || words.slice(1).some(w => /^[+:]/.test(w)) ? 'push' : null;
        default: return null;
    }
}
// Every git invocation in command position in shell text: after a separator, a subshell or group opener, a shell keyword or
// wrapper (if/then/do, sudo/env/exec/command/nohup/time, VAR=value), and inside `bash -c '…'`. A mention inside an argument
// (`echo git clean -fd`, a commit message) is not a command.
function _shellGitArgvs(code: string): string[][] {
    const out: string[][] = [];
    const text = code.replace(/^\s*#.*$/gm, '');
    for (const m of text.matchAll(/\b(?:ba|z|da)?sh\s+-c\s+(['"])([\s\S]*?)\1/g)) out.push(..._shellGitArgvs(m[2]));
    for (const raw of text.split(/&&|\|\||;|\n|\||\$\(|[(){}`]/)) {
        const seg = raw.trim().replace(/^(?:(?:sudo|env|exec|command|nohup|time|then|do|else|if|elif|while|until|!|\w+=\S*)\s+)+/, '');
        if (/^git\s/.test(seg)) out.push(seg.slice(4).trim().split(/\s+/).map(t => t.replace(/^(['"])(.*)\1$/, '$2')));
    }
    return out;
}
// Git argv lists in program text of other languages: `['git', 'clean', '-fd']` and "git clean -fd" string literals
// (subprocess.run, os.system, child_process.exec ...).
function _programGitArgvs(code: string): string[][] {
    const out: string[][] = [];
    for (const m of code.matchAll(/\[\s*(['"])git\1\s*,([^\]]*)\]/g)) out.push([...m[2].matchAll(/(['"])((?:(?!\1).)*)\1/g)].map(x => x[2]));
    for (const m of code.matchAll(/(['"`])git\s+((?:(?!\1)[^\n])*)\1/g)) out.push(..._shellGitArgvs('git ' + m[2]));
    return out;
}
/** Why `code` must not run without the user asking for it, or null. `shell`: the code is shell text (bash, run_git);
 *  otherwise it is a program whose git calls are found in its list and string literals. */
export function destructiveGitReason(code: string, userText: string, shell = true): string | null {
    const text = String(code ?? '');
    if (!/\bgit\b/.test(text)) return null;
    const user = String(userText ?? '');
    for (const argv of shell ? _shellGitArgvs(text) : _programGitArgvs(text)) {
        const op = _gitOp(argv);
        if (op && !_userAsked(op, user)) return _GIT_OP_REASON[op];
    }
    return null;
}

const _DATA_FILE_RE = /\.(?:txt|log|csv|tsv|json|dat|md|xml|ya?ml|ini|conf)$/i;
/** Data-like files created or changed in this run that are not scratch or temp files. */
export function inventedDataPaths(edited: Iterable<string>, isScratch: (p: string) => boolean): string[] {
    return [...edited].filter(p => {
        const q = String(p);
        return !isScratch(q) && !/^\/?(?:tmp|var\/tmp|dev)\//.test(q) && (_DATA_FILE_RE.test(q) || !/\.[A-Za-z0-9]{1,5}$/.test(q));
    });
}

/** The file names the prompt lists in its <workspace_files> block (what was supplied before the agent acted). */
export function suppliedFiles(promptText: string): Set<string> {
    const m = /<workspace_files>\n[^\n]*\n([\s\S]*?)<\/workspace_files>/.exec(String(promptText ?? ''));
    const out = new Set<string>();
    if (m) for (const l of m[1].split('\n')) { const t = l.trim().replace(/^\.\//, ''); if (t && !t.endsWith('/') && !/^\.\.\./.test(t)) out.add(t); }
    return out;
}
/** Paths a shell command writes to (redirect, tee, sed -i): see shell-writes.ts. */
export function shellWritePaths(code: string): string[] {
    return shellWrites(code).paths;
}
/** Written paths that are one of the supplied files (same path, or same name when the prompt lists bare names). */
export function overwrittenSupplied(written: Iterable<string>, supplied: Set<string>): string[] {
    const base = (p: string) => p.replace(/^\.\//, '');
    const names = new Set([...supplied].map(p => base(p).split('/').pop()!));
    // Plain data files only: a supplied .py/.js/.md/config file is routinely, legitimately edited.
    return [...new Set([...written].map(base))].filter(p => /\.(?:txt|log|csv|tsv|dat|jsonl)$/i.test(p)
        && (supplied.has(p) || names.has(p.split('/').pop()!)));
}

// A search or comparison that found nothing: `grep` and its relatives, `diff`, `cmp` exit 1 with no output
// when there is no match or no difference. That is an answer, not a failure (CTF 71, v0.70: each empty
// grep was followed by "Fix before declaring COMPLETED" and counted toward the failure streak).
export function isNegativeProbe(args: any, result: any): boolean {
    if (runtime.guardOff('negative_probe')) return false;
    if (!result || result.error || result.exit_code !== 1) return false;
    if (String(result.stdout ?? '').trim() || String(result.stderr ?? '').trim()) return false;
    const code = String(args?.code ?? '');
    if (!code || String(args?.language ?? 'bash') !== 'bash') return false;
    const last = code.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).pop() ?? '';
    // the last pipeline segment decides the exit status: `cmd | grep x`, `grep -rn x .`, `diff a b`
    const tail = last.split(/\|(?!\|)|&&|;/).pop()!.trim();
    return /^(?:sudo\s+)?(?:grep|egrep|fgrep|zgrep|rg|ag|diff|cmp|comm|test|\[)\b/.test(tail);
}

export function failStreakKind(name: string, result: any, readOnly: Set<string>, args?: any): 'progress' | 'fail' | 'neutral' {
    if (readOnly.has(name)) return 'neutral';
    if (result?.error) return 'fail';
    if (name !== 'execute_code') return 'progress';
    if (isNegativeProbe(args, result)) return 'neutral';
    if ((result?.exit_code ?? 0) === 0) {
        const wrote = Array.isArray(result?.files_written) && result.files_written.length > 0;
        return (String(result?.stdout ?? '').trim() || wrote) ? 'progress' : 'neutral';
    }
    return isEnvMissing(`${result?.stderr ?? ''}\n${result?.stdout ?? ''}`) ? 'neutral' : 'fail';
}

// New streak value after one step's tool calls: any progress resets it, each failure adds one.
export function updateFailStreak(prev: number, calls: Array<{ name: string; result: any; args?: any }>, readOnly: Set<string>): number {
    const kinds = calls.map(c => failStreakKind(c.name, c.result, readOnly, c.args));
    if (kinds.includes('progress')) return 0;
    return prev + kinds.filter(k => k === 'fail').length;
}

// Output that names nothing: a test runner's or runtime's closing banner. It comes after the
// cause, so taking the last line verbatim fingerprinted "FAILED (failures=1)", "Node.js v22.23.1"
// or "3 failed" as the error — the same-error-streak nudge then quoted the footer instead of
// the reason, and two different failures behind one footer looked identical.
const _SIG_NOISE_RE = /^(?:[-=_*#~]{3,}.*[-=_*#~]{0,3}|[-=_*#~]{3,}|\d+ (?:passed|failed|error|warning|deselected)s?\b.*|FAILED\b.*|OK\b.*|PASSED\b.*|!+ stopping after \d+ failures.*|Archives with Errors:.*|Sub items Errors:.*|-- Docs: https?:\/\/.*|Testing against .* with up to \d+ processes.*|Ran \d+ tests?\b.*|no tests (?:collected|ran).*|Rebuilding extension modules.*|Destroying test database.*|System check identified no issues.*|FAIL\b.*|Defaulting to user installation.*|Could not import cythonised.*|Node\.js v[\d.]+|Python [\d.]+$|PyPy [\d.]+ v[\d.]+.*|Your platform.*|at [\w./-]*(?:node|python|_pytest)[\w./:-]*:\d+:\d+)$/i;

// pytest prints its warnings summary after the failures, so the last line of a failed run was the
// source line of an unrelated DeprecationWarning: 517 failures in the bench logs were signed
// "import cgi" (bad -k, AttributeError, failed asserts alike). The section runs from its banner to
// the next one and never holds the cause.
function _dropWarningsSummary(lines: string[]): string[] {
    const out: string[] = [];
    let inSummary = false;
    for (const l of lines) {
        if (/^=+ warnings summary\b.*=+$/.test(l)) { inSummary = true; continue; }
        if (inSummary && /^(?:-- Docs: |[=!_]{3,})/.test(l)) inSummary = false;
        if (!inSummary) out.push(l);
    }
    return out;
}
const _PYTEST_COLLECTED_RE = /^collected \d+ items?$/;
const _PYTEST_ERROR_RE = /^(?:collecting \.\.\. )?ERROR: /;

// The error a failed call ended on: the last line of stderr (or the tool error) that isn't a
// closing banner. For a Python traceback that is "TypeError: …", where the first line is always
// "Traceback (most recent call last):", which made every Python error look like the same one.
export function failureSignature(result: any): string {
    const text = String(result?.error || result?.stderr || result?.stdout || '');
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const meaningful = _dropWarningsSummary(lines).filter(l => !_SIG_NOISE_RE.test(l));
    // All-noise output (a bare "---"): the last line is all there is, so use it rather than nothing.
    let sig = meaningful[meaningful.length - 1] ?? lines[lines.length - 1] ?? '';
    // pytest's "collected 0 items" is the count, not the reason; the reason is the "ERROR: file or
    // directory not found: …" it printed while collecting.
    if (_PYTEST_COLLECTED_RE.test(sig)) sig = _findLast(meaningful, l => _PYTEST_ERROR_RE.test(l))?.replace(/^collecting \.\.\. /, '') ?? sig;
    return sig.slice(0, 160);
}

// Failure streak about to reach the stop, and its last `n` failures all ended on the same error:
// re-running will not change it, and in SWE the error usually comes from the environment (v0.57
// Verified xarray-4094: 13 identical pandas-2 `TypeError`s from the old xarray under test, stopped
// at step 36 with no edit; v0.56 had resolved it). Worth one directed nudge before the stop.
const SAME_ERROR_GRACE_MIN = 4;
export function sameErrorStreak(sigs: string[], n = SAME_ERROR_GRACE_MIN): string | null {
    if (sigs.length < n) return null;
    const last = sigs.slice(-n);
    return last[0] && last.every(s => s === last[0]) ? last[0] : null;
}
export function sameErrorNudge(sig: string, n: number): string {
    return `The same error has now repeated ${n} times: "${sig}". Running it again will not change it. If it comes from the environment (a library version, a missing service or build step), stop trying to reproduce or fix the environment: make the change by reading the code, then finish. Otherwise try a different approach. The run stops if the failures continue.`;
}

// Backslashes doubled by the model's own escaping: a full rewrite of an existing file in which `\d`, `\n`, `\s` ... became
// `\\d`, `\\n`, `\\s`. self-analysis W7r2 regenerated storage-usage.ts that way (the regex `(\d+)` turned into `(\\d+)`, three
// `\n` in a tooltip into `\\n`) and broke an existing test; the file still parsed, so no syntax check could see it. Counted as growth
// against the previous text, so a file that legitimately contains such sequences is not flagged for keeping them.
const _DOUBLED_ESC = /\\\\[A-Za-z]/g;
export function doubledBackslashGrowth(previous: string, content: string): number {
    const count = (s: string) => (String(s ?? '').match(_DOUBLED_ESC) ?? []).length;
    return count(content) - count(previous);
}

// The same over-escaping inside a regular expression literal of a file that did not exist before: `h.match(/^(\\d+)\\.(\\d+)$/)` matches a backslash
// and a "d", not a number. self-analysis SEC1-SEC5: five of nine access-check reviews blamed a correct function for a "bug" that only existed in the
// copy the agent had written into a test script (its tool call had doubled the backslashes), so the test of the copy "proved" the original wrong.
// Looked for only after a call, a test, a match or an assignment, so a regex written as text in a string is not counted; none of this repository's sources has one.
const _OVERESCAPED_REGEX = /(?:\.match\(|\.test\(|\.replace\(|\.search\(|=\s*|\(\s*|,\s*)\/(?:[^/\n\\]|\\[^\\])*\\\\[dswDSW][^/\n]*\//g;
export function overEscapedRegexLiterals(content: string): number {
    return (String(content ?? '').match(_OVERESCAPED_REGEX) ?? []).length;
}

// A file written in full again and again. Six self-analysis runs rewrote one file 7-34 times with the same flaw (an unterminated
// string, a quoting that breaks the next step) and never read back what they had written; the step budget ended it. Counted
// per path from successful write_file calls; a passing check command or a targeted replace_in_file on the path starts it over.
// Nothing after the fourth full rewrite changes unless the approach does, so the nudge comes at 4 and again at 8, 12, ...
export const REWRITE_NUDGE_EVERY = 4;
export type RewriteState = Map<string, number>;
export const newRewriteState = (): RewriteState => new Map();
export function noteRewrites(st: RewriteState, results: Array<{ name: string; args?: any; result: any }>): string | null {
    let msg: string | null = null;
    for (const r of results) {
        if (r.result?.error) continue;
        const path = String(r.args?.path ?? r.result?.path ?? '');
        if (r.name === 'replace_in_file' && path) st.delete(path);
        else if (r.name === 'execute_code' && (r.result?.exit_code ?? 0) === 0 && isCheckCommand(String(r.args?.code ?? ''))) st.clear();
        else if (r.name === 'write_file' && path) {
            const n = (st.get(path) ?? 0) + 1;
            st.set(path, n);
            if (n % REWRITE_NUDGE_EVERY === 0) {
                msg = `You have now written ${path} in full ${n} times without a check passing in between. Writing it again will not fix what is wrong with it. Read it back (read_file), find the part that fails, and change only that part with replace_in_file. If you cannot make it work, say so and leave the original as it was instead of a half-written file.`;
            }
        }
    }
    return msg;
}

// A tool call typed into the shell: `read_file{path: "a.ts"}` or `search_workspace(pattern="x")` as the command of execute_code. The shell answers
// `command not found`, which the failure streak counts as a missing tool in the environment (ENV_MISSING_RE) and the env_failure nudge
// then talks about installing things; the model keeps typing the same call. Only the first command line counts, and a shell function
// that happens to carry a tool's name (`read_file() { ... }`) is a definition, not a call.
export function pseudoToolInShell(code: string, toolNames: Iterable<string>): string | null {
    const first = String(code ?? '').split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
    if (!first) return null;
    const m = /^([a-z][a-z0-9_]*)[ \t]*([{(])/.exec(first);
    if (!m || (m[2] === '(' && /^[a-z][a-z0-9_]*[ \t]*\(\s*\)/.test(first))) return null;
    for (const n of toolNames) if (n === m[1]) return n;
    return null;
}

// A program the shell has to quote (python3 -c "...", a heredoc) that failed on syntax. The model rewrites the same program
// with another quoting each time and the errors differ (`syntax error near unexpected token`, `f-string expression part cannot
// include a backslash`, `command not found` for words the shell split off), so no two failures share an error line: the
// same-error and environment counters never saw a loop, and self-analysis logged 5-22 wasted steps in each of six runs.
const _INLINE_PY_RE = /^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)?(?:python3?|py)\s+(?:-c\b|-\s*<<)/;
const _INLINE_SYNTAX_RE = /SyntaxError|syntax error near|unexpected EOF|unexpected token|f-string|EOL while scanning|unterminated|command not found/i;
export const INLINE_SCRIPT_SIG = 'inline python through the shell failed on syntax';
export function inlineScriptSyntaxFailure(args: any, result: any): boolean {
    const lang = String(args?.language ?? 'bash').toLowerCase();
    if (!['bash', 'sh', 'shell', 'zsh'].includes(lang)) return false;
    if (!_INLINE_PY_RE.test(String(args?.code ?? ''))) return false;
    return _INLINE_SYNTAX_RE.test(`${result?.stderr ?? ''}\n${result?.stdout ?? ''}\n${result?.error ?? ''}`);
}
const INLINE_SCRIPT_NUDGE = 'Two inline `python3 -c` / heredoc programs in a row failed on syntax or quoting. The shell is part of the problem: stop quoting the program. Write it to a file with write_file (for example out/step.py) and run `python3 out/step.py`, or send it with language "python". Do not rewrite the quoting again.';

export function _updateEnvFailureDetector(
    results: Array<{ name: string; args?: any; result: any }>,
    envFailSig: string,
    envFailCount: number,
    envFailTotal: number = 0,
): { envFailSig: string; envFailCount: number; envFailTotal: number; envFailMsg: string | null } {
    const _execFails = results.filter(r =>
        r.name === 'execute_code' && r.result?.exit_code != null && r.result.exit_code !== 0);
    if (!_execFails.length) {
        const _anyExec = results.some(r => r.name === 'execute_code');
        if (_anyExec) { envFailSig = ''; envFailCount = 0; envFailTotal = 0; }
        return { envFailSig, envFailCount, envFailTotal, envFailMsg: null };
    }
    envFailTotal++;
    const _inline = inlineScriptSyntaxFailure(_execFails[0].args, _execFails[0].result);
    const _sig = _inline ? INLINE_SCRIPT_SIG : failureSignature(_execFails[0].result).slice(0, 120);
    if (_sig && _sig === envFailSig) {
        envFailCount++;
        if (_inline && envFailCount >= 2) {
            envFailCount = 0; envFailSig = ''; envFailTotal = 0;
            return { envFailSig, envFailCount, envFailTotal, envFailMsg: INLINE_SCRIPT_NUDGE };
        }
        if (envFailCount >= 3) {
            const _n = envFailCount;
            envFailCount = 0; envFailSig = ''; envFailTotal = 0;
            return { envFailSig, envFailCount, envFailTotal, envFailMsg: `This command has failed ${_n} times in a row with the same error: "${_sig}". The environment may be missing a required tool or package that cannot be installed. If the task is to change code, make the change from reading the code without running this; declare BLOCKED: <reason> only if the task cannot be done without it.` };
        }
    } else {
        envFailSig = _sig; envFailCount = 1;
    }
    if (envFailTotal >= 8) {
        const _n = envFailTotal;
        envFailTotal = 0; envFailSig = ''; envFailCount = 0;
        return { envFailSig, envFailCount, envFailTotal, envFailMsg: `${_n} consecutive execute_code failures across different approaches. The test environment likely requires build tools or system packages (C extensions, gcc, system libs) that cannot be installed in this container. Stop attempting to fix the environment. If your code fix is in place, declare BLOCKED: <specific missing requirement> — do not try to rebuild, patch build systems, or install compilers.` };
    }
    return { envFailSig, envFailCount, envFailTotal, envFailMsg: null };
}

// Window bridge for free-variable access from sibling modules (house pattern).
Object.assign(window, { _fpHash, _fpTrunc, _updateStuckDetector, _checkTextResponse, _updateEnvFailureDetector });
