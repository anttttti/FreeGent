// tryMerge on a file longer than V8's spread-argument limit (~125k lines): an edit at each end used to throw "Maximum call stack size exceeded" (hermes commit review, commit 9).
import { describe, it, expect } from 'vitest';
import { tryMerge } from '../diff-utils.ts';

describe('tryMerge on a very long file', () => {
    it('merges one edit at the top of one side and one at the bottom of the other', () => {
        const n = 200_000;
        const base = Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
        const a = base.replace('line 0\n', 'line 0 EDITED A\n');
        const b = base.slice(0, base.lastIndexOf('line ' + (n - 1))) + 'line ' + (n - 1) + ' EDITED B';
        const r = tryMerge(base, a, b);
        expect(r.conflicts).toBe(false);
        const lines = r.merged.split('\n');
        expect(lines.length).toBe(n);
        expect(lines[0]).toBe('line 0 EDITED A');
        expect(lines[n - 1]).toBe(`line ${n - 1} EDITED B`);
        expect(lines[n >> 1]).toBe(`line ${n >> 1}`);
    });
    it('still reports an overlapping edit as a conflict', () => {
        const base = 'a\nb\nc';
        expect(tryMerge(base, 'a\nX\nc', 'a\nY\nc').conflicts).toBe(true);
        expect(tryMerge(base, 'A\nb\nc', 'a\nb\nC')).toEqual({ merged: 'A\nb\nC', conflicts: false });
    });
});
