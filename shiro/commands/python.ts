import type { Command, CommandContext } from './index';
import { bytesToText, textToBytes, concatBytes, sameBytes } from '../utils/bytes';
import { withRuntimeLock } from '../runtime-lock';
import { snapshotRuntimeFiles, clearRuntimeDir, stageRuntimePath } from '../runtime-filesystem';

/**
 * python/python3: Python interpreter via Pyodide (WebAssembly CPython)
 *
 * Downloads Pyodide (~12MB) on first use, caches in IndexedDB.
 * Provides full CPython 3.12 with access to Shiro's virtual filesystem.
 *
 * Usage:
 *   python3 -c "print('hello')"     # one-liner
 *   python3 script.py                # run file
 *   python3                          # interactive REPL
 *   pip install numpy                # install packages via micropip
 */

const PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.27.2/full';

let pyodide: any = null;
let loadPromise: Promise<any> | null = null;
let pytestLoadPromise: Promise<void> | null = null;

async function ensurePyodide(ctx: CommandContext): Promise<any> {
  if (pyodide) return pyodide;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    ctx.shell.onProgress?.('Loading Python (Pyodide)...');

    // Load Pyodide loader script via importScripts-like eval
    const loaderUrl = `${PYODIDE_CDN}/pyodide.mjs`;
    const mod = await import(/* @vite-ignore */ loaderUrl);
    const loadPyodide = mod.loadPyodide || mod.default?.loadPyodide;
    if (!loadPyodide) throw new Error('Failed to load Pyodide loader');

    pyodide = await loadPyodide({
      indexURL: PYODIDE_CDN,
    });

    return pyodide;
  })();

  try {
    return await loadPromise;
  } catch (err) {
    loadPromise = null;
    throw err;
  }
}

/**
 * Where a shell path lives in Pyodide's FS: the workspace at /workspace itself — so os.getcwd(),
 * __file__ and tracebacks name the paths the shell and the other tools use — and anything else
 * (the shell's /tmp, /home/user …) under /shiro.
 */
function toPy(shellPath: string): string {
  return shellPath === '/workspace' || shellPath.startsWith('/workspace/') ? shellPath : '/shiro' + shellPath;
}
function fromPy(pyPath: string): string {
  return pyPath.startsWith('/shiro/') ? pyPath.slice('/shiro'.length) : pyPath;
}

/** Copy the Shiro FS tree at dir (the workspace) into Pyodide's FS. */
async function syncToNative(py: any, ctx: CommandContext, dir: string) {
  await stageRuntimePath(py.FS,ctx.fs,dir,{mapPath:toPy});
}

/** Contents of every file under a Pyodide FS directory tree, by path. */
function snapshotFiles(py: any, dir: string, out = new Map<string, Uint8Array>()): Map<string, Uint8Array> {
  return snapshotRuntimeFiles(py.FS,dir,out,true);
}


/**
 * Sync files written by Python back to Shiro FS (→ IDB for /workspace paths).
 *
 * `before` holds the contents seeded into Pyodide's FS from the workspace. Only files whose
 * bytes differ — Python created or changed them — are written back, which avoids a flood of
 * IDB writes (each of which triggers renderFileList()). Contents, not mtimes: a write within
 * the same millisecond as the seeding left the mtime unchanged and was lost. Directories Python
 * made are made in the shell too (the workspace keeps no empty ones, the shell session does).
 *
 * Two trees are checked: /workspace (the workspace) and /shiro (other shell paths, e.g. /tmp).
 */
async function syncFromNative(py: any, ctx: CommandContext, before: Map<string, Uint8Array>) {
  const visited = new Set<string>();

  const walkAndSync = async (pyDir: string) => {
    let entries: string[];
    try { entries = py.FS.readdir(pyDir); } catch(error:any) {
      if (error.errno === 44) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry === '.' || entry === '..') continue;
      const pyPath = `${pyDir}/${entry}`;
      const shellPath = fromPy(pyPath);
      {
        const st = py.FS.lstat(pyPath);
        if (py.FS.isLink(st.mode)) throw new Error(`Cannot synchronize symbolic link: ${pyPath}`);
        if (py.FS.isDir(st.mode)) {
          if (!(await ctx.fs.exists(shellPath))) await ctx.fs.mkdir(shellPath, { recursive: true });
          await walkAndSync(pyPath);
        } else if (py.FS.isFile(st.mode)) {
          visited.add(pyPath);
          const bytes: Uint8Array = py.FS.readFile(pyPath);
          const was = before.get(pyPath);
          if (was && sameBytes(was, bytes)) continue;
          await ctx.fs.writeFile(shellPath, bytes);
        }
      }
    }
  };
  await walkAndSync('/workspace');
  await walkAndSync('/shiro');

  // Sync deletions: files seeded from the shell but gone after the run were deleted by Python.
  for (const pyPath of before.keys()) {
    if (!visited.has(pyPath)) {
      if (await ctx.fs.exists(fromPy(pyPath))) await ctx.fs.unlink(fromPy(pyPath));
    }
  }
}

/**
 * Empties Pyodide's copy of the workspace (/workspace) after a run, once its changes are
 * synced back: the workspace is the only lasting copy, and a kept one would still show files
 * deleted from the workspace since. The next run copies the workspace in again.
 */

/**
 * Python preamble run before every script/one-liner: cwd, sys.path, reloads of workspace
 * modules, and the /workspace alias. Exported for testing.
 */
export function _preamble(cwd: string): string {
  const pyDir = toPy(cwd);
  return `
import sys, os
# The environment and sys.path as they were before the first run, as in a new process.
if '_fg_base' not in globals():
    _fg_base = (dict(os.environ), list(sys.path))
os.environ.clear()
os.environ.update(_fg_base[0])
sys.path[:] = [''] + [_p for _p in _fg_base[1] if _p not in ('', '/workspace')]
if 'matplotlib.pyplot' in sys.modules:
    sys.modules['matplotlib.pyplot'].close('all')
os.makedirs(${JSON.stringify(pyDir)}, exist_ok=True)
os.chdir(${JSON.stringify(pyDir)})
# Workspace modules imported by an earlier run are reloaded, so edits since take effect.
# (packages too: one kept its old submodule as an attribute for \`from pkg import mod\`)
for _k, _m in list(sys.modules.items()):
    _where = [str(getattr(_m, '__file__', '') or '')] + [str(p) for p in (getattr(_m, '__path__', None) or [])]
    if any(w == '/workspace' or w.startswith('/workspace/') for w in _where):
        del sys.modules[_k]
`.trim();
}

/**
 * Runs a program as CPython's command line would: sys.argv as given, a fresh __main__
 * namespace, and the exit status CPython would return — SystemExit's code (None → 0, an int
 * modulo 256, anything else printed to stderr → 1), 1 with a traceback for an uncaught error.
 * kind: 'code' (source, as -c or a script read from stdin), 'path' (a script file), 'module' (-m).
 */
const RUNNER = `
def _fg_run(kind, target, argv, filename='<string>'):
    import sys, os, io, traceback, runpy
    # Fresh standard streams on fds 0-2 for every run, as a new process would have: the
    # interpreter outlives programs, and one that closed or replaced sys.stdout (json.tool closes
    # it) would otherwise break every later run. UTF-8 with surrogateescape, as in a C.UTF-8 locale.
    def stream(fd, mode, errors):
        raw = io.FileIO(fd, mode, closefd=False)
        buf = io.BufferedWriter(raw) if 'w' in mode else io.BufferedReader(raw)
        return io.TextIOWrapper(buf, encoding='utf-8', errors=errors, newline='\\n', line_buffering=False, write_through='w' in mode and fd == 2)
    sys.stdin = sys.__stdin__ = stream(0, 'rb', 'surrogateescape')
    sys.stdout = sys.__stdout__ = stream(1, 'wb', 'surrogateescape')
    sys.stderr = sys.__stderr__ = stream(2, 'wb', 'backslashreplace')
    sys.argv = list(argv)
    # sys.path[0] as CPython sets it: the script's folder, the cwd for -m, '' for -c and stdin.
    if kind == 'path':
        sys.path[0] = os.path.dirname(os.path.abspath(target))
    elif kind == 'module':
        sys.path[0] = os.getcwd()
    # No __pycache__ (it was synced into the workspace, and a .pyc of a module edited within the
    # same second was imported instead of the edit).
    sys.dont_write_bytecode = True
    import importlib
    importlib.invalidate_caches()
    rc = 0
    try:
        if kind == 'module':
            runpy.run_module(target, run_name='__main__', alter_sys=True)
        elif kind == 'path':
            runpy.run_path(target, run_name='__main__')
        else:
            g = {'__name__': '__main__', '__builtins__': __builtins__, '__doc__': None}
            exec(compile(target, filename, 'exec'), g)
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
        # Leave out this runner's frame and runpy's, as CPython's own traceback would.
        while tb is not None and (tb.tb_frame.f_code.co_filename == '<exec>' or 'runpy' in tb.tb_frame.f_code.co_filename):
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
 * Exit status for an error Pyodide raised outside the program (the runner itself failed).
 * Exported for testing.
 */
export function _extractExitCode(err: any, ctx: CommandContext): number {
  const msg: string = err?.message ?? String(err);
  if (err?.type === 'SystemExit' || /^SystemExit/.test(msg)) {
    const match = msg.match(/SystemExit:\s*(-?\d+)/);
    return match ? parseInt(match[1], 10) & 0xff : 0;
  }
  ctx.stderr += msg + '\n';
  return 1;
}

/**
 * Python's command line: [options] (-c code | -m module | script | - | nothing) [args…].
 * Options end at the first of those; everything after is the program's own arguments.
 */
function parseCommandLine(args: string[]): { kind: 'code' | 'module' | 'path' | 'stdin' | 'none'; target: string; argv: string[] } {
  const withValue = new Set(['-W', '-X', '--check-hash-based-pycs']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c') return { kind: 'code', target: args[i + 1] ?? '', argv: ['-c', ...args.slice(i + 2)] };
    if (a.startsWith('-c') && a.length > 2 && !a.startsWith('--')) return { kind: 'code', target: a.slice(2), argv: ['-c', ...args.slice(i + 1)] };
    if (a === '-m') return { kind: 'module', target: args[i + 1] ?? '', argv: ['-m', ...args.slice(i + 2)] };
    if (a.startsWith('-m') && a.length > 2 && !a.startsWith('--')) return { kind: 'module', target: a.slice(2), argv: ['-m', ...args.slice(i + 1)] };
    if (a === '-') return { kind: 'stdin', target: '', argv: ['-', ...args.slice(i + 1)] };
    if (a === '--') { const rest = args.slice(i + 1); return rest.length ? { kind: 'path', target: rest[0], argv: rest } : { kind: 'stdin', target: '', argv: [''] }; }
    if (withValue.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;   // -u, -B, -E, -I, -O, -q, -s, -S, -v, -Wx …: no effect here
    return { kind: 'path', target: a, argv: args.slice(i) };
  }
  return { kind: 'none', target: '', argv: [''] };
}

export const pythonCmd: Command = {
  name: 'python',
  description: 'Python interpreter (Pyodide)',
  async exec(ctx: CommandContext) {
    const cmd = parseCommandLine(ctx.args);
    // No program on the command line: the program is stdin when something is piped in.
    if (cmd.kind === 'none' && ctx.stdin) cmd.kind = 'stdin';
    if (cmd.kind === 'none' && !ctx.terminal) {
      ctx.stderr = 'python: interactive mode requires a terminal\n';
      return 1;
    }
    if (cmd.kind === 'module' && !cmd.target) { ctx.stderr += 'Argument expected for the -m option\n'; return 2; }

    let py: any;
    try {
      py = await ensurePyodide(ctx);
    } catch (err: any) {
      ctx.stderr = `error: failed to load Pyodide: ${err.message}\n`;
      return 1;
    }
    return withRuntimeLock(py,async () => {
    if (cmd.kind === 'none') return repl(py, ctx);

    let target = cmd.target;
    let filename = '<string>';
    let stdinData = ctx.stdin;
    if (cmd.kind === 'stdin') { target = ctx.stdin; filename = '<stdin>'; stdinData = ''; }
    if (cmd.kind === 'path') {
      const scriptPath = ctx.fs.resolvePath(cmd.target, ctx.cwd);
      try {
        const st = await ctx.fs.stat(scriptPath);
        if (st.isDirectory()) throw new Error('directory');
      } catch {
        ctx.stderr = `python: can't open file '${cmd.target}': [Errno 2] No such file or directory\n`;
        return 2;
      }
    }

    // Always sync from workspace root so imports from any directory work
    await syncToNative(py, ctx, '/workspace');
    const before = snapshotFiles(py, '/workspace', snapshotFiles(py, '/shiro'));

    // The program's stdout/stderr are taken as bytes and its stdin given as bytes, so
    // sys.stdout.buffer works and non-UTF-8 output keeps its bytes (utils/bytes.ts).
    const out: Uint8Array[] = [], err: Uint8Array[] = [];
    const capture = (to: Uint8Array[]) => ({ write: (b: Uint8Array) => { to.push(b.slice()); return b.length; }, isatty: false });
    const input = textToBytes(stdinData);
    let inPos = 0;
    py.setStdout(capture(out));
    py.setStderr(capture(err));
    py.setStdin({
      read: (buf: Uint8Array) => { const n = Math.min(buf.length, input.length - inPos); buf.set(input.subarray(inPos, inPos + n)); inPos += n; return n; },
      isatty: false,
    });
    let exitCode = 0;
    try {
      py.runPython(_preamble(ctx.cwd));
      py.runPython(RUNNER);
      const run = py.globals.get('_fg_run');
      const argv = py.toPy(cmd.argv);
      try {
        exitCode = run(cmd.kind === 'stdin' ? 'code' : cmd.kind, target, argv, filename);
      } finally {
        argv.destroy?.();
        run.destroy?.();
      }
    } catch (e: any) {
      exitCode = _extractExitCode(e, ctx);
    } finally {
      // Python's text streams buffer: flush whatever the program left there.
      try { py.runPython('import sys\nfor _f in (sys.stdout, sys.stderr):\n    try: _f.flush()\n    except Exception: pass'); } catch {}
      py.setStdout(); py.setStderr(); py.setStdin();
      ctx.stdout += bytesToText(concatBytes(out));
      ctx.stderr += bytesToText(concatBytes(err));
      try {await syncFromNative(py,ctx,before);}
      finally {clearRuntimeDir(py.FS,'/workspace'); clearRuntimeDir(py.FS,'/shiro');}
    }
    return exitCode;
    });
  },
};


function repl(py: any, ctx: CommandContext): Promise<number> {
  const term = ctx.terminal!;
  const version = py.runPython('import sys; sys.version');
  term.writeOutput(`Python ${version} (Pyodide)\r\nType "exit()" to quit.\r\n`);

  return new Promise<number>((resolve) => {
    let line = '';
    const prompt = '>>> ';
    term.writeOutput(prompt);

    term.enterRawMode((key: string) => {
      if (key === '\r' || key === '\n') {
        term.writeOutput('\r\n');
        const input = line.trim();
        line = '';

        if (input === 'exit()' || input === 'quit()') {
          term.exitRawMode();
          resolve(0);
          return;
        }

        if (input) {
          try {
            py.runPython(`
import sys, io
_shiro_out = io.StringIO()
_shiro_err = io.StringIO()
sys.stdout = _shiro_out
sys.stderr = _shiro_err
`);
            // Use exec for statements, eval for expressions.
            // Capture any runtime exception in evalError so the traceback can
            // be shown after the normal stdout/stderr buffer drain below.
            let evalError: string | null = null;
            try {
              py.runPython(`
try:
  _r = eval(${JSON.stringify(input)})
  if _r is not None:
      print(repr(_r))
except SyntaxError:
  exec(${JSON.stringify(input)})
`);
            } catch (evalErr: any) {
              // Pyodide raises Python exceptions as JS errors; the traceback is
              // in .message.  We handle SystemExit specially.
              const msg: string = evalErr?.message ?? String(evalErr);
              if (evalErr?.type === 'SystemExit' || /^SystemExit/.test(msg)) {
                const m = msg.match(/SystemExit:\s*(-?\d+)/);
                const code = m ? parseInt(m[1], 10) : 0;
                py.runPython('sys.stdout = sys.__stdout__; sys.stderr = sys.__stderr__');
                term.exitRawMode();
                resolve(code);
                return;
              }
              evalError = msg;
            }
            const stdout = py.runPython('_shiro_out.getvalue()');
            const stderr = py.runPython('_shiro_err.getvalue()');
            py.runPython('sys.stdout = sys.__stdout__; sys.stderr = sys.__stderr__');
            if (stdout) term.writeOutput(stdout.replace(/\n/g, '\r\n'));
            if (stderr) term.writeOutput(stderr.replace(/\n/g, '\r\n'));
            if (evalError) term.writeOutput(evalError.replace(/\n/g, '\r\n') + '\r\n');
          } catch (err: any) {
            term.writeOutput((err?.message ?? String(err)).replace(/\n/g, '\r\n') + '\r\n');
          }
        }

        term.writeOutput(prompt);
      } else if (key === '\x7f' || key === '\b') {
        if (line.length > 0) {
          line = line.slice(0, -1);
          term.writeOutput('\b \b');
        }
      } else if (key === '\x03') {
        // Ctrl+C
        term.writeOutput('^C\r\n');
        line = '';
        term.writeOutput(prompt);
      } else if (key === '\x04') {
        // Ctrl+D
        term.writeOutput('\r\n');
        term.exitRawMode();
        resolve(0);
      } else if (key.charCodeAt(0) >= 32) {
        line += key;
        term.writeOutput(key);
      }
    });
  });
}

export const python3Cmd: Command = {
  ...pythonCmd,
  name: 'python3',
  description: 'Python 3 interpreter (Pyodide)',
};

/**
 * Test-only: inject a pre-built Pyodide mock so tests don't hit the CDN.
 * Call before the first exec() in each test; the mock persists until reset.
 * @internal
 */
export function __setPyodideForTest(mock: any): void {
  pyodide = mock;
  loadPromise = null;
  pytestLoadPromise = null;
}

export const pipCmd: Command = {
  name: 'pip',
  description: 'Python package manager',
  async exec(ctx: CommandContext) {
    const args = ctx.args;
    if (args[0] !== 'install' || !args[1]) {
      ctx.stderr = 'usage: pip install <package> [<package>...]\n';
      return 1;
    }

    let py: any;
    try {
      py = await ensurePyodide(ctx);
    } catch (err: any) {
      ctx.stderr = `error: failed to load Pyodide: ${err.message}\n`;
      return 1;
    }

    return withRuntimeLock(py,async () => {
    const packages = args.slice(1).filter(a => !a.startsWith('-'));
    try {
      await py.loadPackage('micropip');
      const micropip = py.pyimport('micropip');
      for (const pkg of packages) {
        ctx.stdout += `Installing ${pkg}...\n`;
        await micropip.install(pkg);
        ctx.stdout += `Successfully installed ${pkg}\n`;
      }
      return 0;
    } catch (err: any) {
      ctx.stderr = `pip: error installing packages: ${err.message}\n`;
      return 1;
    }
    });
  },
};

export const pip3Cmd: Command = {
  ...pipCmd,
  name: 'pip3',
  description: 'Python 3 package manager',
};

/** Load the Pyodide-built pytest package once, reusing the existing Python runtime. */
async function ensurePytest(ctx: CommandContext): Promise<void> {
  if (!pytestLoadPromise) {
    pytestLoadPromise = (async () => {
      const py = await ensurePyodide(ctx);
      await withRuntimeLock(py,async () => {
      const installed = py.runPython('import importlib.util; importlib.util.find_spec("pytest") is not None');
      if (installed) return;
      ctx.shell.onProgress?.('Loading pytest (Pyodide package)...');
      await py.loadPackage('pytest');
      });
    })().catch((err) => {
      pytestLoadPromise = null;
      throw err;
    });
  }
  await pytestLoadPromise;
}

export const pytestCmd: Command = {
  name: 'pytest',
  description: 'Python test runner (Pyodide pytest)',
  async exec(ctx: CommandContext): Promise<number> {
    try {
      await ensurePytest(ctx);
    } catch (err: any) {
      ctx.stderr += `pytest: failed to load: ${err?.message || err}\n`;
      return 1;
    }

    // Delegate argument handling, workspace sync, output capture, and exit codes to Python.
    const pythonCtx: CommandContext = {
      ...ctx,
      args: ['-m', 'pytest', ...ctx.args],
      stdout: '',
      stderr: '',
    };
    const exitCode = await pythonCmd.exec(pythonCtx);
    ctx.stdout += pythonCtx.stdout;
    ctx.stderr += pythonCtx.stderr;
    return exitCode;
  },
};
