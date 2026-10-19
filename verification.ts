// verification.ts — what a finished run can truthfully say about its change.
//
// `finish.signal: complete` is a control-flow outcome: the agent said it was done. It does not say that the
// change was checked. v0.70 SWE Lite had 24 `complete` signals and 10 resolved; Flask 4992 passed completion
// with a mock-class test and then an import failure. The four states are derived from the step records the
// run already produces:
//   no_change            nothing in the workspace was changed
//   unverified           changed, and no check ran after the last change
//   verified             changed, and a test/compile check run after the last change exited 0
//   failed_verification  changed, and the last check after the last change failed
// A check that never ran a test (pytest exit 4/5 "collected 0 items", a command that was not found) is
// neither: v0.72 Lite had 11 of 17 failed_verification runs whose last "check" was a graded test id that does
// not exist in the checkout (the real tests arrive with the grader's patch) or a missing `pytest`. Such a run
// is `unverified`.
export type Verification = 'no_change' | 'unverified' | 'verified' | 'failed_verification';

import { shellWrites } from './shell-writes.js';

const WRITE_TOOLS = new Set(['write_file', 'replace_in_file', 'apply_patch', 'append_file', 'undo_write', 'delete_file']);
// Test runners, compilers and syntax checks. A script that merely ran is not a check.
const CHECK_RE = /\b(?:pytest|py\.test|unittest|nosetests|tox|nox|manage\.py\s+test|npm\s+(?:run\s+)?test|yarn\s+test|pnpm\s+test|go\s+test|cargo\s+(?:test|check|build)|make\s+(?:test|check)|mvn\s+(?:-\S+\s+)*test|gradle\s+test|ctest|jest|vitest|rspec|phpunit|py_compile|compileall|node\s+--check|tsc\b|check_page)\b/;
// Collection and import failures of the environment, not of the code under test.
const ENV_BROKEN_RE = /ModuleNotFoundError|ImportError|cannot import name|No module named|ERROR collecting|INTERNALERROR|conftest\.py.*(?:Error|error)|was removed in the NumPy|has no attribute '(?:Mapping|MutableMapping|Iterable|Callable|unicode_)'/;
const SCRATCH_RE = /(?:^|\/)(?:tmp|temp|scratch|repro\w*|reproduc\w*|debug\w*|_probe\w*)(?:[_./-]|$)|\.(?:tmp|bak|orig|pyc)$|__pycache__|\.pytest_cache/i;

interface VerificationState { edits: number; changedSinceCheck: boolean; lastCheck: 'pass' | 'fail' | null }
export const newVerification = (): VerificationState => ({ edits: 0, changedSinceCheck: false, lastCheck: null });

function _changed(call: any): boolean {
    const r = call?.result;
    if (!call || !r || typeof r !== 'object' || r.error) return false;
    if (WRITE_TOOLS.has(call.name)) {
        return !SCRATCH_RE.test(String(call.args?.path ?? call.result?.path ?? ''));
    }
    if (call.name === 'execute_code') {
        if (Array.isArray(r.files_written) && r.files_written.length)
            return r.files_written.some((f: any) => typeof f === 'string' && !SCRATCH_RE.test(f));
        // Task containers do not report files_written: read the command (redirects, tee, in-place
        // edits, patch / git apply). v0.70: 3 of the resolved SWE patches were made this way.
        if (r.exit_code !== 0 && r.exit_code != null) return false;
        const code = String(call.args?.code ?? '');
        const lang = String(call.args?.language ?? 'bash');
        if (lang === 'bash' || lang === 'sh' || lang === 'shell') {
            const w = shellWrites(code);
            // A patch applied from /tmp still changed the workspace: its own path says nothing.
            if (w.patched) return true;
            if (w.paths.some(p => !SCRATCH_RE.test(p))) return true;
        }
        const m = code.match(/open\(\s*['"]([^'"]+)['"]\s*,\s*['"][wa]/);
        if (m) return !SCRATCH_RE.test(m[1]);
    }
    return false;
}
// A runner that started and ran no test: pytest's "collected 0 items" / "no tests ran" (exit 4 usage error, 5 no
// tests), unittest's "Ran 0 tests", Django's "Found 0 test(s)", a runner that is not installed (126/127).
const NO_TESTS_RE = /collected 0 items|\bno tests ran\b|no tests collected|ERROR: (?:file or directory )?not found|\bRan 0 tests\b|Found 0 test\(s\)|command not found|: not found$/m;
function _isCheckCall(call: any): boolean {
    return call?.name === 'execute_code' && CHECK_RE.test(String(call.args?.code ?? ''));
}
/** The call was a check command, but nothing was tested (see the header). */
export function checkDidNotRun(call: any): boolean {
    if (!_isCheckCall(call)) return false;
    const r = call.result;
    if (!r || typeof r !== 'object' || r.exit_code == null) return false;
    if (r.exit_code === 126 || r.exit_code === 127) return true;
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    // A failing run that happens to print "not found" in a test's own message is a failure; only the
    // runner's own "nothing collected" banners count, and for exit 0 only when no test ran.
    if ((r.exit_code === 4 || r.exit_code === 5) && /\b(?:pytest|py\.test)\b/.test(String(call.args?.code ?? ''))) return true;
    return NO_TESTS_RE.test(out) && !/\b[1-9]\d* (?:passed|failed|errors?)\b/.test(out);
}
function _check(call: any): 'pass' | 'fail' | null {
    if (!_isCheckCall(call)) return null;
    const r = call.result;
    if (!r || typeof r !== 'object' || r.exit_code == null) return null;
    if (checkDidNotRun(call)) return null;
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    // Exit 0 with a runner that printed failures (a wrapper that swallows the status) is not a pass.
    // "0 failed" and tsc's "Found 0 errors." are passes: the count must be non-zero.
    if (r.exit_code === 0 && !/\b[1-9]\d* (?:failed|errors?)\b|^FAILED\b|Traceback \(most recent call last\)/m.test(out)) return 'pass';
    // The check could not run (old repository, newer Python/NumPy installed): says nothing about the change.
    if (ENV_BROKEN_RE.test(out)) return null;
    return 'fail';
}

/** Fold one step record (as written to the run log) into the state. */
export function noteStep(st: VerificationState, record: { toolCalls?: any[] } | null | undefined): VerificationState {
    for (const c of record?.toolCalls ?? []) {
        if (_changed(c)) { st.edits++; st.changedSinceCheck = true; st.lastCheck = null; }
        const k = _check(c);
        if (k) { st.lastCheck = k; st.changedSinceCheck = false; }
    }
    return st;
}

export function verdict(st: VerificationState): Verification {
    if (st.edits === 0) return 'no_change';
    if (st.changedSinceCheck || st.lastCheck === null) return 'unverified';
    return st.lastCheck === 'pass' ? 'verified' : 'failed_verification';
}
