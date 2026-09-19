/**
 * Tests for shiro/commands/python.ts — Pyodide-backed Python shell command.
 *
 * Pyodide can't run in a jsdom/Node environment; the `__setPyodideForTest`
 * hook replaces the CDN singleton with a mock object so every test runs
 * without hitting the network.
 */

import {
  pythonCmd,
  python3Cmd,
  pipCmd,
  pip3Cmd,
  _preamble,
  _extractExitCode,
  __setPyodideForTest,
} from '../shiro/commands/python';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Minimal mock CommandContext */
function makeCtx(overrides: Partial<any> = {}): any {
  const files: Record<string, Uint8Array | string> = overrides._files ?? {};
  return {
    args: [],
    cwd: '/workspace',
    env: {},
    stdin: '',
    stdout: '',
    stderr: '',
    shell: {} as any,
    terminal: undefined,
    fs: {
      resolvePath: (p: string, cwd: string) =>
        p.startsWith('/') ? p : cwd + '/' + p,
      readFile: vi.fn(async (path: string) => {
        if (path in files) return files[path];
        throw new Error(`ENOENT: ${path}`);
      }),
      writeFile: vi.fn(async () => {}),
      readdir: vi.fn(async () => []),
      stat: vi.fn(async (path: string) => {
        if (files[path] !== undefined) return { isDirectory: () => false };
        throw new Error(`ENOENT: ${path}`);
      }),
      unlink: vi.fn(async () => {}),
    },
    ...overrides,
  };
}

/**
 * Build a mock Pyodide object whose `runPython` dispatches on well-known
 * sub-strings, so we can assert on what commands were run and control the
 * simulated outputs.
 */
function makePy({
  stdout = '',
  stderr = '',
  throwOn = null as Error | null,
  throwOnce = false,
}: {
  stdout?: string;
  stderr?: string;
  /** Throw this error when runPython is called with user code (not builtins) */
  throwOn?: Error | null;
  throwOnce?: boolean;
} = {}): any {
  let thrown = false;
  const runPythonImpl = vi.fn((code: string): any => {
    // Buffer-read calls
    if (code === '_shiro_out.getvalue()') return stdout;
    if (code === '_shiro_err.getvalue()') return stderr;
    // Stream-restore call
    if (code.includes('sys.stdout = sys.__stdout__')) return undefined;
    // runpy for -m flag
    if (code.includes('runpy.run_module')) {
      if (throwOn && !(throwOnce && thrown)) { thrown = true; throw throwOn; }
      return undefined;
    }
    // sys.version for REPL banner
    if (code.includes('sys.version')) return '3.12.0';
    // Preamble (contains the known StringIO setup) — just run through
    if (code.includes('_shiro_out = io.StringIO()')) return undefined;
    // User code — maybe throw
    if (throwOn && !(throwOnce && thrown)) {
      thrown = true;
      throw throwOn;
    }
    return undefined;
  });
  const FS = {
    mkdir: vi.fn(),
    mkdirTree: vi.fn(),
    readdir: vi.fn(() => [] as string[]),
    stat: vi.fn(() => ({ mode: 0o100644, mtime: 1000 })),
    isDir: vi.fn((_mode: number) => false),
    writeFile: vi.fn(),
    readFile: vi.fn(() => new Uint8Array()),
  };
  return {
    runPython: runPythonImpl,
    FS,
    loadPackage: vi.fn(async () => {}),
    pyimport: vi.fn(() => ({
      install: vi.fn(async () => {}),
    })),
  };
}

beforeEach(() => {
  // Reset the module-level Pyodide singleton before each test
  __setPyodideForTest(null as any);
});

// ── _preamble (pure) ──────────────────────────────────────────────────────────

describe('_preamble', () => {
  it('sets sys.argv', () => {
    const code = _preamble('/workspace', ['python', 'script.py', 'arg1']);
    expect(code).toContain('sys.argv = ["python","script.py","arg1"]');
  });

  it('chdirs to the shiro-mapped cwd', () => {
    const code = _preamble('/workspace', []);
    expect(code).toContain('os.chdir("/shiro/workspace")');
  });

  it('adds shiro cwd and /shiro/workspace to sys.path', () => {
    const code = _preamble('/workspace/src', []);
    // The cwd path is JSON.stringify'd → double-quoted; the fallback literal uses single quotes
    expect(code).toContain('"/shiro/workspace/src"');
    expect(code).toContain("'/shiro/workspace'");
    expect(code).toContain('sys.path.insert(0, _p)');
  });

  it('redirects stdout and stderr to StringIO', () => {
    const code = _preamble('/workspace', []);
    expect(code).toContain('_shiro_out = io.StringIO()');
    expect(code).toContain('_shiro_err = io.StringIO()');
    expect(code).toContain('sys.stdout = _shiro_out');
    expect(code).toContain('sys.stderr = _shiro_err');
  });
});

// ── _extractExitCode (pure) ───────────────────────────────────────────────────

describe('_extractExitCode', () => {
  it('returns 0 for SystemExit with no code', () => {
    const ctx = makeCtx();
    const err = Object.assign(new Error('SystemExit'), { type: 'SystemExit' });
    expect(_extractExitCode(err, ctx)).toBe(0);
    expect(ctx.stderr).toBe('');
  });

  it('returns the numeric code from SystemExit: N', () => {
    const ctx = makeCtx();
    const err = Object.assign(new Error('SystemExit: 42'), { type: 'SystemExit' });
    expect(_extractExitCode(err, ctx)).toBe(42);
    expect(ctx.stderr).toBe('');
  });

  it('returns negative exit codes from SystemExit', () => {
    const ctx = makeCtx();
    const err = { message: 'SystemExit: -1' };
    expect(_extractExitCode(err, ctx)).toBe(-1);
  });

  it('matches SystemExit by message prefix when .type is absent', () => {
    const ctx = makeCtx();
    const err = { message: 'SystemExit: 5' };
    expect(_extractExitCode(err, ctx)).toBe(5);
    expect(ctx.stderr).toBe('');
  });

  it('returns 1 and writes to stderr for non-SystemExit errors', () => {
    const ctx = makeCtx();
    const err = { message: 'NameError: name x is not defined' };
    expect(_extractExitCode(err, ctx)).toBe(1);
    expect(ctx.stderr).toContain('NameError');
  });

  it('handles err without message gracefully', () => {
    const ctx = makeCtx();
    expect(_extractExitCode(null, ctx)).toBe(1);
    expect(ctx.stderr).toBeTruthy();
  });
});

// ── pythonCmd / python3Cmd — basic exec ───────────────────────────────────────

describe('pythonCmd.exec -c', () => {
  it('captures stdout from runPython and returns 0', async () => {
    const py = makePy({ stdout: 'hello world\n' });
    __setPyodideForTest(py);
    const ctx = makeCtx({ args: ['-c', 'print("hello world")'] });
    const code = await pythonCmd.exec(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout).toBe('hello world\n');
    expect(ctx.stderr).toBe('');
  });

  it('captures stderr output without treating it as failure', async () => {
    const py = makePy({ stdout: '', stderr: 'DeprecationWarning: ...\n' });
    __setPyodideForTest(py);
    const ctx = makeCtx({ args: ['-c', 'import warnings'] });
    const code = await pythonCmd.exec(ctx);
    expect(code).toBe(0);
    expect(ctx.stderr).toContain('DeprecationWarning');
  });

  it('returns exit code from SystemExit', async () => {
    const err = Object.assign(new Error('SystemExit: 3'), { type: 'SystemExit' });
    const py = makePy({ throwOn: err });
    __setPyodideForTest(py);
    const ctx = makeCtx({ args: ['-c', 'import sys; sys.exit(3)'] });
    const code = await pythonCmd.exec(ctx);
    expect(code).toBe(3);
    expect(ctx.stderr).toBe('');
  });

  it('returns 1 and writes stderr for unhandled exceptions', async () => {
    const err = new Error('TypeError: unsupported type');
    const py = makePy({ throwOn: err });
    __setPyodideForTest(py);
    const ctx = makeCtx({ args: ['-c', 'bad code'] });
    const code = await pythonCmd.exec(ctx);
    expect(code).toBe(1);
    expect(ctx.stderr).toContain('TypeError');
  });

  it('preserves partial stdout printed before an exception (_tryDrainBuffers)', async () => {
    const partialOutput = 'printed before crash\n';
    const err = new Error('ZeroDivisionError: division by zero');
    const py = makePy({ stdout: partialOutput, throwOn: err });
    __setPyodideForTest(py);
    const ctx = makeCtx({ args: ['-c', 'print("hi"); 1/0'] });
    const code = await pythonCmd.exec(ctx);
    expect(code).toBe(1);
    // Partial output MUST reach ctx.stdout via _tryDrainBuffers
    expect(ctx.stdout).toBe(partialOutput);
  });
});

describe('pythonCmd.exec script.py', () => {
  it('reads the script and runs it', async () => {
    const py = makePy({ stdout: 'from file\n' });
    __setPyodideForTest(py);
    const content = 'print("from file")';
    const ctx = makeCtx({
      args: ['main.py'],
      _files: { '/workspace/main.py': content },
    });
    const code = await pythonCmd.exec(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout).toBe('from file\n');
  });

  it('returns exit code 2 when script file is missing', async () => {
    const py = makePy();
    __setPyodideForTest(py);
    const ctx = makeCtx({ args: ['missing.py'] });
    const code = await pythonCmd.exec(ctx);
    expect(code).toBe(2);
    expect(ctx.stderr).toContain("can't open file 'missing.py'");
  });
});

describe('pythonCmd.exec -m', () => {
  it('runs runpy.run_module for -m flag', async () => {
    const py = makePy({ stdout: 'tests passed\n' });
    __setPyodideForTest(py);
    const ctx = makeCtx({ args: ['-m', 'pytest'] });
    const code = await pythonCmd.exec(ctx);
    expect(code).toBe(0);
    // Verify runpy was called
    const calls = py.runPython.mock.calls.map((c: any[]) => c[0] as string);
    expect(calls.some((c: string) => c.includes('run_module') && c.includes('"pytest"'))).toBe(true);
  });

  it('handles SystemExit from -m run', async () => {
    const err = Object.assign(new Error('SystemExit: 1'), { type: 'SystemExit' });
    const py = makePy({ throwOn: err });
    __setPyodideForTest(py);
    const ctx = makeCtx({ args: ['-m', 'pytest', '--collect-only'] });
    const code = await pythonCmd.exec(ctx);
    expect(code).toBe(1);
  });
});

// ── python3Cmd ────────────────────────────────────────────────────────────────

describe('python3Cmd', () => {
  it('has name "python3"', () => {
    expect(python3Cmd.name).toBe('python3');
  });

  it('behaves identically to pythonCmd for -c', async () => {
    const py = makePy({ stdout: 'py3\n' });
    __setPyodideForTest(py);
    const ctx = makeCtx({ args: ['-c', 'print("py3")'] });
    const code = await python3Cmd.exec(ctx);
    expect(code).toBe(0);
    expect(ctx.stdout).toBe('py3\n');
  });
});

// ── pip / pip3 ─────────────────────────────────────────────────────────────────

describe('pipCmd.exec', () => {
  it('returns exit code 1 and usage message when no package given', async () => {
    const py = makePy();
    __setPyodideForTest(py);
    const ctx = makeCtx({ args: ['install'] });
    const code = await pipCmd.exec(ctx);
    expect(code).toBe(1);
    expect(ctx.stderr).toContain('usage: pip install');
  });

  it('calls micropip.install for each package', async () => {
    const py = makePy();
    __setPyodideForTest(py);
    const installMock = vi.fn(async () => {});
    py.pyimport = vi.fn(() => ({ install: installMock }));
    const ctx = makeCtx({ args: ['install', 'numpy', 'pandas'] });
    const code = await pipCmd.exec(ctx);
    expect(code).toBe(0);
    expect(installMock).toHaveBeenCalledWith('numpy');
    expect(installMock).toHaveBeenCalledWith('pandas');
    expect(ctx.stdout).toContain('Successfully installed numpy');
    expect(ctx.stdout).toContain('Successfully installed pandas');
  });

  it('returns 1 if micropip.install throws', async () => {
    const py = makePy();
    __setPyodideForTest(py);
    const installMock = vi.fn(async () => { throw new Error('Package not found: xxx'); });
    py.pyimport = vi.fn(() => ({ install: installMock }));
    const ctx = makeCtx({ args: ['install', 'xxx'] });
    const code = await pipCmd.exec(ctx);
    expect(code).toBe(1);
    expect(ctx.stderr).toContain('Package not found');
  });

  it('pip3Cmd has name "pip3" and same behaviour', async () => {
    expect(pip3Cmd.name).toBe('pip3');
    const py = makePy();
    __setPyodideForTest(py);
    const installMock = vi.fn(async () => {});
    py.pyimport = vi.fn(() => ({ install: installMock }));
    const ctx = makeCtx({ args: ['install', 'requests'] });
    const code = await pip3Cmd.exec(ctx);
    expect(code).toBe(0);
    expect(installMock).toHaveBeenCalledWith('requests');
  });
});

// ── Pyodide FS sync ───────────────────────────────────────────────────────────

describe('syncToNative: workspace files seeded into Pyodide FS', () => {
  it('seeds files from ctx.fs into py.FS', async () => {
    const py = makePy({ stdout: '' });
    __setPyodideForTest(py);

    // Set up a fake workspace with one file
    const ctx = makeCtx({
      args: ['-c', 'pass'],
      _files: { '/workspace/hello.py': new TextEncoder().encode('print("hi")') },
    });
    // readdir returns the file entry for /workspace
    ctx.fs.readdir = vi.fn(async (dir: string) => {
      if (dir === '/workspace') return ['hello.py'];
      return [];
    });
    ctx.fs.stat = vi.fn(async (path: string) => {
      if (path === '/workspace/hello.py') return { isDirectory: () => false };
      if (path === '/workspace') return { isDirectory: () => true };
      throw new Error(`ENOENT: ${path}`);
    });

    await pythonCmd.exec(ctx);

    // py.FS.writeFile should have been called for hello.py
    const writeCalls = py.FS.writeFile.mock.calls.map((c: any[]) => c[0] as string);
    expect(writeCalls).toContain('/shiro/workspace/hello.py');
  });
});

describe('syncFromNative: changed files written back to ctx.fs', () => {
  it('writes back files created by Python during the run', async () => {
    // A NEW file (no prior mtime in snapshot) should always be written back.
    // We simulate this by having /shiro be empty during snapshotMtimes (before
    // the run) and populated during walkAndSync (after the run).
    const newContent = new Uint8Array([1, 2, 3]);
    const py = makePy({ stdout: '' });
    __setPyodideForTest(py);

    // Track call count: first readdir('/shiro') is the snapshot pass (empty),
    // subsequent calls are the syncFromNative walk (file exists).
    let readdirShiroCount = 0;
    py.FS.readdir = vi.fn((dir: string) => {
      if (dir === '/shiro') {
        readdirShiroCount++;
        // First call = snapshotMtimes → return empty so file has no prior entry
        if (readdirShiroCount === 1) return [];
        // Second call = syncFromNative walk → Python "created" the file
        return ['workspace'];
      }
      if (dir === '/shiro/workspace') return ['output.txt'];
      if (dir === '/workspace') return [];  // absolute-path sync side
      return [];
    });
    py.FS.stat = vi.fn((path: string) => {
      if (path === '/shiro/workspace') return { mode: 0o040755, mtime: 500 };
      if (path === '/shiro/workspace/output.txt') return { mode: 0o100644, mtime: 2000 };
      throw new Error(`ENOENT: ${path}`);
    });
    py.FS.isDir = vi.fn((mode: number) => (mode & 0o040000) !== 0);
    py.FS.readFile = vi.fn(() => newContent);

    const ctx = makeCtx({ args: ['-c', 'pass'] });
    ctx.fs.readdir = vi.fn(async () => []);
    ctx.fs.stat = vi.fn(async () => { throw new Error('ENOENT'); });

    await pythonCmd.exec(ctx);

    // output.txt has no prior mtime → must be written back
    const writeCalls = (ctx.fs.writeFile as any).mock.calls.map((c: any[]) => c[0] as string);
    expect(writeCalls.some((p: string) => p.includes('output.txt'))).toBe(true);
  });

  it('unlinks files deleted by Python (not in visited set)', async () => {
    const py = makePy({ stdout: '' });
    __setPyodideForTest(py);

    // The snapshot will include /shiro/workspace/deleted.txt (mtime 1000)
    // but after the run Pyodide FS is empty — simulating Python deleted it
    let afterRun = false;
    py.FS.readdir = vi.fn((dir: string) => {
      // Before run: snapshotMtimes sees the file; after run: walkAndSync sees nothing
      if (dir === '/shiro') return afterRun ? [] : ['workspace'];
      if (dir === '/shiro/workspace') return afterRun ? [] : ['deleted.txt'];
      return [];
    });
    py.FS.stat = vi.fn((path: string) => {
      if (path === '/shiro/workspace') return { mode: 0o040755, mtime: 500 };
      if (path === '/shiro/workspace/deleted.txt') return { mode: 0o100644, mtime: 1000 };
      throw new Error(`ENOENT: ${path}`);
    });
    py.FS.isDir = vi.fn((mode: number) => (mode & 0o040000) !== 0);

    // Intercept runPython so we can flip afterRun between snapshot and sync
    const originalRunPython = py.runPython;
    let preambleSeen = false;
    py.runPython = vi.fn((code: string) => {
      // After preamble ran and user code executes, flip afterRun
      if (preambleSeen && !code.includes('_shiro_out') && !code.includes('sys.stdout')) {
        afterRun = true;
      }
      if (code.includes('_shiro_out = io.StringIO()')) preambleSeen = true;
      return originalRunPython(code);
    });

    const ctx = makeCtx({ args: ['-c', 'import os; os.remove("deleted.txt")'] });
    ctx.fs.readdir = vi.fn(async () => []);
    ctx.fs.stat = vi.fn(async () => { throw new Error('ENOENT'); });

    await pythonCmd.exec(ctx);

    // ctx.fs.unlink should have been called for the deleted file
    const unlinkCalls = (ctx.fs.unlink as any).mock.calls.map((c: any[]) => c[0] as string);
    expect(unlinkCalls.some((p: string) => p.includes('deleted.txt'))).toBe(true);
  });
});
