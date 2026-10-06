// error-taxonomy.test.ts — what the loop does with each class of failed tool call.
//
// The cases come from bench/dev-tests/error-taxonomy/cases.jsonl: real failures from benchmark
// runs, classified by extract.py. bench/ is gitignored, so the corpus tests are skipped on a
// checkout without it (CI); the inline tests at the bottom run everywhere.
//
// Three things are checked, in order of how much they have caught:
//   1. signature quality — failureSignature() must name the cause, not the runner's footer.
//      Bench logs are full of pytest/node runs whose last line is "FAILED (failures=1)" or
//      "Node.js v22.23.1"; fingerprinting those made unrelated failures look identical.
//   2. taxonomy parity — the extractor's class must agree with the runtime's own view of the
//      same failure (ENV_MISSING_RE, failStreakKind). When they disagree the loop stops for the
//      wrong reason, which is a bug in one of the two.
//   3. guard behaviour — each class replays through failStreakKind and must get the treatment
//      the loop's guards give it.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failStreakKind, failureSignature, isEnvMissing, noteAgentFiles, resetAgentFiles } from '../detectors.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CASES = join(ROOT, 'bench/dev-tests/error-taxonomy/cases.jsonl');

type Case = {
    tool: string;
    class: string;
    sig: string;
    suite: string;
    count: number;
    result: Record<string, any>;
};

// Read-only tools, as llm-loops.ts passes them: a read that fails is neutral, never a failure.
const RO = new Set(['read_file', 'list_files', 'search_workspace', 'fetch_url', 'repo_map', 'web_search']);

// extract.py files "cannot import name … (/workspace/…)" under env_missing, but the name is missing
// from the agent's own checkout — a code failure. The runtime rightly counts it, so the parity
// checks leave these out rather than assert the extractor's mislabel.
const fromWorkspace = (c: Case) => /\(\/workspace\//.test(c.sig);

const CASES_PRESENT = existsSync(CASES);
const cases: Case[] = CASES_PRESENT
    ? readFileSync(CASES, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [];

// Output that names no cause — a closing banner. failureSignature() must never return one.
const BANNER = /^(?:[-=_*#~]{3,}|\d+ (?:passed|failed|error|warning)s?\b.*|FAILED\b.*|OK\b.*|PASSED\b.*|Node\.js v[\d.]+|Python [\d.]+$|short test summary info.*)$/i;

describe.skipIf(!CASES_PRESENT)(`error taxonomy (${cases.length} cases from bench logs)`, () => {

    // ── 1. The signature names the cause ─────────────────────────────────────
    it('never fingerprints a runner footer as the error', () => {
        const banners = cases.filter(c => BANNER.test(failureSignature(c.result).trim()));
        expect(banners.map(c => c.sig)).toEqual([]);
    });

    it('takes the cause, not the footer, out of a multi-line failure', () => {
        // pytest's cause line, then its summary banner, then the FAILED line, then the count
        // banner. Every line after the first names the failure less precisely than it does.
        const pytest = { stderr: 'E   TypeError: unique requires a Series\n'
                               + '=========================== short test summary info ===\n'
                               + 'FAILED tests/test_x.py::test_y - TypeError: unique requires a Series\n'
                               + '========================= 1 failed in 2.31s =========================\n' };
        expect(failureSignature(pytest)).toBe('E   TypeError: unique requires a Series');
        const node = { stderr: "Error: Cannot find module 'left-pad'\n    at ModuleLoader.resolve\nNode.js v22.23.1\n" };
        expect(failureSignature(node)).toBe('at ModuleLoader.resolve');
    });

    it('separates two failures that share a footer', () => {
        const one = failureSignature({ stderr: 'E   ValueError: bad int\nFAILED (failures=1)\n' });
        const two = failureSignature({ stderr: 'E   KeyError: missing\nFAILED (failures=1)\n' });
        expect(one).not.toBe(two);
        expect(one).toContain('ValueError');
        expect(two).toContain('KeyError');
    });

    it('skips the pytest warnings summary', () => {
        // The summary follows the failures; its last line is the source line of a warning that
        // has nothing to do with them. Both of these were signed "import cgi".
        const warnings = '=============================== warnings summary ===============================\n'
                       + 'django/http/request.py:1\n'
                       + "  /workspace/django/http/request.py:1: DeprecationWarning: 'cgi' is deprecated and slated for removal in Python 3.13\n"
                       + '    import cgi\n\n'
                       + '-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html\n';
        const deselected = { exit_code: 5, stderr: '', stdout: 'rootdir: /workspace\n'
                               + 'collected 83 items / 83 deselected / 0 selected\n\n' + warnings
                               + '====================== 83 deselected, 2 warnings in 0.34s ======================\n' };
        expect(failureSignature(deselected)).toBe('collected 83 items / 83 deselected / 0 selected');
        const failed = { exit_code: 1, stderr: '', stdout: 'collected 1 item\n\n'
                               + "E       AttributeError: module 'collections' has no attribute 'Callable'\n\n" + warnings
                               + '========================= 1 failed, 1 warning in 0.10s =========================\n' };
        expect(failureSignature(failed)).toBe("E       AttributeError: module 'collections' has no attribute 'Callable'".trim());
    });

    it('names why pytest collected nothing', () => {
        const missing = { exit_code: 4, stderr: '', stdout: 'rootdir: /home/node\n'
                               + 'collecting ... ERROR: file or directory not found: tests/test_x.py::test_y\n\n'
                               + 'collected 0 items\n\n'
                               + '============================ no tests ran in 0.00s =============================\n' };
        expect(failureSignature(missing)).toBe('ERROR: file or directory not found: tests/test_x.py::test_y');
        // No ERROR line: the count is all pytest said.
        expect(failureSignature({ exit_code: 5, stdout: 'collected 0 items\n\n==== no tests ran in 0.00s ====\n' })).toBe('collected 0 items');
    });

    it('still returns something for output that is only noise', () => {
        expect(failureSignature({ stderr: '---' })).toBe('---');
        expect(failureSignature({})).toBe('');
    });

// ── 2. The extractor's taxonomy agrees with the runtime ──────────────────
// Scoped to execute_code on purpose: the env exemption is that tool's alone. A write tool that
// fails is 'fail' whatever the reason — the edit didn't land, and progress stops there.
    it('every env_missing execute_code case is one the runtime also reads as missing env', () => {
        const disagree = cases
            .filter(c => c.class === 'env_missing' && c.tool === 'execute_code' && !fromWorkspace(c))
            // isEnvMissing is applied to stderr+stdout, as failStreakKind does.
            .filter(c => !isEnvMissing(`${c.result.stderr ?? ''}\n${c.result.stdout ?? ''}`))
            .map(c => `${c.tool}: ${c.sig}`);
        expect(disagree).toEqual([]);
    });

    it('every env_missing execute_code case is neutral to the failure streak', () => {
        const disagree = cases
            .filter(c => c.class === 'env_missing' && c.tool === 'execute_code' && !fromWorkspace(c))
            .filter(c => failStreakKind(c.tool, c.result, RO) !== 'neutral')
            .map(c => `${c.tool}: ${c.sig.slice(0, 60)}`);
        expect(disagree).toEqual([]);
    });

    // ── 3. Each class gets the treatment the guards give it ──────────────────
    it('a read-only failure never counts against the streak', () => {
        for (const c of cases.filter(c => RO.has(c.tool))) {
            expect(failStreakKind(c.tool, c.result, RO)).toBe('neutral');
        }
    });

    it('a write failure counts, whatever the class', () => {
        // replace_in_file/write_file/apply_patch failing means the edit didn't land — progress
        // stops there regardless of why. readOnly doesn't cover them.
        const writes = cases.filter(c => /^(write_file|replace_in_file|apply_patch)$/.test(c.tool));
        expect(writes.length).toBeGreaterThan(0);
        for (const c of writes) {
            expect(failStreakKind(c.tool, c.result, RO)).toBe('fail');
        }
    });

    // Only the env exemption is asserted per class, and only in the direction that can hold: the
    // extractor sees one signature line, while ENV_MISSING_RE is tested against the whole of
    // stderr+stdout, so the runtime may excused a failure the extractor's line didn't reveal.
    // "env_missing ⇒ neutral" is the invariant; the reverse is not, and isn't claimed.
    it('a non-zero execute_code exit is a failure or excused, never progress', () => {
        const wrong = cases
            .filter(c => c.tool === 'execute_code' && c.result.exit_code)
            .map(c => ({ c, kind: failStreakKind(c.tool, c.result, RO) }))
            .filter(({ kind }) => kind === 'progress')
            .map(({ c }) => `${c.class}: ${c.sig.slice(0, 70)}`);
        expect(wrong).toEqual([]);
    });
});

// Inline cases: run without the bench corpus, so CI covers the ENV_MISSING_RE boundary.
describe('ENV_MISSING_RE boundary', () => {
    const env = (stderr: string) => failStreakKind('execute_code', { exit_code: 1, stderr }, RO);
    it('excuses a name an installed package does not carry', () => {
        expect(env("ImportError: cannot import name 'Minisat' from 'pysat.solvers' (/usr/local/lib/python3.12/dist-packages/pysat/solvers.py)")).toBe('neutral');
        expect(env("ModuleNotFoundError: No module named 'foo'")).toBe('neutral');
    });
    it("counts a module the agent wrote missing an attribute as a failure, an installed package's as environment", () => {
        const msg = (m: string) => `Traceback (most recent call last):\n  File "/workspace/main.py", line 3, in <module>\n    x()\nAttributeError: module '${m}' has no attribute 'serve'`;
        expect(env(msg('app'))).toBe('neutral');          // nothing says app is the agent's
        noteAgentFiles(['/workspace/app.py', 'mypkg/utils.py']);
        expect(env(msg('app'))).toBe('fail');
        expect(env(msg('mypkg.utils'))).toBe('fail');
        expect(env(msg('cv2'))).toBe('neutral');
        resetAgentFiles();
    });
    it("counts an ImportError in the agent's own code as a failure", () => {
        expect(env("ImportError while loading conftest '/workspace/tests/conftest.py'.")).toBe('fail');
        expect(env("ImportError: cannot import name 'helper' from 'mypkg.utils' (/workspace/mypkg/utils.py)")).toBe('fail');
        expect(env('ImportError: attempted relative import with no known parent package')).toBe('fail');
    });
});
