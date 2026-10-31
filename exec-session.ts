// exec-session.ts — persistent execute_code sessions for headless runs (experiment persistent_exec, FG_EXPERIMENTS).
//
// One bash process and one Python process per session key (the chat, or a worker), kept between calls: variables,
// functions, imports, cd and exports carry over. Each call is sent on the process's stdin and ends with a marker the
// process prints on stdout and on stderr; what came before the markers is the call's output. The code itself never reads
// that stdin (bash: `eval … < /dev/null`; Python: fd 0 is /dev/null and the driver reads a duplicate).
//
// Workspace changes: bash reads the filesystem, so it is always current. Python caches imported modules, so before each
// call the driver compares the files of the workspace modules it has imported with their state after the last call; if
// any changed, every workspace module is dropped from sys.modules (a consistent fresh copy, not one reloaded module next
// to stale importers of it), and the session's names bound to those modules or to functions and classes from them are
// re-imported. Variables holding objects made by the old code cannot be updated: the call's output names them.
//
// A session that ends (exit in bash, set -e, a crash) or is killed (timeout, Stop) is started afresh on the next call,
// and that call's result says the earlier state is gone.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendOut, type OutBuf } from './exec-output.js';

const PY_DRIVER = String.raw`
import sys, os, base64, traceback, importlib, types
_ctl = os.fdopen(os.dup(0), 'rb', buffering=0)
_dn = os.open(os.devnull, os.O_RDONLY); os.dup2(_dn, 0); sys.stdin = open(os.devnull)
sys.argv = ['-c']
if sys.path[:1] != ['']: sys.path.insert(0, '')
_ROOT = os.path.realpath(os.getcwd()) + os.sep
_ns = {'__name__': '__main__', '__builtins__': __builtins__}
_seen = {}
def _ws(m):
    f = getattr(m, '__file__', None)
    if not f: return None
    try: f = os.path.realpath(f)
    except Exception: return None
    return f if f.startswith(_ROOT) else None
def _stamp(f):
    try: st = os.stat(f); return (st.st_mtime_ns, st.st_size)
    except OSError: return None
def _record():
    for name, m in list(sys.modules.items()):
        f = _ws(m) if m is not None else None
        if f and name not in _seen: _seen[name] = (f, _stamp(f))
def _refresh():
    importlib.invalidate_caches()
    changed = [n for n, (f, st) in _seen.items() if _stamp(f) != st]
    if not changed: return
    dropped = set(n for n in list(sys.modules) if sys.modules.get(n) is not None and _ws(sys.modules[n]))
    for n in dropped: sys.modules.pop(n, None)
    _seen.clear()
    stale = []
    for k, v in list(_ns.items()):
        if k.startswith('__'): continue
        try:
            if isinstance(v, types.ModuleType) and v.__name__ in dropped:
                _ns[k] = importlib.import_module(v.__name__)
            elif isinstance(v, (type, types.FunctionType)) and getattr(v, '__module__', None) in dropped:
                _ns[k] = getattr(importlib.import_module(v.__module__), v.__name__)
            elif type(v).__module__ in dropped:
                stale.append(k)
        except Exception as e:
            sys.stderr.write('[session] could not re-import %s for %s: %s\n' % (getattr(v, '__name__', '?'), k, e))
    names = ', '.join(sorted(n for n in changed if n in dropped)[:8])
    sys.stderr.write('[session] workspace modules changed (%s): re-imported.%s\n' % (names, (' Still made by the old code: ' + ', '.join(sorted(stale)[:10]) + ' — recreate them.') if stale else ''))
while True:
    line = _ctl.readline()
    if not line: break
    nonce, _, b64 = line.decode().strip().partition(' ')
    code = base64.b64decode(b64).decode('utf-8', 'surrogateescape')
    rc = 0
    try:
        _refresh()
        exec(compile(code, '<string>', 'exec'), _ns)
    except SystemExit as e:
        c = e.code
        rc = c if isinstance(c, int) else (0 if c is None else 1)
        if not isinstance(c, (int, type(None))): sys.stderr.write(str(c) + '\n')
    except BaseException as e:
        tb = e.__traceback__.tb_next if e.__traceback__ is not None and not isinstance(e, SyntaxError) else None
        traceback.print_exception(type(e), e, tb)
        rc = 1
    try: _record()
    except Exception: pass
    try: sys.stdout.flush()
    except Exception: pass
    try: sys.stderr.flush()
    except Exception: pass
    os.write(1, ('__FG_END_%s_%d__' % (nonce, rc)).encode())
    os.write(2, ('__FG_END_%s__' % nonce).encode())
`;

type Lang = 'bash' | 'python';
interface Session { child: ChildProcess; pid?: number; out: OutBuf; err: OutBuf; busy: Promise<unknown>; dead: boolean; killed: boolean; exitCode: number | null; onEnd?: () => void }

/** ended: the session is gone after this call. restarted: this call ran in a new session because the earlier one ended. */
export interface SessionRun { stdout: string; stderr: string; dropped: [number, number]; exit_code: number; ended?: 'exited' | 'killed' | 'timeout'; restarted: boolean }

export function createExecSessions({ workspaceRoot, targetContainer, env, maxOutput }: { workspaceRoot?: string | null; targetContainer?: string | null; env: NodeJS.ProcessEnv; maxOutput: number }) {
    const sessions = new Map<string, Session>();
    const lost = new Set<string>();   // sessions that ended: the next call says it starts afresh
    const MAX_SESSIONS = 16;
    const argv = (lang: Lang): [string, string[]] => {
        const inner: [string, string[]] = lang === 'bash' ? ['bash', ['--noprofile', '--norc']] : ['python3', ['-u', '-c', PY_DRIVER]];
        // In a container the process announces its PID there: killing the local docker exec client does not end it.
        return targetContainer ? ['docker', ['exec', '-i', String(targetContainer), 'sh', '-c', 'echo "__FG_PID_$$__" >&2; exec "$@"', 'sh', inner[0], ...inner[1]]] : inner;
    };
    const start = (key: string, lang: Lang): Session => {
        const [cmd, args] = argv(lang);
        const child = spawn(cmd, args, { cwd: workspaceRoot ?? undefined, detached: true, env: { ...env, PYTHONDONTWRITEBYTECODE: '1' } });
        child.unref();
        const s: Session = { child, out: { text: '', dropped: 0 }, err: { text: '', dropped: 0 }, busy: Promise.resolve(), dead: false, killed: false, exitCode: null };
        child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', d => { appendOut(s.out, String(d), maxOutput + 256); s.onEnd?.(); });
        child.stderr?.on('data', d => {
            let t = String(d);
            if (targetContainer && s.pid == null) { const m = /__FG_PID_(\d+)__\n?/.exec(t); if (m) { s.pid = Number(m[1]); t = t.replace(m[0], ''); } }
            appendOut(s.err, t, maxOutput + 256); s.onEnd?.();
        });
        child.on('close', (code, signal) => { s.dead = true; s.exitCode = code ?? (signal ? 137 : 1); s.onEnd?.(); });
        child.on('error', () => { s.dead = true; s.exitCode = 1; s.onEnd?.(); });
        child.stdin?.on('error', () => {});
        if (sessions.size >= MAX_SESSIONS) {   // the oldest session goes
            const [oldKey, old] = sessions.entries().next().value as [string, Session];
            kill(old); sessions.delete(oldKey);
        }
        sessions.set(key, s);
        return s;
    };
    const kill = (s: Session) => {
        // In the container the session is no process-group leader and images often lack pkill: its descendants are found
        // through /proc (children before their parent, so none is reparented first).
        if (targetContainer && s.pid) { try { spawn('docker', ['exec', String(targetContainer), 'sh', '-c', `k() { for c in $(grep -l "^PPid:[[:space:]]*$1\$" /proc/[0-9]*/status 2>/dev/null | cut -d/ -f3); do k "$c"; done; kill -9 "$1" 2>/dev/null; }; k ${s.pid}`], { stdio: 'ignore' }).on('error', () => {}); } catch {} }
        s.killed = true; try { process.kill(-(s.child.pid ?? 0), 'SIGKILL'); } catch {} try { s.child.kill('SIGKILL'); } catch {} s.dead = true; };
    const payload = (lang: Lang, nonce: string, code: string): string => {
        const b64 = Buffer.from(code, 'utf8').toString('base64');
        if (lang === 'python') return `${nonce} ${b64}\n`;
        const wrapped = b64.replace(/.{1,76}/g, '$&\n');
        return `__fg_code=$(base64 -d <<'__FG_B64_${nonce}__'\n${wrapped}__FG_B64_${nonce}__\n)\neval "$__fg_code" < /dev/null\n__fg_rc=$?\nprintf '%s' "__FG_END_${nonce}_\${__fg_rc}__"\nprintf '%s' "__FG_END_${nonce}__" >&2\n`;
    };

    /** Run code in the session `key` for its language. `register` receives the kill function while the call runs. */
    function run(key: string, lang: Lang, code: string, { timeoutMs, reset, register }: { timeoutMs: number; reset?: boolean; register?: (kill: () => void) => () => void }): Promise<SessionRun> {
        const id = `${key}\u0000${lang}`;
        let s = sessions.get(id);
        if (s && reset) { kill(s); sessions.delete(id); s = undefined; }
        if (s?.dead) lost.add(id);
        const restarted = !reset && (!s || s.dead) && lost.delete(id);
        if (!s || s.dead) { if (s) sessions.delete(id); s = start(id, lang); }
        const sess = s;
        const task = sess.busy.then(() => new Promise<SessionRun>((resolve) => {
            const nonce = randomBytes(8).toString('hex');
            const endOut = new RegExp(`__FG_END_${nonce}_(-?\\d+)__`), endErr = `__FG_END_${nonce}__`;
            sess.out = { text: '', dropped: 0 }; sess.err = { text: '', dropped: 0 };
            let settled = false;
            const unregister = register?.(() => { kill(sess); }) ?? (() => {});
            const finish = (r: SessionRun) => { if (settled) return; settled = true; clearTimeout(timer); sess.onEnd = undefined; unregister(); resolve(r); };
            const dropped = (): [number, number] => [sess.out.dropped, sess.err.dropped];
            sess.onEnd = () => {
                const m = endOut.exec(sess.out.text);
                const e = sess.err.text.indexOf(endErr);
                if (m && e !== -1) {
                    finish({ stdout: sess.out.text.slice(0, m.index), stderr: sess.err.text.slice(0, e), dropped: dropped(), exit_code: Number(m[1]), restarted });
                } else if (sess.dead) {
                    sessions.delete(id); lost.add(id);
                    finish({ stdout: sess.out.text.replace(endOut, ''), stderr: sess.err.text.split(endErr)[0], dropped: dropped(), exit_code: sess.exitCode ?? 1, ended: sess.killed ? 'killed' : 'exited', restarted });
                }
            };
            const timer = setTimeout(() => {
                kill(sess); sessions.delete(id); lost.add(id);
                finish({ stdout: sess.out.text, stderr: sess.err.text, dropped: dropped(), exit_code: 124, ended: 'timeout', restarted });
            }, timeoutMs);
            if (sess.dead) { sess.onEnd(); return; }
            sess.child.stdin?.write(payload(lang, nonce, code));
        }));
        sess.busy = task.catch(() => {});
        return task;
    }
    function closeAll(): void { for (const s of sessions.values()) kill(s); sessions.clear(); }
    return { run, closeAll };
}
