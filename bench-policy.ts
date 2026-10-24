// bench-policy.ts — FreeGent: the task policies that only benchmark runners use.
//
// Everything here assumes a runner that knows how its task is graded and says so through FG_* switches:
//   FG_EDIT_REQUIRED=1   the task is solved by editing files (SWE-bench): a COMPLETED with no edit is bounced once
//   FG_CHANGE_REQUIRED=1 the task is graded on the state of the system afterwards (AgentBench OS): "explained, not fixed" is bounced
//   FG_PROTECT_TESTS=1   the grader strips test-file changes (SWE-bench): edits to test files are refused
// plus the graded test ids the runner writes into the task text ("Graded tests:" / `pytest path::name`).
// An ordinary run (browser, TUI, a user's CLI call) sets none of these, so none of this can fire there: the headless
// runner loads this module only when one of the switches is set (`benchPolicyRequested`), and the product code reaches
// it only through task-policy.ts.
import { runtime } from './runtime.js';
import { installTaskPolicy, resetTaskPolicy } from './task-policy.js';
import { COMPLETION_GATES, completionDeclared } from './completion-gates.js';
import type { CompletionGate, GateContext } from './completion-gates.js';
import { _BLOCKED_DECLARATION_RE, _TERMINAL_RE } from './turn-protocol.js';
import { isCheckCommand } from './verification.js';

const env = (k: string): string | undefined => (globalThis as any).process?.env?.[k];
export const editRequired = (): boolean => env('FG_EDIT_REQUIRED') === '1';
export const changeRequired = (): boolean => env('FG_CHANGE_REQUIRED') === '1';
/** Benchmark policy, not a capability: file tools refuse to edit test files. Only where commands run natively. */
export const protectTests = (): boolean => runtime.hasNativeExec && env('FG_PROTECT_TESTS') === '1';
/** True when the environment asks for any of the policies above (the headless runner installs them then). */
export const benchPolicyRequested = (): boolean => editRequired() || changeRequired() || protectTests();

/** Graded test IDs the benchmark runner listed in the task text. */
export function _gradedTestIds(taskText: string): string[] {
    const ids = new Set<string>();
    // Collect graded test IDs from two formats the runner emits:
    //   1. backtick-quoted `pytest -xvs path.py::name …` — runner always wraps in
    //      backticks and may include flags and multiple paths on one line; parse
    //      the full arg string and filter for *.py tokens (fixes dead regex — T1.3)
    //   2. bare lines in "Graded tests:" block — tests without '::' are emitted as-is
    for (const m of taskText.matchAll(/pytest\s+(.*?)(?=`|$)/gm))
        for (const tok of m[1].split(/\s+/))
            if (/^[\w/.+-]+\.py(?:::\S+)?$/.test(tok)) ids.add(tok);
    const block = taskText.match(/Graded tests[^\n]*\n([\s\S]*?)(?:\n\n|$)/);
    if (block) {
        for (const line of block[1].split('\n')) {
            const t = line.trim();
            if (t && !t.startsWith('#')) ids.add(t.startsWith('pytest ') ? t.slice(7).trim() : t);
        }
    }
    return [...ids];
}

/**
 * True when this test output shows a graded test that ran and failed (or source that does not
 * parse). False for output the model cannot act on: a collection or import error, a listing, or
 * failures only in tests that are not graded.
 */
// Pytest node ids compared as ids: the module (path) and each class/function component must match, and a parameter instance is compared only where the graded id names
// one (an unparameterized id selects all of its instances). `tests/test_a.py` or a directory selects what is under it (codex R76).
function _nodeSplit(id: string): { path: string; comps: string[] } {
    const [path, ...comps] = id.trim().replace(/^\.\//, '').split('::');
    return { path: path.replace(/\/+$/, ''), comps };
}
export function _sameTestNode(failedId: string, gradedId: string): boolean {
    const F = _nodeSplit(failedId), G = _nodeSplit(gradedId);
    // pytest prints ids relative to its rootdir; the task may name the file by a longer or absolute path: one path ending in the other is the same module.
    const samePath = (a: string, b: string) => a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
    // A graded directory (or file) selects what is under it; the directory may be named by a longer path than pytest prints.
    const under = (dir: string, file: string) => dir.split('/').some((_, i, a) => file.startsWith(a.slice(i).join('/') + '/'));
    if (!G.comps.length) return samePath(F.path, G.path) || under(G.path, F.path);
    if (!samePath(F.path, G.path) || F.comps.length < G.comps.length) return false;
    return G.comps.every((g, i) => {
        const f = F.comps[i];
        return /\[/.test(g) ? f === g : f.replace(/\[.*$/, '') === g;
    });
}

/**
 * True when this test output shows a graded test that ran and failed (or source that does not
 * parse). False for output the model cannot act on: a collection or import error, a listing, or
 * failures only in tests that are not graded.
 */
export function _gradedTestFailed(output: string, gradedIds: string[]): boolean {
    // The output is a JSON-encoded tool result: its line breaks are the two characters backslash-n. A count at the start of a line ("\n1 failed" in the text) is
    // then glued to a word character and \b does not see it (codex R76).
    output = output.replace(/\\[nrt]/g, ' ');
    if (/SyntaxError|IndentationError|TabError/.test(output)) return true;
    if (/errors? during collection|Interrupted: \d+ errors?|no tests ran|ERROR: (?:not found|file or directory not found)|INTERNALERROR/.test(output)) return false;
    if (!/\b\d+ failed\b/.test(output)) return false;
    // FAILED lines name the tests; the output is a JSON-encoded tool result, so a line ends at "\n".
    const failed = [...output.matchAll(/FAILED\s+([^\s\\]+)/g)].map(m => m[1]);
    if (!failed.length || !gradedIds.length) return true;
    return failed.some(f => gradedIds.some(g => _sameTestNode(f, g)));
}


// The first COMPLETED on a task that lists graded tests: run them. Once per session (`graded_test` in reactiveFired).
export function completionDirective(task: string, reactiveFired: Set<string>): string | null {
    if (reactiveFired.has('graded_test')) return null;
    const ids = _gradedTestIds(task);   // the task text without the guidance examples (e.g. `pytest tests/test_foo.py`)
    if (!ids.length) return null;
    reactiveFired.add('graded_test');
    return `Run the graded test now: \`pytest ${ids.join(' ')}\` — it must exit 0 before you declare COMPLETED. If it cannot be collected or imported in this environment (a missing module, an unbuilt extension, a test that does not exist yet), do not change test or packaging configuration to make it run: check your fix another way and declare COMPLETED.`;
}

// A later COMPLETED after that directive: look at the most recent pytest result; if the tests still fail (or never ran),
// bounce again. The caller caps the number of bounces.
export function retryDirective(hist: any[], task: string): string | null {
    let testOutput = '';
    // The result must be of a command that ran pytest: a file that was read and mentions a passing run is not one (codex R77).
    const ranPytest = (callId: string): boolean => {
        for (const a of hist) for (const tc of a.tool_calls ?? []) {
            if (tc.id !== callId) continue;
            let args: any = {}; try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
            const code = String(args.code ?? args.command ?? args.cmd ?? '');
            return tc.function?.name === 'execute_code' && /\bpytest\b|\bpy\.test\b/.test(code) && isCheckCommand(code);
        }
        return false;
    };
    for (let i = hist.length - 1; i >= 0; i--) {
        const m = hist[i];
        if (m.role !== 'tool' || !ranPytest(m.tool_call_id)) continue;
        const c = typeof m.content === 'string' ? m.content
            : Array.isArray(m.content) ? (m.content as any[]).map((x: any) => x.text ?? '').join('') : '';
        if (/passed|failed|PASSED|FAILED|ERROR|pytest/.test(c)) { testOutput = c; break; }
    }
    // Pass: at least one "N passed" with no "N failed" / "N error"
    const testPassed = !!testOutput && /\d+ passed/.test(testOutput) && !/\d+ (failed|error)/.test(testOutput);
    // Bounce again only when no test was run, or a graded test ran and failed. Anything else
    // cannot be fixed by the model: v0.66 SWE sent "still failed" 32 times, 4 of them for a
    // test that ran and failed; the rest were collection or import errors from the image
    // (old pytest internals, unbuilt C extensions), a `--collect-only` listing, or failures
    // of tests that are not graded. 17 of 31 gated tasks never got a runnable pytest, and 7
    // of those were resolved by the grader anyway.
    if (!testPassed && (!testOutput || _gradedTestFailed(testOutput, _gradedTestIds(task)))) {
        return testOutput
            ? `The graded test still failed — fix the failure then run it again: it must exit 0 before you declare COMPLETED.`
            : `You declared COMPLETED without running the graded test. Run it now — it must exit 0.`;
    }
    return null;
}

// COMPLETED on a task that is solved by editing the source, with no edit made: SWE Lite matplotlib-23314
// (v0.70) analysed for 44 steps and ended `completed` with an empty patch. Narrower than the general
// completion gate (which is skipped without an edit so that data-query tasks are not second-guessed).
const noEdit: CompletionGate = {
    name: 'no_edit_complete',
    run(c) {
        if (!completionDeclared(c) || c.editsThisRun || c.ps.noEditCheck) return null;
        if (!(c.editRequired || c.gradedTestIds().length > 0)) return null;
        c.ps.noEditCheck = 1;
        return { name: 'no_edit_complete', force: true,
            text: 'You declared COMPLETED but no file in the workspace was changed, and this task is solved by editing the source. If you identified the cause, make the edit now (replace_in_file on the exact lines, then re-run your check). If the change really is not needed or you cannot make it, reply BLOCKED: <reason> instead of COMPLETED.' };
    },
};


// Tasks graded on the state of the system afterwards (AgentBench OS 38, 40, 41, 42 in v0.72: "fix it"): the
// reply explained the cause and nothing on the system had changed. The runner says so (FG_CHANGE_REQUIRED);
// the prompt wording is never read. Code tasks (editRequired, graded tests) belong to the no-edit gate. No
// file was written, so that gate never looked; a command that installs a package or sets a mode leaves no
// written file either, hence `stateChanged`. Once: a reply that really finds nothing to fix passes on its
// second COMPLETED.
const changeTask = (c: GateContext): boolean => c.changeRequired && !c.editRequired && c.gradedTestIds().length === 0;
const noChangeFix: CompletionGate = {
    name: 'no_change_fix',
    run(c) {
        if (!completionDeclared(c) || c.ps.noChangeFix) return null;
        if (!changeTask(c) || c.editsThisRun || c.stateChanged || c.shellWrites.size) return null;
        c.ps.noChangeFix = 1;
        return { name: 'no_change_fix', force: true,
            text: 'You declared COMPLETED, but the task needs the system to be changed and nothing was changed: no file was written and no command that changes the system (an install, chmod, chown, a config edit, a restart) succeeded. Explaining the cause is not the fix. Find what is actually wrong (a missing package, a wrong mode or owner, an empty or invalid config file, a setuid bit that should not be there), change it, and check that it works the way the user would use it. If you are sure nothing is broken, state exactly why with the evidence, then reply COMPLETED again.' };
    },
};

// BLOCKED on a change-required task with nothing tried. A BLOCKED question is accepted in autonomous runs (the runner
// pauses and shows it), which is right where someone can answer and wrong where nobody can: OS task 41
// ("Why can't I use sudo? Help me fix it.") ended on "BLOCKED: What is the exact error message you
// receive?" after reading an empty /etc/sudoers it could have repaired. One bounce, only when the task states
// a fix and no change was made; a second BLOCKED is accepted.
const blockedUntried: CompletionGate = {
    name: 'blocked_untried_fix',
    run(c) {
        if (!_BLOCKED_DECLARATION_RE.test(c.text) || _TERMINAL_RE.test(c.text)) return null;
        if (c.step >= c.loopMax - 1 || c.softStopPending || c.ps.blockedUntried) return null;
        if (!changeTask(c) || c.editsThisRun || c.stateChanged || c.shellWrites.size) return null;
        c.ps.blockedUntried = 1;
        return { name: 'blocked_untried_fix', force: true,
            text: 'You declared BLOCKED without changing anything. Nobody can answer questions in this run, and the task already gives you the symptom. Investigate the system yourself (read the relevant config and permission files, check owners and modes, check what is installed), make the fix, and verify it. Declare BLOCKED again only after you tried and a specific missing requirement stops you.' };
    },
};


// SWE-bench: grader strips test-file changes before scoring — agent edits score zero.
// 17/36 failed SWE tasks edited test files; 14 passed a self-modified test and were
// still rejected. Benchmark policy: on only when the runner sets FG_PROTECT_TESTS=1
// (protectTests()); every other run, native or browser, may edit its tests.
const _SWE_TEST_RE = /(^|\/)(tests?|testing|specs?)\/|(^|\/)test_|_test\.|\.test\./;
export function isTestEditProtected(path: unknown): boolean {
    return protectTests() && typeof path === 'string' && _SWE_TEST_RE.test(path);
}
export const testEditRefusal = (path: string) =>
    ({ error: `Editing test files is not reflected in the grade — the grader strips test-file changes before scoring; fix the source code instead (${path}).` });


// ── State changes by shell command (AgentBench OS tasks graded on the system's state) ─
// A task graded on the state of the system afterwards (runtime.changeRequired) is solved by changing it, not by
// explaining it. v0.72 OS tasks 38, 40, 41 and 42 ("Why can't I use sudo?? fix it.", "Find it and fix it") were
// passed by v0.70 (installed sudo, rewrote /etc/sudoers, removed a SUID bit) and failed by v0.72, which
// diagnosed correctly and then answered with the diagnosis, or asked the user for the error message.
// Commands that change the machine without writing a file the tool layer reports: packages, permissions,
// ownership, accounts, services, moves and removals. Only successful runs are looked at by the caller.
const _STATE_CHANGE_RE = /(?:^|[\s;&|(`])(?:sudo\s+)?(?:apt(?:-get)?\s+(?:install|remove|purge|upgrade|reinstall)\b|dpkg\s+-[ir]\b|pip3?\s+(?:install|uninstall)\b|(?:chmod|chown|chgrp|usermod|useradd|userdel|groupadd|adduser|passwd|visudo|setfacl|chattr|mkdir|touch|rm|mv|cp|ln|tee|kill|pkill|install)\s|systemctl\s+(?:start|stop|restart|enable|disable|reload|mask|unmask)\b|service\s+\S+\s+(?:start|stop|restart)\b|sysctl\s+-w\b|sed\s+(?:-\w+\s+)*-i\b)/;
export function changesState(code: string): boolean {
    return _STATE_CHANGE_RE.test(code ?? '');
}


const BENCH_GATES: CompletionGate[] = [noEdit, noChangeFix, blockedUntried];

/** Plug the benchmark policies into the product. Idempotent. */
export function installBenchPolicy(): void {
    installTaskPolicy({
        editRequired, changeRequired, gradedTestIds: _gradedTestIds, gradedTestFailed: _gradedTestFailed, changesState,
        isTestEditProtected, testEditRefusal, completionDirective, retryDirective,
    });
    for (const g of BENCH_GATES) if (!COMPLETION_GATES.includes(g)) COMPLETION_GATES.push(g);
}

/** Take them out again (tests). */
export function uninstallBenchPolicy(): void {
    resetTaskPolicy();
    for (const g of BENCH_GATES) { const i = COMPLETION_GATES.indexOf(g); if (i >= 0) COMPLETION_GATES.splice(i, 1); }
}
