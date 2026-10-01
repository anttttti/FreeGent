// pyodide-run.ts on a real Pyodide: the program runs from its exact source, with sys.path as
// CPython sets it. (Output, exit status and file sync are compared with CPython by
// scripts/exec-diff.sh.)
import { runInPyodide } from '../pyodide-run';
import { loadNodePyodide } from './parity-utils';

let py: any;
beforeAll(async () => { py = await loadNodePyodide(); }, 60_000);
const run = (code: string, files: Record<string, string> = {}) => runInPyodide(py, { code, files });

describe('pyodide-run', () => {
    it('keeps whitespace-only lines inside string literals (Pyodide\'s eval_code emptied them)', async () => {
        const r = await run('code = """def f():\n    x = 1\n    \n    return x\n"""\nprint(repr(code))');
        expect(r.stdout).toBe("'def f():\\n    x = 1\\n    \\n    return x\\n'\n");
    });

    it('still runs code that is indented as a whole, and reports real indentation errors', async () => {
        expect((await run('    x = 1\n    print(x + 1)')).stdout).toBe('2\n');
        const bad = await run('x = 1\n  print(x)');
        expect([bad.exit_code, /IndentationError/.test(bad.stderr)]).toEqual([1, true]);
    });

    it('supports top-level await', async () => {
        expect((await run('import asyncio\nawait asyncio.sleep(0)\nprint("awaited")')).stdout).toBe('awaited\n');
    });

    it('starts sys.path with "" as python3 -c does; workspace sub-folders come after the standard library', async () => {
        const files = { 'lib/string.py': 'SHADOW = True\n', 'lib/helper.py': 'VALUE = 7\n' };
        const r = await run([
            'import sys, string',
            'print(repr(sys.path[0]), hasattr(string, "ascii_letters"), hasattr(string, "SHADOW"))',
            'import helper',
            'print(helper.VALUE)',
        ].join('\n'), files);
        expect(r.stdout).toBe("'' True False\n7\n");
    });
});
