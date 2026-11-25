// A file written in full again and again gets one nudge every fourth time; a passing check or a targeted edit starts the count over.
import { describe, it, expect } from 'vitest';
import { newRewriteState, noteRewrites } from '../detectors.ts';

const w = (path: string, error?: string) => ({ name: 'write_file', args: { path }, result: error ? { error } : { ok: true } });
describe('noteRewrites', () => {
    it('nudges on the 4th and 8th full write of one file, not before, and names the file', () => {
        const st = newRewriteState(); const hits: (string | null)[] = [];
        for (let i = 0; i < 8; i++) hits.push(noteRewrites(st, [w('a.ts')]));
        expect(hits.map(h => h !== null)).toEqual([false, false, false, true, false, false, false, true]);
        expect(hits[3]).toMatch(/a\.ts in full 4 times/);
        expect(hits[3]).toMatch(/replace_in_file/);
    });
    it('different files are counted apart; failed writes do not count', () => {
        const st = newRewriteState();
        for (let i = 0; i < 3; i++) { noteRewrites(st, [w('a.ts')]); noteRewrites(st, [w('b.ts')]); }
        expect(noteRewrites(st, [w('a.ts', 'denied')])).toBeNull();
        expect(noteRewrites(st, [w('c.ts')])).toBeNull();
        expect(noteRewrites(st, [w('a.ts')])).toMatch(/a\.ts in full 4 times/);
    });
    it('a targeted replace_in_file on the file, or a passing check, starts over', () => {
        const st = newRewriteState();
        for (let i = 0; i < 3; i++) noteRewrites(st, [w('a.ts')]);
        noteRewrites(st, [{ name: 'replace_in_file', args: { path: 'a.ts' }, result: { ok: true } }]);
        expect(noteRewrites(st, [w('a.ts')])).toBeNull();
        for (let i = 0; i < 2; i++) noteRewrites(st, [w('a.ts')]);
        noteRewrites(st, [{ name: 'execute_code', args: { language: 'bash', code: 'npx vitest run' }, result: { exit_code: 0 } }]);
        expect(noteRewrites(st, [w('a.ts')])).toBeNull();     // would have been the 4th
    });
    it('a passing check that names another file does not start the count over (R978)', () => {
        const st = newRewriteState();
        for (let i = 0; i < 3; i++) noteRewrites(st, [w('src/broken.ts')]);
        noteRewrites(st, [{ name: 'execute_code', args: { language: 'bash', code: 'node --check scripts/healthy.js' }, result: { exit_code: 0 } }]);
        expect(noteRewrites(st, [w('src/broken.ts')])).toMatch(/src\/broken\.ts in full 4 times/);
        noteRewrites(st, [{ name: 'execute_code', args: { language: 'bash', code: 'node --check src/broken.ts' }, result: { exit_code: 0 } }]);
        // Asserted at the fourth write after the check: the nudge only fires on multiples of four, so "no nudge at the next write" holds whether or not the count was cleared (refcompare 2026-11-17, RC-04).
        for (let i = 0; i < 3; i++) expect(noteRewrites(st, [w('src/broken.ts')])).toBeNull();
        expect(noteRewrites(st, [w('src/broken.ts')])).toMatch(/src\/broken\.ts in full 4 times/);
    });
    it('a check of scripts/index.js does not clear src/index.js (review of 7116993)', () => {
        const st = newRewriteState();
        for (let i = 0; i < 3; i++) noteRewrites(st, [w('src/index.js')]);
        noteRewrites(st, [{ name: 'execute_code', args: { language: 'bash', code: 'node --check scripts/index.js' }, result: { exit_code: 0 } }]);
        expect(noteRewrites(st, [w('src/index.js')])).toMatch(/src\/index\.js in full 4 times/);
    });
    it('a check naming data.ts does not clear a.ts (review 2026-11-16 CR-02)', () => {
        const ok = (code: string) => ({ name: 'execute_code', args: { language: 'bash', code }, result: { exit_code: 0 } });
        const st = newRewriteState();
        for (let i = 0; i < 3; i++) noteRewrites(st, [w('a.ts')]);
        noteRewrites(st, [ok('node --check data.ts')]);
        expect(noteRewrites(st, [w('a.ts')])).toMatch(/a\.ts in full 4 times/);
    });
    it('a passing run of named test files covers the project, like a run that names none', () => {
        const ok = (code: string) => ({ name: 'execute_code', args: { language: 'bash', code }, result: { exit_code: 0 } });
        for (const cmd of ['npx vitest run tests/x.test.ts', 'pytest tests/test_x.py::test_a -q']) {
            const st = newRewriteState();
            for (let i = 0; i < 3; i++) noteRewrites(st, [w('src/x.ts')]);
            noteRewrites(st, [ok(cmd)]);
            expect(noteRewrites(st, [w('src/x.ts')]), cmd).toBeNull();
        }
    });
    it('equivalent spellings of one path are one file (R1122)', () => {
        const st = newRewriteState(); let hit: string | null = null;
        for (const p of ['a.ts', './a.ts', '/workspace/a.ts', 'a.ts']) hit = noteRewrites(st, [w(p)]);
        expect(hit).toMatch(/a\.ts in full 4 times/);
    });
});
