import type { Command, CommandContext } from './index';

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

async function ensurePyodide(ctx: CommandContext): Promise<any> {
  if (pyodide) return pyodide;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    ctx.stdout += 'Loading Python (Pyodide)... ';

    // Load Pyodide loader script via importScripts-like eval
    const loaderUrl = `${PYODIDE_CDN}/pyodide.mjs`;
    const mod = await import(/* @vite-ignore */ loaderUrl);
    const loadPyodide = mod.loadPyodide || mod.default?.loadPyodide;
    if (!loadPyodide) throw new Error('Failed to load Pyodide loader');

    pyodide = await loadPyodide({
      indexURL: PYODIDE_CDN,
    });

    ctx.stdout += 'done.\n';
    return pyodide;
  })();

  try {
    return await loadPromise;
  } catch (err) {
    loadPromise = null;
    throw err;
  }
}

/** Mount Shiro FS files into Pyodide's virtual FS */
async function syncToNative(py: any, ctx: CommandContext, dir: string) {
  try {
    // Create /shiro mount point in Pyodide's FS
    try { py.FS.mkdir('/shiro'); } catch { /* exists */ }

    // Copy files from Shiro FS into Pyodide's in-memory FS
    const entries = await ctx.fs.readdir(dir);
    for (const entry of entries) {
      if (entry === '.git') continue;
      const fullPath = dir === '/' ? '/' + entry : dir + '/' + entry;
      const pyPath = '/shiro' + fullPath;
      try {
        const stat = await ctx.fs.stat(fullPath);
        if (stat.isDirectory()) {
          try { py.FS.mkdir(pyPath); } catch { /* exists */ }
          await syncToNative(py, ctx, fullPath);
        } else {
          const content = await ctx.fs.readFile(fullPath);
          const dir = pyPath.split('/').slice(0, -1).join('/');
          try { py.FS.mkdirTree(dir); } catch { /* exists */ }
          if (content instanceof Uint8Array) {
            py.FS.writeFile(pyPath, content);
          } else {
            py.FS.writeFile(pyPath, content as string);
          }
        }
      } catch { /* skip unreadable files */ }
    }
  } catch { /* non-fatal */ }
}

/** Snapshot mtime (ms) of every file under a Pyodide FS directory tree. */
function snapshotMtimes(py: any, dir: string, out = new Map<string, number>()): Map<string, number> {
  let entries: string[];
  try { entries = py.FS.readdir(dir); } catch { return out; }
  for (const entry of entries) {
    if (entry === '.' || entry === '..') continue;
    const pyPath = `${dir}/${entry}`;
    try {
      const st = py.FS.stat(pyPath);
      if (py.FS.isDir(st.mode)) {
        snapshotMtimes(py, pyPath, out);
      } else {
        // Emscripten mtime may be a Date object or a number
        const ms = st.mtime instanceof Date ? st.mtime.getTime() : (st.mtime ?? 0);
        out.set(pyPath, ms);
      }
    } catch {}
  }
  return out;
}

/**
 * Sync files written by Python back to Shiro FS (→ IDB for /workspace paths).
 *
 * `beforeMtimes` is a snapshot taken just after syncToNative ran (the initial
 * seeding of Pyodide's FS from the workspace).  Only files whose mtime changed —
 * i.e. Python modified or created them — are written back, avoiding a flood of
 * unnecessary IDB writes (each of which triggers renderFileList()).
 *
 * Two trees are checked:
 *   /shiro/<shellpath>   — relative-path writes when CWD was /shiro/workspace
 *   /workspace/<name>    — absolute /workspace/… writes
 */
async function syncFromNative(py: any, ctx: CommandContext, beforeMtimes: Map<string, number>) {
  const walkAndSync = async (pyDir: string, shellDir: string) => {
    let entries: string[];
    try { entries = py.FS.readdir(pyDir); } catch { return; }
    for (const entry of entries) {
      if (entry === '.' || entry === '..') continue;
      const pyPath = `${pyDir}/${entry}`;
      const shellPath = `${shellDir}/${entry}`;
      try {
        const st = py.FS.stat(pyPath);
        if (py.FS.isDir(st.mode)) {
          await walkAndSync(pyPath, shellPath);
        } else {
          // Skip files that Python did not touch (mtime unchanged since seeding)
          const prevMs = beforeMtimes.get(pyPath);
          const curMs  = st.mtime instanceof Date ? st.mtime.getTime() : (st.mtime ?? 0);
          if (prevMs !== undefined && prevMs === curMs) continue;
          // readFile returns Uint8Array; FWFileSystem.writeFile handles binary vs text
          const bytes: Uint8Array = py.FS.readFile(pyPath);
          await ctx.fs.writeFile(shellPath, bytes);
        }
      } catch { /* skip unreadable or vanished entries */ }
    }
  };

  // Case 1: relative-path writes (most common) — CWD was /shiro/workspace
  //   /shiro/workspace/foo.xlsx → /workspace/foo.xlsx in Shiro shell → IDB
  await walkAndSync('/shiro', '/').catch(() => {});
  // Case 2: absolute-path writes — Python used open('/workspace/foo', ...)
  //   Pyodide /workspace/foo → Shiro shell /workspace/foo → IDB
  await walkAndSync('/workspace', '/workspace').catch(() => {});
}

export const pythonCmd: Command = {
  name: 'python',
  description: 'Python interpreter (Pyodide)',
  async exec(ctx: CommandContext) {
    let py: any;
    try {
      py = await ensurePyodide(ctx);
    } catch (err: any) {
      ctx.stderr = `error: failed to load Pyodide: ${err.message}\n`;
      return 1;
    }

    const args = ctx.args;

    // python3 -c "code"
    const cIdx = args.indexOf('-c');
    if (cIdx !== -1 && args[cIdx + 1]) {
      const code = args[cIdx + 1];
      const beforeMtimes = snapshotMtimes(py, '/shiro');
      let exitCode = 0;
      try {
        // Set up sys.argv
        py.runPython(`import sys; sys.argv = ['python', '-c']`);
        // Redirect stdout/stderr
        py.runPython(`
import sys, io
_shiro_out = io.StringIO()
_shiro_err = io.StringIO()
sys.stdout = _shiro_out
sys.stderr = _shiro_err
`);
        py.runPython(code);
        const stdout = py.runPython('_shiro_out.getvalue()');
        const stderr = py.runPython('_shiro_err.getvalue()');
        py.runPython('sys.stdout = sys.__stdout__; sys.stderr = sys.__stderr__');
        if (stdout) ctx.stdout += stdout;
        if (stderr) ctx.stderr += stderr;
        exitCode = stderr ? 1 : 0;
      } catch (err: any) {
        ctx.stderr = err.message + '\n';
        exitCode = 1;
      } finally {
        // Sync any files Python wrote back to Shiro FS / IDB workspace
        await syncFromNative(py, ctx, beforeMtimes);
      }
      return exitCode;
    }

    // python3 script.py [args...]
    const scriptArg = args.find(a => !a.startsWith('-'));
    if (scriptArg) {
      const scriptPath = ctx.fs.resolvePath(scriptArg, ctx.cwd);
      let content: string;
      try {
        content = await ctx.fs.readFile(scriptPath, 'utf8') as string;
      } catch {
        ctx.stderr = `python: can't open file '${scriptArg}': [Errno 2] No such file or directory\n`;
        return 2;
      }

      // Sync CWD to Pyodide FS
      await syncToNative(py, ctx, ctx.cwd);
      // Snapshot mtimes after seeding so syncFromNative can skip unchanged files
      const beforeMtimes = snapshotMtimes(py, '/shiro');

      let exitCode = 0;
      try {
        py.runPython(`
import sys, io, os
sys.argv = ${JSON.stringify(['python', scriptArg, ...args.slice(args.indexOf(scriptArg) + 1)])}
os.chdir('/shiro${ctx.cwd}')
_shiro_out = io.StringIO()
_shiro_err = io.StringIO()
sys.stdout = _shiro_out
sys.stderr = _shiro_err
`);
        py.runPython(content);
        const stdout = py.runPython('_shiro_out.getvalue()');
        const stderr = py.runPython('_shiro_err.getvalue()');
        py.runPython('sys.stdout = sys.__stdout__; sys.stderr = sys.__stderr__');
        if (stdout) ctx.stdout += stdout;
        if (stderr) ctx.stderr += stderr;
        exitCode = stderr ? 1 : 0;
      } catch (err: any) {
        ctx.stderr = err.message + '\n';
        exitCode = 1;
      } finally {
        // Sync any files Python wrote back to Shiro FS / IDB workspace
        await syncFromNative(py, ctx, beforeMtimes);
      }
      return exitCode;
    }

    // Interactive REPL
    if (!ctx.terminal) {
      ctx.stderr = 'python: interactive mode requires a terminal\n';
      return 1;
    }

    const term = ctx.terminal;
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
              // Use exec for statements, eval for expressions
              try {
                const result = py.runPython(`
try:
    _r = eval(${JSON.stringify(input)})
    if _r is not None:
        print(repr(_r))
except SyntaxError:
    exec(${JSON.stringify(input)})
`);
              } catch {}
              const stdout = py.runPython('_shiro_out.getvalue()');
              const stderr = py.runPython('_shiro_err.getvalue()');
              py.runPython('sys.stdout = sys.__stdout__; sys.stderr = sys.__stderr__');
              if (stdout) term.writeOutput(stdout.replace(/\n/g, '\r\n'));
              if (stderr) term.writeOutput(stderr.replace(/\n/g, '\r\n'));
            } catch (err: any) {
              term.writeOutput(err.message.replace(/\n/g, '\r\n') + '\r\n');
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
  },
};

export const python3Cmd: Command = {
  ...pythonCmd,
  name: 'python3',
  description: 'Python 3 interpreter (Pyodide)',
};

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
  },
};
