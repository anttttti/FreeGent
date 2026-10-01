// native-exec.ts — execute_code in headless runs: bash, python3 and node as real processes in the
// workspace directory (or `docker exec` in a task container). headless-runner.ts installs it as
// globalThis.nativeExec; tests/headless-tools.test.ts runs the tool tests on it.
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
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
                if (ent.name.startsWith('.git')) continue; // skip git internals (large + uninteresting)
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

export function createNativeExec({ workspaceRoot, targetContainer }: { workspaceRoot?: string | null; targetContainer?: string | null }) {
    return (language: string, code: string): Promise<any> => new Promise((resolve) => {
        // JavaScript runs as the body of an async function, as in the browser (exec-sandbox/js-run.ts):
        // top-level await and return work the same in both.
        const js = `(async () => {\n${code}\n})().catch(e => { console.error(e); process.exitCode = 1; });`;
        const _dc = (bin: string, flag: string, src = code) => ['docker', ['exec', '-i', targetContainer, bin, flag, src]] as const;
        const LANG_CMD: Record<string, readonly [string, readonly string[]]> = targetContainer
            ? { bash: _dc('bash', '-c'), python: _dc('python3', '-c'), javascript: _dc('node', '-e', js) }
            : { bash: ['bash', ['-c', code]], python: ['python3', ['-c', code]], javascript: ['node', ['-e', js]] };
        const entry = LANG_CMD[language];
        if (!entry) { resolve({ error: `nativeExec: unsupported language '${language}'` }); return; }
        const [cmd, cmdArgs] = entry;
        const MAX_OUTPUT = 200_000, TIMEOUT_MS = 120_000;
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
        const _done = (val) => { if (done) return; done = true; clearTimeout(timer); resolve(val); };
        // The runner's environment holds the provider keys (loaded from the credentials file);
        // agent commands get it without them. (docker exec doesn't forward it either way.)
        const child = execFile(cmd, cmdArgs, { cwd: workspaceRoot, maxBuffer: MAX_OUTPUT, detached: true,
            // No __pycache__ in the workspace: it shows in git status, and CPython takes a .pyc for
            // a module edited within the same second (same size) over the edit.
            env: { ...scrubEnv(process.env), PYTHONDONTWRITEBYTECODE: '1' } });
        child.unref();
        // No interactive input: close stdin so a program that reads it gets EOF at once instead of
        // blocking until the timeout (read, input(), vim prompts, menu-driven binaries).
        child.stdin?.end();
        child.stdout?.on('data', d => appendOut(out, String(d), MAX_OUTPUT));
        child.stderr?.on('data', d => appendOut(err, String(d), MAX_OUTPUT));
        child.on('close', (exitCode) => {
            const result: Record<string, any> = { ..._shaped(), exit_code: exitCode ?? 0 };
            // Detect files written/modified during execution via post-snapshot diff.
            // Populate files_written so llm-loops.ts can set _editsThisRun for the completion gate.
            if (preSnap && (exitCode ?? 0) === 0 && workspaceRoot) {
                const written: string[] = [];
                try {
                    const postSnap = _snapWorkspace(workspaceRoot);
                    for (const [p, mtime] of postSnap) {
                        if (!preSnap.has(p) || preSnap.get(p) !== mtime)
                            written.push(p.startsWith(workspaceRoot + '/') ? p.slice(workspaceRoot.length + 1) : p);
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
            try { process.kill(-child.pid, 'SIGKILL'); } catch {}
            _done({ ..._shaped(),
                    exit_code: 124, error: 'Command timed out after 120s. If it was waiting for input, pass input through a pipe or file (stdin is closed); run long jobs in the background.' });
        }, TIMEOUT_MS);
    });
}
