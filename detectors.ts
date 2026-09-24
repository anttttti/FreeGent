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
    execute_code: 'Your last 3 execute_code calls produced identical results — running the same command again will not change the outcome. Change the command, or first find out why nothing changes (check logs, process state, file contents, error output).' + _BLOCKED_TAIL,
    fetch_url:    'Your last 3 fetch_url calls returned identical responses — the same request will keep returning the same thing. Change the URL, method, parameters or body, or use a different endpoint.' + _BLOCKED_TAIL,
    run_workers:  'Your last 3 run_workers calls returned identical results — delegating the same task again will not help. Do the step yourself, or give the workers a different, more specific task.' + _BLOCKED_TAIL,
    '':           'Your last 3 steps produced identical results. Try a different approach: use start_line/end_line to read a specific section, or search_workspace with a literal string from the error message or function name to find the right file. Do not search by filename — search by content.' + _BLOCKED_TAIL,
};
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
            for (const key of [..._lf])
                if (stalledPaths.has(typeof _normPath === 'function' ? _normPath(key) : key)) _lf.delete(key);
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
// Consecutive steps making the same tool call(s) with the same result — digits ignored, since PIDs,
// timestamps and request IDs change between otherwise identical runs. Once a call has repeated
// REPEAT_LIMIT times, the next identical call is refused instead of executed. v0.54: 9 tasks looped
// like this (e.g. `ps aux | grep postgres` 72 times, a curl returning 405 112 times); the nudges
// kept firing but nothing escalated.
export const REPEAT_LIMIT = 8;
export type RepeatGuard = { callSig: string; resSig: string; streak: number; refused: number };
export const newRepeatGuard = (): RepeatGuard => ({ callSig: '', resSig: '', streak: 0, refused: 0 });

export function _callSig(calls: Array<{ name: string; args: any }>): string {
    return JSON.stringify(calls.map(c => [c.name, c.args ?? {}]));
}
export function _resultSig(results: Array<{ name: string; result: any }>): string {
    const digitless = (k: string, v: any) => {
        if (typeof v !== 'string') return v;
        const d = v.replace(/\d+/g, '#');
        return d.length > 512 ? `${d.slice(0, 128)}#${_fpHash(d)}#${d.slice(-64)}#len${d.length}` : d;
    };
    return JSON.stringify(results.map(r => ({ n: r.name, res: r.result })), digitless);
}
// Before executing: true when this call would extend a streak past REPEAT_LIMIT.
export function _repeatRefused(g: RepeatGuard, callSig: string): boolean {
    return g.streak >= REPEAT_LIMIT && callSig === g.callSig;
}
// After executing (not after a refusal): extend or restart the streak.
export function _updateRepeatGuard(g: RepeatGuard, callSig: string, resSig: string): RepeatGuard {
    const same = callSig === g.callSig && resSig === g.resSig;
    return { callSig, resSig, streak: same ? g.streak + 1 : 1, refused: 0 };
}
export function _repeatRefusalResult(n: number): { error: string } {
    return { error: `Not executed: this exact call already ran ${n} times in a row with the same result. Running it again will not change anything — change the command or arguments, find out why nothing changes, or declare BLOCKED: <exact reason>.` };
}
// Refusals in a row before the loop gives up on the turn.
export const REPEAT_REFUSALS_BEFORE_STOP = 3;

// ── Text-response quality gate ───────────────────────────────────────────────
// Checks a no-tool-call text response for quality issues that need a nudge.
// Returns null when the response is acceptable, or {action, nudge, truncated?} when not.
// action is 'runaway' for the first 1–2 consecutive bad responses, 'bail' on the 3rd —
// the caller should exit the loop/return when it sees 'bail'.
// Pass a shared garbledState = { count: 0 } object; reset it when the response is clean.
// Does NOT handle the very-short / truncated-stream case — that requires per-loop fallback
// switching logic and stays inline in each loop.
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
    else if (textContent.length > 30_000) result = {
        action:    'runaway',
        truncated: textContent.slice(0, 2000) + `\n[…truncated: response was ${textContent.length.toLocaleString()} chars with no tool calls]`,
        nudge:     'Your last response was very long but contained no tool calls. Please call a tool to get the information you need, or give a short final answer.'
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
export function _updateEnvFailureDetector(
    results: Array<{ name: string; result: any }>,
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
    const _sig = (String(_execFails[0].result?.stderr ?? _execFails[0].result?.error ?? '')).split('\n')[0].trim().slice(0, 120);
    if (_sig && _sig === envFailSig) {
        envFailCount++;
        if (envFailCount >= 3) {
            const _n = envFailCount;
            envFailCount = 0; envFailSig = ''; envFailTotal = 0;
            return { envFailSig, envFailCount, envFailTotal, envFailMsg: `This command has failed ${_n} times in a row with the same error: "${_sig}". The environment may be missing a required tool or package that cannot be installed. If you cannot proceed without it, declare BLOCKED: <reason>.` };
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
Object.assign(window, { _fpHash, _fpTrunc, _updateStuckDetector, _checkTextResponse, _updateEnvFailureDetector, _callSig, _resultSig, _repeatRefused, _updateRepeatGuard });
