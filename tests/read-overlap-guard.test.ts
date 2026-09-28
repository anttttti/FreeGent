// Overlapping-read guard (llm-loops.ts): reads that add no new lines of a file are allowed a few
// times, then refused. SWE-bench Lite v0.55 sympy-18189 rotated through ~6 overlapping ranges of
// one file for 88 steps; the byte-identical repeat cache never refused any of them.
import { describe, it, expect, beforeAll } from 'vitest';

let M: any;
beforeAll(async () => { M = await import('../llm-loops.ts'); });

const ok = (lines = 50) => ({ path: 'f.py', content: 'x\n'.repeat(lines) });

describe('_checkRedundantRead', () => {
    it('refuses the sympy range rotation after a few redundant reads', () => {
        const ledger = new Map();
        const reads = [[1, 400], [280, 350], [250, 310], [200, 250], [200, 350], [210, 350]];
        const verdicts = reads.map(([s, e]) => {
            const args = { path: 'sympy/solvers/diophantine.py', start_line: s, end_line: e };
            const v = M._checkRedundantRead(ledger, args);
            if (!v?.error) M._recordRead(ledger, args, ok());
            return v?.error ? 'refused' : v?.note ? 'served+note' : 'ran';
        });
        // First read is new; the next two redundant ones run; the next two are refused; after
        // that the lines are served again with a note rather than refused indefinitely.
        expect(verdicts).toEqual(['ran', 'ran', 'ran', 'refused', 'refused', 'served+note']);
    });

    it('gives way after two refusals: serves the lines with a note (v0.56 sympy-14531: 25 refusals)', () => {
        const ledger = new Map();
        const args = { path: 'sympy/printing/str.py', start_line: 600, end_line: 650 };
        M._recordRead(ledger, { path: 'sympy/printing/str.py', start_line: 546, end_line: 849 }, ok(300));
        const verdicts = Array.from({ length: 7 }, () => {
            const v = M._checkRedundantRead(ledger, args);
            return v?.error ? 'refused' : v?.note ? 'served+note' : 'ran';
        });
        expect(verdicts).toEqual(['ran', 'ran', 'refused', 'refused', 'served+note', 'served+note', 'served+note']);
        expect(M.REDUNDANT_READ_REFUSALS_MAX).toBe(2);
    });

    it('allows reads that add new lines, and reads of other files', () => {
        const ledger = new Map();
        M._recordRead(ledger, { path: 'f.py', start_line: 1, end_line: 100 }, ok());
        for (let i = 0; i < 5; i++) {
            expect(M._checkRedundantRead(ledger, { path: 'f.py', start_line: 90, end_line: 200 + i })).toBeNull();
            expect(M._checkRedundantRead(ledger, { path: 'g.py', start_line: 1, end_line: 10 })).toBeNull();
        }
    });

    it('does not count a truncated whole-file read as covering the file', () => {
        const ledger = new Map();
        M._recordRead(ledger, { path: 'big.py' }, { path: 'big.py', content: 'y'.repeat(20_000) });
        for (let i = 0; i < 5; i++) expect(M._checkRedundantRead(ledger, { path: 'big.py', start_line: 10, end_line: 20 })).toBeNull();
    });
});

describe('_execMayWrite', () => {
    it('treats read-only commands as non-writing', () => {
        for (const code of ['python3 repro.py', 'grep -n foo f.py', "sed -n '1,20p' f.py", 'cat f.py | head', 'pytest tests/ 2>&1'])
            expect(M._execMayWrite({ code }, { exit_code: 0 })).toBe(false);
    });
    it('treats writes as writes', () => {
        for (const code of ["sed -i 's/a/b/' f.py", 'echo x > f.py', 'cp a.py b.py', "python3 -c \"open('f.py','w').write('x')\"", 'git checkout f.py'])
            expect(M._execMayWrite({ code }, { exit_code: 0 })).toBe(true);
        expect(M._execMayWrite({ code: 'make' }, { files_written: ['f.py'] })).toBe(true);
    });
});
