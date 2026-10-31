// Persistent execute_code sessions (experiment persistent_exec): real bash and python3 processes in a temporary workspace.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecSessions } from '../exec-session.ts';

let dir: string;
let s: ReturnType<typeof createExecSessions>;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fg-sess-'));
    s = createExecSessions({ workspaceRoot: dir, env: process.env, maxOutput: 200_000 });
});
afterEach(() => { s.closeAll(); rmSync(dir, { recursive: true, force: true }); });
const run = (lang: 'bash' | 'python', code: string, opts: any = {}) => s.run('chat:1', lang, code, { timeoutMs: 10_000, ...opts });

describe('exec sessions', () => {
    it('bash keeps variables, functions and cd; exit ends the session and the next call says so', async () => {
        expect((await run('bash', 'X=41; f() { echo $((X+1)); }; mkdir -p sub; cd sub')).exit_code).toBe(0);
        const r = await run('bash', 'f; basename "$PWD"; printf no-newline');
        expect(r.stdout).toBe('42\nsub\nno-newline');
        expect((await run('bash', 'exit 3')).ended).toBe('exited');
        const after = await run('bash', 'echo "${X:-unset}"');
        expect(after.restarted).toBe(true);
        expect(after.stdout).toBe('unset\n');
    });

    it('python keeps its names, and re-imports an edited workspace module (functions taken from it too)', async () => {
        writeFileSync(join(dir, 'mod.py'), 'def f():\n    return 1\nclass C:\n    pass\n');
        await run('python', 'import mod\nfrom mod import f\nc = mod.C()\nn = 5');
        writeFileSync(join(dir, 'mod.py'), 'def f():\n    return 22\nclass C:\n    pass\n');
        const r = await run('python', 'print(mod.f(), f(), n)');
        expect(r.stdout).toBe('22 22 5\n');
        expect(r.stderr).toMatch(/workspace modules changed \(mod\): re-imported\. Still made by the old code: c/);
    });

    it('python code cannot read the control stream; an exception is a failed call that keeps the session', async () => {
        const r = await run('python', 'import sys\nprint(repr(sys.stdin.read()))\nx = 1\nraise ValueError("boom")');
        expect(r.stdout).toBe("''\n");
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toMatch(/ValueError: boom/);
        expect(r.stderr).not.toMatch(/exec-session|_ns/);
        expect((await run('python', 'print(x)')).stdout).toBe('1\n');
    });

    it('a timeout ends the session; reset starts a fresh one without saying it was lost', async () => {
        await run('bash', 'Y=1');
        expect((await run('bash', 'sleep 5', { timeoutMs: 300 })).ended).toBe('timeout');
        expect((await run('bash', 'echo "${Y:-gone}"')).stdout).toBe('gone\n');
        await run('bash', 'Z=2');
        const fresh = await run('bash', 'echo "${Z:-gone}"', { reset: true });
        expect([fresh.stdout, fresh.restarted]).toEqual(['gone\n', false]);
    });

    it('sessions are separate per key', async () => {
        await s.run('chat:1', 'bash', 'K=a', { timeoutMs: 5000 });
        expect((await s.run('worker:1', 'bash', 'echo "${K:-none}"', { timeoutMs: 5000 })).stdout).toBe('none\n');
    });
});
