/**
 * Tests for shiro/commands/python.ts — the Pyodide-backed python/python3 shell commands, run on a
 * real Pyodide (the npm build of the version the browser loads from the CDN). pip runs on a mock
 * (micropip would download packages). The fuller comparison with CPython is the python3 section
 * of scripts/shell-diff.sh.
 */

import {
  pythonCmd,
  python3Cmd,
  pipCmd,
  pip3Cmd,
  pytestCmd,
  _preamble,
  _extractExitCode,
  __setPyodideForTest,
} from '../shiro/commands/python';
import { loadNodePyodide } from './parity-utils';

// ── helpers ───────────────────────────────────────────────────────────────────

/** A CommandContext over an in-memory /workspace (path → bytes). */
function makeCtx(args: string[], files: Record<string, string | Uint8Array> = {}, stdin = ''): any {
  const ws = new Map<string, Uint8Array>(Object.entries(files).map(([p, c]) =>
    [p, typeof c === 'string' ? new TextEncoder().encode(c) : c]));
  const isDir = (p: string) => p === '/workspace' || [...ws.keys()].some(k => k.startsWith(p + '/'));
  const ctx = {
    args, cwd: '/workspace', env: {}, stdin, stdout: '', stderr: '', shell: {} as any, terminal: undefined,
    ws,
    fs: {
      resolvePath: (p: string, cwd: string) => p.startsWith('/') ? p : cwd + '/' + p,
      readFile: async (p: string, enc?: string) => {
        if (!ws.has(p)) throw new Error(`ENOENT: ${p}`);
        return enc === 'utf8' ? new TextDecoder().decode(ws.get(p)) : ws.get(p);
      },
      writeFile: async (p: string, data: Uint8Array | string) => { ws.set(p, typeof data === 'string' ? new TextEncoder().encode(data) : data); },
      unlink: async (p: string) => { ws.delete(p); },
      exists: async (p: string) => ws.has(p) || isDir(p),
      mkdir: async () => {},
      readdir: async (dir: string) => [...new Set([...ws.keys()].filter(k => k.startsWith(dir + '/')).map(k => k.slice(dir.length + 1).split('/')[0]))],
      lstat: async (p:string) => ctx.fs.stat(p),
      stat: async (p: string) => {
        if (ws.has(p)) return { isDirectory: () => false, isSymbolicLink:() => false, size:ws.get(p)!.length };
        if (p === '/workspace' || isDir(p)) return { isDirectory: () => true, isSymbolicLink:() => false, size:0 };
        throw new Error(`ENOENT: ${p}`);
      },
    },
  };
  return ctx;
}

async function run(args: string[], files: Record<string, string | Uint8Array> = {}, stdin = '') {
  const ctx = makeCtx(args, files, stdin);
  const code = await pythonCmd.exec(ctx);
  return { code, stdout: ctx.stdout as string, stderr: ctx.stderr as string, ws: ctx.ws as Map<string, Uint8Array> };
}

let realPy: any;
beforeAll(async () => { realPy = await loadNodePyodide(); }, 60_000);
beforeEach(() => { __setPyodideForTest(realPy); });

// ── _preamble / _extractExitCode (pure) ──────────────────────────────────────

describe('_preamble', () => {
  it('chdirs to the shiro-mapped cwd, creating it', () => {
    const code = _preamble('/workspace');
    expect(code).toContain('os.makedirs("/workspace", exist_ok=True)');
    expect(code).toContain('os.chdir("/workspace")');
  });

  it('runs in the workspace at /workspace, other shell paths under /shiro', () => {
    expect(_preamble('/tmp')).toContain('os.chdir("/shiro/tmp")');
  });

  it('starts sys.path with "" (then the standard library), as CPython does', () => {
    expect(_preamble('/workspace/src')).toContain(`sys.path[:] = [''] + [_p for _p in _fg_base[1] if _p not in ('', '/workspace')]`);
  });
});

describe('_extractExitCode', () => {
  const ctx = () => ({ stderr: '' } as any);
  it('returns 0 for SystemExit with no code', () => expect(_extractExitCode({ type: 'SystemExit', message: 'SystemExit' }, ctx())).toBe(0));
  it('returns the code from SystemExit: N, modulo 256 like a process status', () => {
    expect(_extractExitCode({ type: 'SystemExit', message: 'SystemExit: 3' }, ctx())).toBe(3);
    expect(_extractExitCode({ message: 'SystemExit: -1' }, ctx())).toBe(255);
  });
  it('returns 1 and writes to stderr for other errors', () => {
    const c = ctx();
    expect(_extractExitCode({ message: 'boom' }, c)).toBe(1);
    expect(c.stderr).toBe('boom\n');
  });
});

// ── python -c / script / -m / stdin, on a real Pyodide ────────────────────────

describe('pythonCmd output and exit status', () => {
  it('keeps stdout exactly: no added or trimmed newlines, UTF-8, CRLF', async () => {
    expect((await run(['-c', 'import sys; sys.stdout.write("no newline")'])).stdout).toBe('no newline');
    expect((await run(['-c', 'print("a\\n\\n"); print("x  ")'])).stdout).toBe('a\n\n\nx  \n');
    expect((await run(['-c', 'print("café 😀\\r\\nz")'])).stdout).toBe('café 😀\r\nz\n');
  });

  it('supports sys.stdout.buffer and keeps stderr apart', async () => {
    const r = await run(['-c', 'import sys; sys.stdout.buffer.write(b"\\xc3\\xa9\\n"); print("e", file=sys.stderr)']);
    expect(r.stdout).toBe('é\n');
    expect(r.stderr).toBe('e\n');
  });

  it('returns SystemExit codes as CPython does', async () => {
    expect((await run(['-c', 'import sys; sys.exit(3)'])).code).toBe(3);
    expect((await run(['-c', 'import sys; sys.exit()'])).code).toBe(0);
    expect((await run(['-c', 'import sys; sys.exit(256)'])).code).toBe(0);
    const s = await run(['-c', 'raise SystemExit("bye")']);
    expect([s.code, s.stderr]).toEqual([1, 'bye\n']);
  });

  it('keeps output printed before an exception and returns 1 with a traceback', async () => {
    const r = await run(['-c', 'print("before")\n1/0']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('before\n');
    expect(r.stderr).toMatch(/^Traceback \(most recent call last\):\n  File "<string>", line 2, in <module>\nZeroDivisionError/);
  });

  it('gives each run fresh globals and working streams, even after a program closes stdout', async () => {
    await run(['-c', 'x = 1; import sys; sys.stdout.close()']);
    expect((await run(['-c', 'print("x" in globals())'])).stdout).toBe('False\n');
  });
});

describe('pythonCmd sys.path', () => {
  it('sys.path[0]: "" for -c, the script\'s folder for a script, the cwd for -m', async () => {
    expect((await run(['-c', 'import sys; print(repr(sys.path[0]))'])).stdout).toBe("''\n");
    expect((await run(['src/p.py'], { '/workspace/src/p.py': 'import sys; print(sys.path[0])\n' })).stdout).toBe('/workspace/src\n');
    expect((await run(['-m', 'm'], { '/workspace/m.py': 'import sys; print(sys.path[0])\n' })).stdout).toBe('/workspace\n');
  });
});

describe('pythonCmd arguments and input', () => {
  it('sets sys.argv as CPython: -c, then the arguments', async () => {
    expect((await run(['-c', 'import sys; print(sys.argv)', 'a', 'b c', '-m'])).stdout).toBe("['-c', 'a', 'b c', '-m']\n");
  });

  it('runs a script with sys.argv[0] the script and options after it left to the script', async () => {
    const r = await run(['-u', 's.py', 'one', '-c', 'x'], { '/workspace/s.py': 'import sys\nprint(sys.argv, __name__)\n' });
    expect(r.stdout).toBe("['s.py', 'one', '-c', 'x'] __main__\n");
  });

  it('reports a missing script with exit 2', async () => {
    const r = await run(['nope.py']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("can't open file 'nope.py'");
  });

  it('runs a module with -m', async () => {
    const r = await run(['-m', 'json.tool', 'd.json'], { '/workspace/d.json': '{"a": [1]}' });
    expect([r.code, r.stdout]).toEqual([0, '{\n    "a": [\n        1\n    ]\n}\n']);
  });

  it('gives piped input to sys.stdin, bytes exact', async () => {
    expect((await run(['-c', 'import sys; print(repr(sys.stdin.read()))'], {}, 'a\r\nb\n')).stdout).toBe("'a\\r\\nb\\n'\n");
  });

  it('runs a program piped in when none is given (echo … | python3, python3 -)', async () => {
    expect((await run([], {}, 'print(6 * 7)\n')).stdout).toBe('42\n');
    expect((await run(['-'], {}, 'import sys; print(sys.argv)\n')).stdout).toBe("['-']\n");
  });
});

describe('pythonCmd workspace files', () => {
  it('reads workspace files byte for byte', async () => {
    const r = await run(['-c', 'print(open("a.txt", "rb").read(), open("b.bin", "rb").read())'],
      { '/workspace/a.txt': 'x\r\ny', '/workspace/b.bin': new Uint8Array([0, 255, 1]) });
    expect(r.stdout).toBe("b'x\\r\\ny' b'\\x00\\xff\\x01'\n");
  });

  it('writes back new and changed files exactly, and leaves untouched ones alone', async () => {
    const r = await run(['-c', 'open("o.bin", "wb").write(bytes(range(256))); open("a.txt", "a").write("+")'],
      { '/workspace/a.txt': 'A', '/workspace/keep.txt': 'K' });
    expect([...r.ws.get('/workspace/o.bin')!]).toEqual([...Array(256).keys()]);
    expect(new TextDecoder().decode(r.ws.get('/workspace/a.txt'))).toBe('A+');
    expect(new TextDecoder().decode(r.ws.get('/workspace/keep.txt'))).toBe('K');
  });

  it('deletes files Python removed', async () => {
    const r = await run(['-c', 'import os; os.remove("gone.txt")'], { '/workspace/gone.txt': 'x', '/workspace/stay.txt': 'y' });
    expect([...r.ws.keys()]).toEqual(['/workspace/stay.txt']);
  });

  it('python3 is the same command', async () => {
    expect(python3Cmd.name).toBe('python3');
    const ctx = makeCtx(['-c', 'print(1)']);
    expect(await python3Cmd.exec(ctx)).toBe(0);
    expect(ctx.stdout).toBe('1\n');
  });
});

describe('pytestCmd (real Pyodide integration)', () => {
  it('loads pytest on demand, runs workspace tests, and returns pytest exit status', async () => {
    const mockedFetch = globalThis.fetch;
    globalThis.fetch = (globalThis as any).__nativeFetchForTests;
    try {
      const passing = makeCtx(['-q', 'test_example.py'], {
        '/workspace/test_example.py': 'def test_arithmetic():\n    assert 6 * 7 == 42\n',
      });
      const progress:string[] = [];
      passing.shell.onProgress = (message:string) => progress.push(message);
      expect(await pytestCmd.exec(passing)).toBe(0);
      expect(passing.stdout).toMatch(/1 passed/);
      expect(passing.stderr).toBe('');
      expect(progress.some(message => message.includes('Loading pytest'))).toBe(true);

      const failing = makeCtx(['-q', 'test_failure.py'], {
        '/workspace/test_failure.py': 'def test_failure():\n    assert False\n',
      });
      expect(await pytestCmd.exec(failing)).toBe(1);
      expect(failing.stdout).toMatch(/1 failed/);
    } finally {
      globalThis.fetch = mockedFetch;
    }
  }, 60_000);
});

// ── pip (mock micropip) ───────────────────────────────────────────────────────

describe('pipCmd.exec', () => {
  const mockPy = (install: (p: string) => Promise<void>) => ({
    loadPackage: vi.fn(async () => {}),
    pyimport: vi.fn(() => ({ install: vi.fn(install) })),
  });

  it('returns exit code 1 and usage message when no package given', async () => {
    __setPyodideForTest(mockPy(async () => {}));
    const ctx = makeCtx(['install']);
    expect(await pipCmd.exec(ctx)).toBe(1);
    expect(ctx.stderr).toContain('usage: pip install');
  });

  it('calls micropip.install for each package', async () => {
    const py = mockPy(async () => {});
    __setPyodideForTest(py);
    const ctx = makeCtx(['install', 'numpy', 'pandas']);
    expect(await pipCmd.exec(ctx)).toBe(0);
    const install = py.pyimport.mock.results[0].value.install;
    expect(install).toHaveBeenCalledWith('numpy');
    expect(install).toHaveBeenCalledWith('pandas');
    expect(ctx.stdout).toContain('Successfully installed pandas');
  });

  it('returns 1 if micropip.install throws', async () => {
    __setPyodideForTest(mockPy(async () => { throw new Error('Package not found: xxx'); }));
    const ctx = makeCtx(['install', 'xxx']);
    expect(await pipCmd.exec(ctx)).toBe(1);
    expect(ctx.stderr).toContain('Package not found');
  });

  it('pip3Cmd has name "pip3" and same behaviour', async () => {
    expect(pip3Cmd.name).toBe('pip3');
    __setPyodideForTest(mockPy(async () => {}));
    expect(await pip3Cmd.exec(makeCtx(['install', 'requests']))).toBe(0);
  });
});
