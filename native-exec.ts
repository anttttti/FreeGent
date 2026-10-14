// native-exec.ts — execute_code in headless runs: bash, python3 and node as real processes in the
// workspace directory (or `docker exec` in a task container). headless-runner.ts installs it as
// globalThis.nativeExec; tests/headless-tools.test.ts runs the tool tests on it.
import { EXEC_TIMEOUT_MS, EXEC_TIMEOUT_MAX_MS } from './exec-limits.js';
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { scrubEnv } from './secret-env.js';
import { appendOut, clipOutput, stripCurlProgress, type OutBuf } from './exec-output.js';

// Snapshot workspace files (path → mtimeMs) for detecting writes during execute_code.
// Only used for local (non-Docker) execution where we can stat the filesystem directly.
function _snapWorkspace(dir: string): Map<string, number> {
    const snap = new Map<string, number>();
    const walk = (d: string, depth: number) => {
        if (depth > 8) return; // guard against deeply nested repos
        try {
            for (const ent of readdirSync(d, { withFileTypes: true })) {
                if (ent.name === '.git') continue; // skip git internals (large + uninteresting); .github, .gitignore are files of the project
                const full = join(d, ent.name);
                if (ent.isFile()) {
                    try { snap.set(full, statSync(full).mtimeMs); } catch {}
                } else if (ent.isDirectory()) walk(full, depth + 1);
            }
        } catch {}
    };
    if (dir) walk(dir, 0);
    return snap;
}

// What test runners and type checkers leave behind. Not the command's work: a pytest run that
// changed nothing else used to count as having written files.
export const TOOL_CACHE_PATH_RE = /(?:^|\/)(?:\.pytest_cache|__pycache__|\.mypy_cache|\.ruff_cache|\.hypothesis|\.tox|\.nox|\.cache|node_modules\/\.cache)\/|(?:^|\/)\.coverage(?:\.[\w.-]+)?$/;
export { EXEC_TIMEOUT_MS, EXEC_TIMEOUT_MAX_MS, execTimeoutMs } from './exec-limits.js';
// Exit code for a process ended by a signal, as a shell reports it (128 + signal number).
export function signalExitCode(signal: string | null | undefined): number {
    const n = signal ? (osConstants.signals as Record<string, number>)[signal] : undefined;
    return 128 + (n ?? 0) || 1;
}

export function createNativeExec({ workspaceRoot, targetContainer }: { workspaceRoot?: string | null; targetContainer?: string | null }) {
    const MAX_OUTPUT = 200_000;
    return (language: string, code: string, opts?: { timeoutMs?: number }): Promise<any> => new Promise((resolve) => {
        const TIMEOUT_MS = opts?.timeoutMs && opts.timeoutMs > 0 ? Math.min(EXEC_TIMEOUT_MAX_MS, opts.timeoutMs) : EXEC_TIMEOUT_MS;
        // JavaScript runs as the body of an async function, as in the browser (exec-sandbox/js-run.ts):
        // top-level await and return work the same in both.
        const js = `(async () => {\n${code}\n})().catch(e => { console.error(e); process.exitCode = 1; });`;
        // In a task container the local timeout only kills the `docker exec` client; the process inside
        // kept running. `timeout` inside the container ends it too (skipped where the image has none).
        const _dc = (bin: string, flag: string, src = code) => ['docker', ['exec', '-i', String(targetContainer), 'sh', '-c',
            `if command -v timeout >/dev/null 2>&1; then exec timeout -s KILL ${Math.ceil(TIMEOUT_MS / 1000) + 5} "$@"; else exec "$@"; fi`, 'sh', bin, flag, src]] as const;
        const LANG_CMD: Record<string, readonly [string, readonly string[]]> = targetContainer
            ? { bash: _dc('bash', '-c'), python: _dc('python3', '-c'), javascript: _dc('node', '-e', js) }
            : { bash: ['bash', ['-c', code]], python: ['python3', ['-c', code]], javascript: ['node', ['-e', js]] };
        const entry = LANG_CMD[language];
        if (!entry) { resolve({ error: `nativeExec: unsupported language '${language}'` }); return; }
        const [cmd, cmdArgs] = entry;
        // Snapshot workspace before execution (local only — Docker workspace is on the container).
        const preSnap = (!targetContainer && workspaceRoot) ? _snapWorkspace(workspaceRoot) : null;
        // Snapshot .git/hooks to detect hook-injection attempts (non-.sample files planted by the agent).
        const hooksDir = (!targetContainer && workspaceRoot) ? join(workspaceRoot, '.git', 'hooks') : null;
        const preHooks: Set<string> | null = hooksDir ? (() => {
            try { return new Set(readdirSync(hooksDir).filter(f => !f.endsWith('.sample'))); }
            catch { return null; }
        })() : null;
        const out: OutBuf = { text: '', dropped: 0 }, err: OutBuf = { text: '', dropped: 0 };
        let done = false;
        // Head + tail of each stream (exec-output.ts); curl's progress meter is dropped from stderr.
        const _shaped = () => ({ stdout: clipOutput(out.text, out.dropped), stderr: clipOutput(stripCurlProgress(err.text), err.dropped) });
        const _done = (val: any) => { if (done) return; done = true; clearTimeout(timer); resolve(val); };
        // The runner's environment holds the provider keys (loaded from the credentials file);
        // agent commands get it without them. (docker exec doesn't forward it either way.)
        // spawn, not execFile: execFile kills the child once stdout passes its maxBuffer, and the
        // kill read as exit code 0 — a command that printed more than 200 KB stopped there and was
        // reported as a success (v0.70: 85 results in 26 tasks). The buffers below are bounded already.
        const child = spawn(cmd, cmdArgs as string[], { cwd: workspaceRoot ?? undefined, detached: true,
            // No __pycache__ in the workspace: it shows in git status, and CPython takes a .pyc for
            // a module edited within the same second (same size) over the edit.
            env: { ...scrubEnv(process.env), PYTHONDONTWRITEBYTECODE: '1' } });
        child.unref();
        // No interactive input: close stdin so a program that reads it gets EOF at once instead of
        // blocking until the timeout (read, input(), vim prompts, menu-driven binaries).
        child.stdin?.end();
        child.stdout?.on('data', d => appendOut(out, String(d), MAX_OUTPUT));
        child.stderr?.on('data', d => appendOut(err, String(d), MAX_OUTPUT));
        child.on('close', (exitCode, signal) => {
            // Ended by a signal (OOM killer, kill, a crash): never a success.
            const result: Record<string, any> = { ..._shaped(), exit_code: exitCode ?? signalExitCode(signal),
                ...(exitCode == null && signal ? { signal } : {}) };
            // Detect files written/modified during execution via post-snapshot diff.
            // Populate files_written so llm-loops.ts can set _editsThisRun for the completion gate.
            // Whatever the exit code: a failing command can have changed files too.
            if (preSnap && workspaceRoot) {
                const written: string[] = [];
                try {
                    const postSnap = _snapWorkspace(workspaceRoot);
                    for (const [p, mtime] of postSnap) {
                        if (!preSnap.has(p) || preSnap.get(p) !== mtime) {
                            const rel = p.startsWith(workspaceRoot + '/') ? p.slice(workspaceRoot.length + 1) : p;
                            if (!TOOL_CACHE_PATH_RE.test(rel)) written.push(rel);
                        }
                    }
                } catch {}
                if (written.length > 0) result.files_written = written;
            }
            // Detect .git/hooks planted by the executed code (hook-injection guard).
            if (hooksDir && preHooks !== null) {
                try {
                    const postHooks = readdirSync(hooksDir).filter(f => !f.endsWith('.sample'));
                    const planted = postHooks.filter(h => !preHooks.has(h));
                    if (planted.length > 0) {
                        for (const h of planted) { try { unlinkSync(join(hooksDir, h)); } catch {} }
                        result.warning = `execute_code planted .git/hooks — removed: ${planted.join(', ')}. Check for other .git/ writes.`;
                    }
                } catch {}
            }
            _done(result);
        });
        child.on('error', (e) => _done({ error: `${cmd}: ${e.message}`, ..._shaped(), exit_code: 1 }));
        const timer = setTimeout(() => {
            try { process.kill(-(child.pid ?? 0), 'SIGKILL'); } catch {}
            _done({ ..._shaped(),
                    exit_code: 124, error: `Command timed out after ${Math.round(TIMEOUT_MS / 1000)}s. If it was waiting for input, pass input through a pipe or file (stdin is closed). ${TIMEOUT_MS < EXEC_TIMEOUT_MAX_MS ? `A step that really needs longer can pass timeout_s (up to ${EXEC_TIMEOUT_MAX_MS / 1000}); ` : ''}for anything longer, run the job in the background and poll its output file.` });
        }, TIMEOUT_MS);
    });
}
