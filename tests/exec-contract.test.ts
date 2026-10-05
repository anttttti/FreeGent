// scripts/exec-diff/contract.py — the evaluator behind exec-diff's "contract" cases. It runs in Python
// (the harness is shell + Python), so these drive it through its `eval` entry point.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const script = resolve(import.meta.dirname, '../scripts/exec-diff/contract.py');
const evalContract = (contract: any, io: { stdout?: string; stderr?: string; exit?: number; files?: string[] } = {}) => {
    const r = spawnSync('python3', [script, 'eval'], { input: JSON.stringify({ contract, ...io }), encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout);
};

describe('exec-diff contracts', () => {
    it('holds when stdout, stderr and exit all satisfy the rule', () => {
        expect(evalContract({ stdout: 'Linux\\n', stderr: '' }, { stdout: 'Linux\n' })).toEqual({ problems: [] });
        expect(evalContract({ stdout: '\\d+\\n' }, { stdout: '128\n' })).toEqual({ problems: [] });
    });
    it('names what broke', () => {
        const r = evalContract({ stdout: 'Linux\\n', stderr: '' }, { stdout: 'Shiro\n', stderr: 'oops', exit: 2 });
        expect(r.problems.join('|')).toMatch(/exit 2, expected 0/);
        expect(r.problems.join('|')).toMatch(/stdout 'Shiro\\n' does not match/);
        expect(r.problems.join('|')).toMatch(/stderr 'oops' does not match/);
    });
    it('matches the whole output, not a fragment of it', () => {
        expect(evalContract({ stdout: 'hello\\n' }, { stdout: 'hello\nextra\n' }).problems.length).toBe(1);
    });
    it('normalizes terminal escapes, CRLF and elapsed time before matching', () => {
        expect(evalContract({ normalize: ['ansi'], stdout: 'hello\\n' }, { stdout: '\x1b[38;5;196mh\x1b[0m\x1b[38;5;202mello\x1b[0m\n' })).toEqual({ problems: [] });
        expect(evalContract({ normalize: ['cr'], stdout: '(hello\\n)+' }, { stdout: 'hello\r\nhello\r\n' })).toEqual({ problems: [] });
        expect(evalContract({ normalize: ['elapsed'], stdout: '1 passed in #s\\n' }, { stdout: '1 passed in 0.01s\n' })).toEqual({ problems: [] });
    });
    it('limits file changes to the allowed paths, with directory prefixes', () => {
        const rule = { files: ['test_sample.py', '.pytest_cache/'] };
        expect(evalContract(rule, { files: ['test_sample.py', '.pytest_cache/v/cache/nodeids'] })).toEqual({ problems: [] });
        expect(evalContract(rule, { files: ['test_sample.py', 'stray.txt'] }).problems[0]).toMatch(/unexpected file changes: stray\.txt/);
        expect(evalContract({}, { files: ['anything'] })).toEqual({ problems: [] });   // unchecked unless declared
    });
    it('rejects a malformed contract when it is recorded', () => {
        expect(evalContract({ stdout: '(' }).invalid).toBeTruthy();
        expect(evalContract({ normalize: ['nope'] }).invalid).toMatch(/unknown normalizer/);
        expect(evalContract({ colour: 1 }).invalid).toMatch(/bad contract keys/);
        expect(evalContract({ native: 'none' }).invalid).toMatch(/native_note/);
    });
});
