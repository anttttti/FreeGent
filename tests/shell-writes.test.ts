// One reader of "what does this bash command write to", shared by verification and the overwrite guard.
import { describe, it, expect } from 'vitest';
import { shellWrites } from '../shell-writes.js';
import { shellWritePaths } from '../detectors.js';
import { newVerification, noteStep, verdict } from '../verification.js';

const paths = (c: string) => shellWrites(c).paths;
const state = (code: string, extra: any = {}, result: any = { exit_code: 0, stdout: '' }) =>
    verdict(noteStep(newVerification(), { toolCalls: [{ name: 'execute_code', args: { code, ...extra }, result }] }));

describe('shellWrites', () => {
    it('finds redirects, appends, tee and in-place edits', () => {
        expect(paths('echo hi > out.txt')).toEqual(['out.txt']);
        expect(paths('echo hi >> ./log.txt')).toEqual(['log.txt']);
        expect(paths('echo hi >out.txt 2>err.txt')).toEqual(['out.txt', 'err.txt']);
        expect(paths('make | tee build.log')).toEqual(['build.log']);
        expect(paths("sed -i 's/a/b/' src/x.py")).toEqual(['src/x.py']);
        expect(paths("sed -i.bak -e 's/a/b/' a.txt b.txt")).toEqual(['a.txt', 'b.txt']);
        expect(paths("perl -pi -e 's/a/b/' lib/m.pm")).toEqual(['lib/m.pm']);
        expect(paths('cat > f.txt <<EOF\nhello > not a file\nEOF')).toEqual(['f.txt']);
    });
    it('does not read operators from quotes, heredoc bodies, fd duplication or comments', () => {
        expect(paths('ls -la 2>&1')).toEqual([]);
        expect(paths('cmd >/dev/null 2>&1')).toEqual([]);
        expect(paths('python3 -c "print(1 if 2 >= 1 else 0)"')).toEqual([]);
        expect(paths("echo 'a -> b'")).toEqual([]);
        expect(paths('grep -c "a->b" f')).toEqual([]);
        expect(paths('python3 - <<\'PY\'\nif a > b: pass\nPY')).toEqual([]);
        expect(paths('ls # > nothing')).toEqual([]);
        expect(paths('diff <(sort a) <(sort b)')).toEqual([]);
    });
    it('flags patch and git apply regardless of where the patch file lives', () => {
        expect(shellWrites('git apply /tmp/fix.patch').patched).toBe(true);
        expect(shellWrites('cd repo && patch -p1 < /tmp/fix.diff').patched).toBe(true);
        expect(shellWrites('git apply --check /tmp/fix.patch').patched).toBe(false);
        expect(shellWrites('patch --dry-run -p1 < x.diff').patched).toBe(false);
        expect(shellWrites('git diff HEAD --stat').patched).toBe(false);
    });
    it('detectors.shellWritePaths is the same reader', () => {
        expect(shellWritePaths('echo a > b.txt')).toEqual(['b.txt']);
        expect(shellWritePaths('x="size -> out.txt"')).toEqual([]);
    });
});

describe('verification of shell commands', () => {
    it('read-only commands are no_change', () => {
        for (const c of ['ls -la 2>&1', 'python3 -c "print(1 if 2 >= 1 else 0)"', 'grep -n foo a.py', 'cat a.py | head', 'echo done 2>/dev/null'])
            expect(state(c)).toBe('no_change');
    });
    it('real edits are unverified until a check passes', () => {
        expect(state("sed -i 's/a/b/' x.py")).toBe('unverified');
        expect(state('git apply /tmp/fix.patch')).toBe('unverified');
        expect(state('echo x > notes/tmp_scratch.txt')).toBe('no_change');
    });
    it('only bash is read as shell', () => {
        expect(state('x = 1 > 0\nprint(x)', { language: 'python' })).toBe('no_change');
        expect(state('open("src/a.py","w").write("x")', { language: 'python' })).toBe('unverified');
    });
    it('"0 failed" and "Found 0 errors." are passes', () => {
        const run = (out: string) => verdict(noteStep(newVerification(), { toolCalls: [
            { name: 'write_file', args: { path: 'a.py' }, result: { success: true } },
            { name: 'execute_code', args: { code: 'tsc --noEmit' }, result: { exit_code: 0, stdout: out } }] }));
        expect(run('Found 0 errors.')).toBe('verified');
        expect(run('10 passed, 0 failed')).toBe('verified');
        expect(run('2 failed, 8 passed')).toBe('failed_verification');
        expect(run('Found 3 errors.')).toBe('failed_verification');
    });
});
