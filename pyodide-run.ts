// pyodide-run.ts — one execute_code Python run on a Pyodide instance, and the encoding of the
// workspace files that go in and come back. Used by pyodide-worker.ts (bundled into the worker)
// and by the page (config.ts runWithPyodide), and tested against CPython by scripts/exec-diff.sh.
//
// Files cross the worker boundary as strings: text as is, binary as "\x00BIN\x00<base64>", and
// images Python wrote as "\x00IMG\x00<mime>\x00<base64>" (shown inline in the chat).

import { imageMimeOfName, DISPLAY_LIBS_RE as _DISPLAY_LIBS } from './mime.js';
import { concatBytes, sameBytes, bytesToBase64, base64ToBytes, isTextBytes, bytesToText } from './shiro/utils/bytes.js';
import { withRuntimeLock } from './shiro/runtime-lock.js';
import { snapshotRuntimeFiles, clearRuntimeDir } from './shiro/runtime-filesystem.js';

export type RunResult = {
    stdout: string;
    stderr: string;
    exit_code: number;
    /** Workspace files the run created or changed (encoded as above), or deleted (null). */
    changedFiles: Record<string, string | null>;
};

const _guessMime = imageMimeOfName;

/** A file's bytes as they cross back to the page: images and non-text tagged, text as is. */
export function encodeOutputFile(name: string, bytes: Uint8Array): string {
    const mime = _guessMime(name);
    if (mime && mime !== 'image/svg+xml') return `\x00IMG\x00${mime}\x00${bytesToBase64(bytes)}`;
    // Text only when it is valid UTF-8 without NULs: decoding anything else would replace or
    // drop bytes (Emscripten's utf8 read also stops at the first NUL), corrupting the file.
    if (isTextBytes(bytes)) return bytesToText(bytes);
    return `\x00BIN\x00${bytesToBase64(bytes)}`;
}

/** A workspace record as the page sends it to the worker. */
export function encodeInputFile(rec: { content: string; encoding?: string | null }): string {
    return rec.encoding === 'base64' ? `\x00BIN\x00${rec.content}` : rec.content;
}

/** What the page stores for a file the run returned: text, or base64 with its image type if any. */
export function decodeOutputFile(content: string): { data: string; encoding: 'base64' | null; imageMime?: string } {
    if (content.startsWith('\x00IMG\x00')) {
        const [, , mime, b64] = content.split('\x00');
        return { data: b64, encoding: 'base64', imageMime: mime };
    }
    if (content.startsWith('\x00BIN\x00')) return { data: content.slice(5), encoding: 'base64' };
    return { data: content, encoding: null };
}

function writeInputFiles(py: any, files: Record<string, string>) {
    for (const [name, content] of Object.entries(files || {})) {
        // Every other entry point goes through workspaceName(); this one must not let a name step
        // out of /workspace in the interpreter's filesystem.
        if (name.startsWith('/') || name.split('/').includes('..')) throw new Error(`Invalid workspace file name: ${name}`);
        const path = `/workspace/${name}`;
        const dir = path.slice(0, path.lastIndexOf('/'));
        if (dir && dir !== '/workspace') py.FS.mkdirTree(dir);
        try { py.FS.unlink(path); } catch {}
        if (typeof content === 'string' && content.startsWith('\x00BIN\x00')) py.FS.writeFile(path, base64ToBytes(content.slice(5)));
        else py.FS.writeFile(path, content ?? '');   // a string is written as UTF-8
    }
}

/** Every file under a directory: relative path → bytes. */
function snapshotDir(py: any, dir: string, prefix = '', out = new Map<string, Uint8Array>()): Map<string, Uint8Array> {
    for (const [path,bytes] of snapshotRuntimeFiles(py.FS,dir,new Map(),true)) out.set((prefix ? prefix + '/' : '') + path.slice(dir.length+1),bytes);
    return out;
}


/** Empties a directory tree in Pyodide's in-memory FS (the directory itself stays). */
export function clearDir(py: any, dir: string) {
    clearRuntimeDir(py.FS,dir);
}

/**
 * Runs the program as `python3 -c` would, in a fresh __main__ namespace (nothing is left from
 * earlier calls, as headless, where each call is a new process): top-level await allowed, tracebacks without Pyodide's own
 * frames and with the program's line numbers, and CPython's exit status — SystemExit's code
 * (None → 0, an int modulo 256, anything else printed to stderr → 1), 1 for an uncaught error.
 * Fresh standard streams each run: a program that closed or replaced sys.stdout would otherwise
 * break every later run of this long-lived interpreter.
 */
const RUNNER = `
async def _fg_exec(src):
    import sys, io, traceback
    import ast, inspect, textwrap
    def stream(fd, mode, errors):
        raw = io.FileIO(fd, mode, closefd=False)
        buf = io.BufferedWriter(raw) if 'w' in mode else io.BufferedReader(raw)
        return io.TextIOWrapper(buf, encoding='utf-8', errors=errors, newline='\\n', write_through=fd == 2)
    sys.stdin = sys.__stdin__ = stream(0, 'rb', 'surrogateescape')
    sys.stdout = sys.__stdout__ = stream(1, 'wb', 'surrogateescape')
    sys.stderr = sys.__stderr__ = stream(2, 'wb', 'backslashreplace')
    sys.argv = ['-c']
    # No __pycache__: it was synced into the workspace, and a .pyc of a module edited within the
    # same second (same size) was imported instead of the edit.
    sys.dont_write_bytecode = True
    import importlib
    importlib.invalidate_caches()
    rc = 0
    try:
        # The source exactly as given (Pyodide's eval_code dedents it, which also empties
        # whitespace-only lines inside string literals: written files lost their indentation).
        # Code indented as a whole (pasted from a block) still runs, dedented.
        flags = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
        try:
            co = compile(src, '<string>', 'exec', flags=flags)
        except IndentationError:
            if not all(l[:1] in (' ', '\t') for l in src.splitlines() if l.strip()):
                raise
            co = compile(textwrap.dedent(src), '<string>', 'exec', flags=flags)
        result = eval(co, {'__name__': '__main__', '__builtins__': __builtins__, '__doc__': None})
        if inspect.iscoroutine(result):
            await result
    except SystemExit as e:
        c = e.code
        if c is None:
            rc = 0
        elif isinstance(c, int):
            rc = c & 0xFF
        else:
            print(c, file=sys.stderr)
            rc = 1
    except BaseException as e:
        tb = e.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename != '<string>':
            tb = tb.tb_next
        traceback.print_exception(type(e), e, tb)
        rc = 1
    finally:
        for f in (sys.stdout, sys.stderr):
            try:
                f.flush()
            except Exception:
                pass
    return rc
`;


/**
 * Runs `code` with /workspace holding `files`, and returns its output and the files it changed.
 * /workspace is emptied afterwards: the page's workspace is the only lasting copy. Callers run
 * one at a time (runs share /workspace).
 */
export function runInPyodide(py:any, input:{code:string; files:Record<string,string>; filepath?:string}): Promise<RunResult> {
    return withRuntimeLock(py,() => runIsolatedInPyodide(py,input));
}

async function runIsolatedInPyodide(py: any, { code, files, filepath }: { code: string; files: Record<string, string>; filepath?: string }): Promise<RunResult> {
    if (_DISPLAY_LIBS.test(code)) {
        const lib = code.match(_DISPLAY_LIBS)?.[1] ?? 'a display library';
        return { stdout: '',
            stderr: `${lib} requires a display and cannot run in Pyodide's Web Worker context (no screen access).\nTry running the logic without the GUI, or use a server-side Python environment.`,
            exit_code: 1, changedFiles: {} };
    }
    try {
        py.FS.mkdirTree('/workspace');
        writeInputFiles(py, files);
        const before = snapshotDir(py, '/workspace');

        // Determine the file's own directory so sibling modules are importable.
        const fileDir = filepath
            ? '/workspace/' + filepath.replace(/[^/]+$/, '').replace(/\/$/, '')
            : '/workspace';
        const workDir = fileDir || '/workspace';

        // sys.path as CPython starts it: the script's folder first (python3 -c: '' — the cwd).
        // Workspace sub-folders holding .py files come last, so `import browser_display` finds
        // /workspace/stock_market_app/browser_display.py but a repo's types.py or string.py
        // doesn't shadow the standard library (they were put first).
        const first = filepath ? workDir : '';
        const extraPaths = new Set<string>();
        for (const name of Object.keys(files || {})) {
            if (!name.endsWith('.py')) continue;
            const slash = name.lastIndexOf('/');
            if (slash > 0) extraPaths.add('/workspace/' + name.slice(0, slash));
        }

        // Each run starts as a new python3 process would: the environment and sys.path as they
        // were before the first run, no open matplotlib figures (and, in RUNNER, fresh names).
        await py.runPythonAsync(`
import sys, os
if '_fg_base' not in globals():
    _fg_base = (dict(os.environ), list(sys.path))
os.environ.clear()
os.environ.update(_fg_base[0])
sys.path[:] = [${JSON.stringify(first)}] + [_p for _p in _fg_base[1] if _p not in ('', '/workspace')]
for _p in ${JSON.stringify([...extraPaths])}:
    if _p not in sys.path:
        sys.path.append(_p)
if 'matplotlib.pyplot' in sys.modules:
    sys.modules['matplotlib.pyplot'].close('all')
# Every module loaded from the workspace is loaded again, packages included: a package kept
# its old submodule as an attribute, so \`from pkg import mod\` returned the module before an edit.
for _k, _m in list(sys.modules.items()):
    _where = [str(getattr(_m, '__file__', '') or '')] + [str(p) for p in (getattr(_m, '__path__', None) or [])]
    if any(w == '/workspace' or w.startswith('/workspace/') for w in _where):
        del sys.modules[_k]
os.makedirs(${JSON.stringify(workDir)}, exist_ok=True)
os.chdir(${JSON.stringify(workDir)})
`);

        // Output is taken as bytes: exact, whether or not lines end in a newline.
        const out: Uint8Array[] = [], err: Uint8Array[] = [];
        const capture = (to: Uint8Array[]) => ({ write: (b: Uint8Array) => { to.push(b.slice()); return b.length; }, isatty: false });
        py.setStdout(capture(out));
        py.setStderr(capture(err));
        py.setStdin({ read: () => 0, isatty: false });   // no input: EOF
        let notes = '';
        let exit_code = 0;
        try {
            try {
                await py.loadPackagesFromImports(code);
            } catch (e: any) {
                notes += `Warning: Could not load some built-in packages: ${e.message}\n`;
            }

            // Try micropip only for top-level imports that aren't already importable
            // AND don't correspond to a local .py file or package in the workspace.
            const imports = Array.from(new Set(
                code.match(/^(?:import|from)\s+(\w+)/gm)?.map(m => m.replace(/^(?:import|from)\s+/, '').split(/\s/)[0]) || []
            ));
            if (imports.length > 0) {
                const missing = await py.runPythonAsync(`
import importlib.util, os
def _is_local(name):
    for base in ['/workspace', ${JSON.stringify(workDir)}]:
        if os.path.exists(f'{base}/{name}.py') or os.path.isdir(f'{base}/{name}'):
            return True
    return False
[m for m in ${JSON.stringify(imports)} if importlib.util.find_spec(m) is None and not _is_local(m)]
`);
                const toInstall = missing?.toJs ? missing.toJs() : [];
                missing?.destroy?.();
                if (toInstall.length > 0) {
                    try {
                        await py.runPythonAsync(`import micropip\nawait micropip.install(${JSON.stringify(toInstall)})`);
                    } catch (e: any) {
                        notes += `Warning: Could not install ${toInstall.join(', ')}: ${e.message}\n`;
                    }
                }
            }

            // Force Agg backend before pyplot loads — wasm_backend requires `document` which
            // doesn't exist in a web worker, causing an ImportError at plt.subplots() time.
            // Run on its own so the program's line numbers stay its own.
            if (/\bimport\s+matplotlib\b|from\s+matplotlib\b/.test(code))
                await py.runPythonAsync('import matplotlib\nmatplotlib.use("Agg")');

            await py.runPythonAsync(RUNNER);
            const exec = py.globals.get('_fg_exec');
            try { exit_code = await exec(code); }
            finally { exec.destroy?.(); }
        } catch (e: any) {
            err.push(new TextEncoder().encode(e.message + '\n'));
            exit_code = 1;
        } finally {
            py.setStdout(); py.setStderr(); py.setStdin();
        }

        const after = snapshotDir(py, '/workspace');
        const changedFiles: Record<string, string | null> = {};
        for (const [name, bytes] of after) {
            const was = before.get(name);
            if (!was || !sameBytes(was, bytes)) changedFiles[name] = encodeOutputFile(name, bytes);
        }
        for (const name of before.keys()) if (!after.has(name)) changedFiles[name] = null;

        const dec = new TextDecoder();   // output for the model: invalid UTF-8 shows as U+FFFD
        return { stdout: dec.decode(concatBytes(out)), stderr: notes + dec.decode(concatBytes(err)), exit_code, changedFiles };
    } catch (e: any) {
        return { stdout: '', stderr: e.message, exit_code: 1, changedFiles: {} };
    } finally {
        clearDir(py, '/workspace');
    }
}
