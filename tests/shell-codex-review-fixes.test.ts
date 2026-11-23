// Defects the Codex review found in the commits of 2026-11-18..20 (e49098b, 3da162b); each fails without its fix.
import { describe, it, expect, vi, beforeEach } from 'vitest';
const files = vi.hoisted(() => new Map<string, { content: string; encoding: string | null }>());
vi.mock('../workspace', () => ({
    agentWriteFile: async (n: string, c: string, e: string | null = null) => { files.set(n, { content: c, encoding: e }); },
    agentDeleteFile: async (n: string) => { files.delete(n); },
    agentListFiles: async () => [...files.keys()].map(name => ({ name })),
    readWorkspaceFile: async (n: string) => files.has(n) ? { name: n, ...files.get(n)! } : null,
}));
import { getShell, resetShell } from '../shiro/shell-singleton';

beforeEach(() => { files.clear(); resetShell(); });

describe('shell fixes from the Codex review', () => {
    it('mv -t and cp -t refuse a destination that is not a directory instead of overwriting it', async () => {
        const sh = await getShell();
        const r = await sh.exec("echo OLD > f; echo S > s.txt; mv -t f s.txt; cp -t f s.txt; cat f");
        expect(r.stdout.replace(/\r/g, '')).toBe('OLD\n');
        expect(r.stderr).toMatch(/mv: target 'f' is not a directory/);
        expect(r.stderr).toMatch(/cp: target 'f' is not a directory/);
        const ok = await sh.exec('mkdir d; mv -t d s.txt; ls d');
        expect(ok.stdout).toContain('s.txt');
    });
    it('an empty-array expansion inside single quotes stays text', async () => {
        const sh = await getShell();
        const r = await sh.exec("printf '%s\\n' 'prefix \"${arr[@]}\" suffix'");
        expect(r.stdout.replace(/\r/g, '')).toBe('prefix "${arr[@]}" suffix\n');
    });
    it('an assertion that fails in a process exit handler fails the run, with its message on stderr', async () => {
        const sh = await getShell();
        await sh.exec("cat > ex.js <<'E'\nprocess.on('exit', () => { require('assert').strictEqual(1, 2); });\nconsole.log('hello');\nE");
        const r = await sh.exec('node ex.js');
        expect(r.stdout).toContain('hello');
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toMatch(/strictly equal/);
    });
    it('an unterminated heredoc warns even when the caller gave no stderr callback (watch, EXIT traps)', async () => {
        const sh = await getShell();
        let out = '';
        await expect(sh.execute('cat <<EOF\nabc', (s: string) => { out += s; })).resolves.toBeDefined();
        expect(out).toMatch(/here-document .* delimited by end-of-file/);
    });
});
