import { describe, it, expect } from 'vitest';
import { newVerification, noteStep, verdict } from '../verification.ts';

const run = (steps: any[][]) => { const st = newVerification(); for (const calls of steps) noteStep(st, { toolCalls: calls }); return verdict(st); };
const edit = { name: 'replace_in_file', args: { path: 'src/a.py' }, result: { success: true } };
const pass = { name: 'execute_code', args: { code: 'python3 -m pytest tests/test_a.py' }, result: { exit_code: 0, stdout: '3 passed' } };
const fail = { name: 'execute_code', args: { code: 'python3 -m pytest tests/test_a.py' }, result: { exit_code: 1, stdout: '1 failed, 2 passed' } };
const read = { name: 'read_file', args: { path: 'src/a.py' }, result: { content: 'x' } };

describe('verification states', () => {
    it('no_change without a write', () => expect(run([[read]])).toBe('no_change'));
    it('unverified: changed, never checked', () => expect(run([[read], [edit]])).toBe('unverified'));
    it('verified: a passing check after the last change', () => expect(run([[edit], [pass]])).toBe('verified'));
    it('a change after the check makes it unverified again', () => expect(run([[edit], [pass], [edit]])).toBe('unverified'));
    it('failed_verification: the last check failed', () => expect(run([[edit], [fail]])).toBe('failed_verification'));
    it('fixed after a failure and re-checked: verified', () => expect(run([[edit], [fail], [edit], [pass]])).toBe('verified'));
    it('a scratch file is not the change', () => {
        expect(run([[{ name: 'write_file', args: { path: 'repro_bug.py' }, result: { success: true } }]])).toBe('no_change');
        expect(run([[{ name: 'execute_code', args: { code: 'echo x > /tmp/o' }, result: { exit_code: 0, files_written: ['tmp/o.txt'] } }]])).toBe('no_change');
    });
    it('a script that merely ran is not a check', () => {
        const ran = { name: 'execute_code', args: { code: 'python3 repro.py' }, result: { exit_code: 0, stdout: 'ok' } };
        expect(run([[edit], [ran]])).toBe('unverified');
    });
    it('exit 0 with printed failures is not a pass', () => {
        const swallowed = { name: 'execute_code', args: { code: 'pytest -q || true' }, result: { exit_code: 0, stdout: '2 failed, 1 passed' } };
        expect(run([[edit], [swallowed]])).toBe('failed_verification');
    });
    it('an in-place shell edit in a task container is a change', () => {
        const sed = { name: 'execute_code', args: { code: "sed -i 's/a/b/' src/a.py" }, result: { exit_code: 0, stdout: '' } };
        expect(run([[sed]])).toBe('unverified');
    });
    it('a check that cannot import is unverified, not failed', () => {
        const broken = { name: 'execute_code', args: { code: 'python3 -m pytest t.py' }, result: { exit_code: 2, stdout: "ImportError: cannot import name 'Mapping' from 'collections'" } };
        expect(run([[edit], [broken]])).toBe('unverified');
    });
    it('a failed edit is not a change', () => {
        expect(run([[{ name: 'replace_in_file', args: { path: 'a.py' }, result: { error: 'not found' } }]])).toBe('no_change');
    });
});

describe('a check that ran no test', () => {
    const mk = (code: string, exit_code: number, stdout = '') => ({ name: 'execute_code', args: { code }, result: { exit_code, stdout } });
    it('pytest exit 4 / "collected 0 items" (an id absent from the checkout) is unverified, not failed', () => {
        const none = mk('pytest -xvs tests/test_new.py::test_x', 4, 'collected 0 items\n no tests ran in 0.03s');
        expect(run([[edit], [none]])).toBe('unverified');
    });
    it('pytest exit 5 and a runner that is not installed are not checks', () => {
        expect(run([[edit], [mk('python -m pytest -k nothing', 5, 'no tests ran')]])).toBe('unverified');
        expect(run([[edit], [mk('pytest tests/', 127, '')]])).toBe('unverified');
    });
    it('"Ran 0 tests" with exit 0 is not a pass', () => {
        expect(run([[edit], [mk('python -m unittest discover', 0, 'Ran 0 tests in 0.000s\n\nOK')]])).toBe('unverified');
    });
    it('a real failure that mentions "not found" in a test message still fails', () => {
        expect(run([[edit], [mk('pytest tests/test_a.py', 1, '1 failed, 2 passed\nE   FileNotFoundError: x not found')]])).toBe('failed_verification');
    });
    it('a not-run check does not erase an earlier real failure or pass', () => {
        const st = newVerification();
        noteStep(st, { toolCalls: [edit] }); noteStep(st, { toolCalls: [pass] });
        noteStep(st, { toolCalls: [mk('pytest nope.py', 4, 'collected 0 items')] });
        expect(verdict(st)).toBe('verified');
    });
});
