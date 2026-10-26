// error-taxonomy.test.ts — the ENV_MISSING_RE boundary of failStreakKind: which failed tool calls the loop
// excuses as an environment problem and which it counts. The corpus replay (real failures from benchmark
// runs) lives with the benchmark suite.
import { describe, it, expect } from 'vitest';
import { failStreakKind, noteAgentFiles, resetAgentFiles } from '../detectors.ts';

// Read-only tools, as llm-loops.ts passes them: a read that fails is neutral, never a failure.
const RO = new Set(['read_file', 'list_files', 'search_workspace', 'fetch_url', 'repo_map', 'web_search']);

// Inline cases: they cover the ENV_MISSING_RE boundary.
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
