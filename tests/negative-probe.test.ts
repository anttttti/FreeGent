// An empty grep/diff is an answer, not a failure (CTF 71, v0.70).
import { describe, it, expect } from 'vitest';
import { isNegativeProbe, failStreakKind, updateFailStreak } from '../detectors.ts';

const r1 = { exit_code: 1, stdout: '', stderr: '' };
describe('isNegativeProbe', () => {
    it('recognises an empty grep, a piped grep and diff', () => {
        expect(isNegativeProbe({ language: 'bash', code: 'grep -rn "flag{" .' }, r1)).toBe(true);
        expect(isNegativeProbe({ language: 'bash', code: 'strings a.bin | grep -i flag' }, r1)).toBe(true);
        expect(isNegativeProbe({ language: 'bash', code: 'cd /tmp\n# look\ndiff a b' }, r1)).toBe(true);
    });
    it('does not excuse a real failure', () => {
        expect(isNegativeProbe({ language: 'bash', code: 'python3 x.py' }, r1)).toBe(false);
        expect(isNegativeProbe({ language: 'bash', code: 'grep x f' }, { exit_code: 2, stdout: '', stderr: 'grep: f: No such file' })).toBe(false);
        expect(isNegativeProbe({ language: 'bash', code: 'grep x f' }, { exit_code: 1, stdout: '', stderr: 'oops' })).toBe(false);
        expect(isNegativeProbe({ language: 'bash', code: 'grep x f; echo done' }, { exit_code: 1, stdout: '', stderr: '' })).toBe(false);
    });
    it('is neutral in the failure streak', () => {
        expect(failStreakKind('execute_code', r1, new Set(), { language: 'bash', code: 'grep -rn zzz .' })).toBe('neutral');
        expect(failStreakKind('execute_code', r1, new Set(), { language: 'bash', code: 'python3 boom.py' })).toBe('fail');
        expect(updateFailStreak(3, [{ name: 'execute_code', result: r1, args: { language: 'bash', code: 'grep q .' } }], new Set())).toBe(3);
    });
});

import { _callSig } from '../detectors.ts';
describe('_callSig', () => {
    it('ignores comment lines and indentation in execute_code, not the commands', () => {
        const a = _callSig([{ name: 'execute_code', args: { language: 'bash', code: '# look for it\nfind . -name "*.py"\n' } }]);
        const b = _callSig([{ name: 'execute_code', args: { language: 'bash', code: '# another look\n  find . -name "*.py"' } }]);
        const c = _callSig([{ name: 'execute_code', args: { language: 'bash', code: 'find . -name "*.js"' } }]);
        expect(a).toBe(b);
        expect(a).not.toBe(c);
    });
});

import { isQuestionOnlyTask, inventedDataPaths } from '../detectors.ts';
describe('query tasks and invented data', () => {
    it('a question that names no action', () => {
        expect(isQuestionOnlyTask('How many lines in all the log files under /var/log/app contain the word error?')).toBe(true);
        expect(isQuestionOnlyTask('Which file in /agent is the largest? Give its name.')).toBe(true);
    });
    it('a task with an action is not question-only', () => {
        expect(isQuestionOnlyTask('Create a file named x and write 3 lines to it.')).toBe(false);
        expect(isQuestionOnlyTask('Change the permissions of all files in ~/videos to 660.')).toBe(false);
    });
    it('data files are flagged, scratch and temp are not', () => {
        const scratch = (p: string) => /repro|scratch/.test(p);
        expect(inventedDataPaths(['logs/app.log', 'repro.py', '/tmp/x.txt', 'notes', 'run.sh'], scratch)).toEqual(['logs/app.log', 'notes']);
    });
});

import { suppliedFiles, shellWritePaths, overwrittenSupplied } from '../detectors.ts';
describe('supplied files', () => {
    it('parses the workspace listing and finds overwrites', () => {
        const sup = suppliedFiles('<workspace_files>\n3 files:\nfile1.log\ndir/file2.log\nnotlogfile.txt\n</workspace_files>\n\ntask');
        expect([...sup]).toEqual(['file1.log', 'dir/file2.log', 'notlogfile.txt']);
        expect(overwrittenSupplied(['./file1.log', 'out.txt', 'x/file2.log'], sup).sort()).toEqual(['file1.log', 'x/file2.log']);
        expect(overwrittenSupplied(['src/world.js'], new Set(['src/world.js']))).toEqual([]);
    });
    it('finds redirect and tee targets', () => {
        expect(shellWritePaths("echo a > file1.log && cat b >> out.txt | tee -a c.log; echo x 2>&1 >/dev/null").sort()).toEqual(['c.log', 'file1.log', 'out.txt']);
    });
});
