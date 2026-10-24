// What a finished run says about the files it changed: from the tool log and the disk, not from the model's account.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newVerification, noteStep, verdict } from '../verification.ts';
import { checkChangedFiles, finishLines } from '../finish-summary.ts';

const call = (name: string, args: any, result: any = { ok: true }) => ({ name, args, result });

describe('verification records the files a run changed', () => {
    it('collects write-tool paths, shell-written paths and files_written; scratch files and failed calls do not count', () => {
        const st = newVerification();
        noteStep(st, { toolCalls: [
            call('write_file', { path: 'src/a.ts' }),
            call('replace_in_file', { path: 'b.ts' }),
            call('write_file', { path: 'scratch_x.txt' }),                       // scratch
            call('write_file', { path: 'c.ts' }, { error: 'denied' }),           // failed
            call('execute_code', { language: 'bash', code: 'echo hi > out.txt' }, { exit_code: 0, stdout: '' }),
            call('execute_code', { language: 'python', code: 'x' }, { exit_code: 0, files_written: ['d.json', 'tmp/zz.txt'] }),
        ] });
        expect([...st.files].sort()).toEqual(['b.ts', 'd.json', 'out.txt', 'src/a.ts']);
        expect(verdict(st)).toBe('unverified');
    });
});

describe('checkChangedFiles', () => {
    it('reports an emptied file, a syntax error, invalid JSON and a vanished file; leaves good files alone', async () => {
        const root = mkdtempSync(join(tmpdir(), 'fg-fin-'));
        try {
            mkdirSync(join(root, 'src'));
            writeFileSync(join(root, 'empty.ts'), '');
            writeFileSync(join(root, 'src/broken.ts'), 'export function f() {\n  return "unterminated;\n}\n');
            writeFileSync(join(root, 'good.ts'), 'export const x: number = 1;\n');
            writeFileSync(join(root, 'bad.json'), '{"a": 1,}');
            writeFileSync(join(root, 'notes.md'), '# hi\n');
            const res = await checkChangedFiles(root, ['empty.ts', 'src/broken.ts', 'good.ts', 'bad.json', 'notes.md', 'gone.ts', join(root, 'good.ts')]);
            const by = Object.fromEntries(res.map(r => [r.path, r.problem]));
            expect(by['empty.ts']).toMatch(/EMPTY/);
            expect(by['src/broken.ts']).toMatch(/syntax error at line 2/);
            expect(by['good.ts']).toBeNull();
            expect(by['bad.json']).toMatch(/invalid JSON/);
            expect(by['notes.md']).toBeNull();
            expect(by['gone.ts']).toMatch(/no longer exists/);
            expect(res.filter(r => r.path === 'good.ts')).toHaveLength(1);       // the absolute and the relative path are one file
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});

describe('finishLines', () => {
    const fin = (signal: string, extra: any = {}) => ({ signal, stopReason: null, timedOut: false, verification: 'unverified', ...extra });
    it('says nothing for a complete run that changed nothing', () => {
        expect(finishLines(fin('complete', { verification: 'no_change' }), [])).toEqual([]);
    });
    it('names how a run ended when it did not complete, and the broken files', () => {
        const lines = finishLines(fin('blocked', { stopReason: 'step budget exhausted' }), [{ path: 'model-caps.ts', problem: 'EMPTY (0 bytes)' }, { path: 'ok.ts', problem: null }]);
        expect(lines[0]).toBe('[fg-run] finished: blocked (step budget exhausted); verification: unverified');
        expect(lines[1]).toBe('[fg-run] changed 2 files: model-caps.ts [EMPTY (0 bytes)], ok.ts');
        expect(lines[2]).toContain('WARNING: 1 changed file is broken: model-caps.ts');
    });
    it('a timed-out run says so', () => {
        expect(finishLines(fin('stopped', { timedOut: true }), [])[0]).toContain('stopped (time limit)');
    });
});
