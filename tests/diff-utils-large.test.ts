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

describe('tryMerge does not depend on how long the unchanged text around the edits is (explorations W008)', () => {
    // A replaces the first of two identical lines, B replaces the third line: disjoint, so they merge. 700 lines of unique padding on each side put the two files past the size where
    // the exact method gave way to the greedy one, which then matched the other copy of the repeated line and made the edits overlap.
    const core = ['shared', 'anchor-1', 'anchor-2', 'shared', 'anchor-4'];
    const pad = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i}`);
    for (const [name, pre, post] of [['no padding', 0, 0], ['707 lines', 707, 0], ['700 before and after', 700, 700]] as const) {
        it(name, () => {
            const mk = (c: string[]) => [...pad(pre, 'pre'), ...c, ...pad(post, 'post')].join('\n');
            const base = mk(core);
            const a = mk(['edit-A', ...core.slice(1)]), b = mk([core[0], core[1], 'edit-B', ...core.slice(3)]);
            const want = mk(['edit-A', 'anchor-1', 'edit-B', 'shared', 'anchor-4']);
            for (const [x, y] of [[a, b], [b, a]]) expect(tryMerge(base, x, y)).toEqual({ merged: want, conflicts: false });
        });
    }
});

describe('tryMerge with two insertions at the same place (opencode cleanup discovery 2026-11-09 §3)', () => {
    const base = 'a\nb\n';
    it('identical insertions collapse to one, different ones conflict, one-sided ones merge as before', () => {
        expect(tryMerge(base, 'a\nimport x\nb\n', 'a\nimport x\nb\n')).toEqual({ merged: 'a\nimport x\nb\n', conflicts: false });
        expect(tryMerge(base, 'a\nimport x\nb\n', 'a\nimport y\nb\n').conflicts).toBe(true);
        expect(tryMerge(base, 'a\nimport x\nb\n', base)).toEqual({ merged: 'a\nimport x\nb\n', conflicts: false });
        expect(tryMerge('a\nb\nc\n', 'a\nX\nb\nc\n', 'a\nb\nY\nc\n')).toEqual({ merged: 'a\nX\nb\nY\nc\n', conflicts: false });   // different places
    });
});

// Day exploration D007: an insertion where the other side replaces or deletes the line at the same position gave back the old line, in one argument order.
describe('tryMerge with an insertion at the start of the other side\'s replacement', () => {
    const base = 'a\nb\nc';
    const cases: Array<[string, string, string]> = [
        ['replace + insert', 'a\nB\nc', 'a\nnew\nb\nc'],
        ['delete + insert', 'a\nc', 'a\nnew\nb\nc'],
    ];
    for (const [name, one, other] of cases) it(`${name} merges the same in both orders`, async () => {
        const { tryMerge } = await import('../diff-utils.ts');
        const want = name.startsWith('replace') ? 'a\nnew\nB\nc' : 'a\nnew\nc';
        for (const [x, y] of [[one, other], [other, one]]) expect(tryMerge(base, x, y)).toEqual({ merged: want, conflicts: false });
    });
});
