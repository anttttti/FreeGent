import { describe, it, expect } from 'vitest';

// Inline copies of the implementations in llm-shared.js and llm-loops.ts / workers.js.
// These must be kept in sync with the source if the algorithms change.

function _lcsMatrix(A, B) {
    const M = A.length, N = B.length;
    const dp = Array.from({ length: M + 1 }, () => new Int32Array(N + 1));
    for (let i = M - 1; i >= 0; i--)
        for (let j = N - 1; j >= 0; j--)
            dp[i][j] = A[i] === B[j] ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);
    return dp;
}

function _lcsDiff(A, B) {
    const m = A.length, n = B.length;
    if (m === 0 && n === 0) return [];
    if (m * n > 2_000_000) {
        return [...A.map(t => ({ type: '-', text: t })), ...B.map(t => ({ type: '+', text: t }))];
    }
    const dp = _lcsMatrix(A, B);
    const ops = [];
    let i = 0, j = 0;
    while (i < m || j < n) {
        if (i < m && j < n && A[i] === B[j]) { ops.push({ type: ' ', text: A[i] }); i++; j++; }
        else if (i < m && (j === n || dp[i+1][j] >= dp[i][j+1])) { ops.push({ type: '-', text: A[i] }); i++; }
        else { ops.push({ type: '+', text: B[j] }); j++; }
    }
    return ops;
}

function lcsMatches(a, b) {
    const M = a.length, N = b.length;
    if (!M || !N) return [];
    if (M * N > 500000) {
        const idx = new Map();
        for (let j = 0; j < N; j++) { if (!idx.has(b[j])) idx.set(b[j], []); idx.get(b[j]).push(j); }
        const matches = []; let jMin = 0;
        for (let i = 0; i < M; i++) {
            const cands = idx.get(a[i]); if (!cands) continue;
            let lo = 0, hi = cands.length;
            while (lo < hi) { const mid = (lo + hi) >> 1; if (cands[mid] < jMin) lo = mid + 1; else hi = mid; }
            if (lo === cands.length) continue;
            matches.push([i, cands[lo]]); jMin = cands[lo] + 1;
        }
        return matches;
    }
    const dp = _lcsMatrix(a, b);
    const matches = []; let i = 0, j = 0;
    while (i < M && j < N) {
        if (a[i] === b[j]) { matches.push([i, j]); i++; j++; }
        else if (dp[i+1][j] >= dp[i][j+1]) i++; else j++;
    }
    return matches;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function applyDiff(ops, A) {
    const out = [];
    let ai = 0;
    for (const op of ops) {
        if (op.type === ' ') { expect(A[ai]).toBe(op.text); out.push(op.text); ai++; }
        else if (op.type === '-') { expect(A[ai]).toBe(op.text); ai++; }
        else { out.push(op.text); }
    }
    expect(ai).toBe(A.length); // all of A was consumed
    return out;
}

function diffInvariant(A, B) {
    const ops = _lcsDiff(A, B);
    const result = applyDiff(ops, A);
    expect(result).toEqual(B);
    // Ops must cover A and B exactly
    const fromA = ops.filter(o => o.type !== '+').map(o => o.text);
    const fromB = ops.filter(o => o.type !== '-').map(o => o.text);
    expect(fromA).toEqual(A);
    expect(fromB).toEqual(B);
}

function s(str) { return str.split(''); }   // string → char array for concise tests
function L(str) { return str.split('\n'); } // newline-split for line-level tests

// ── _lcsMatrix ────────────────────────────────────────────────────────────────

describe('_lcsMatrix', () => {
    it('returns correct LCS length at [0][0]', () => {
        const A = s('abcde'), B = s('ace');
        const dp = _lcsMatrix(A, B);
        expect(dp[0][0]).toBe(3); // LCS = 'ace'
    });

    it('empty A', () => {
        const dp = _lcsMatrix([], s('abc'));
        expect(dp[0][0]).toBe(0);
    });

    it('empty B', () => {
        const dp = _lcsMatrix(s('abc'), []);
        expect(dp[0][0]).toBe(0);
    });

    it('identical arrays', () => {
        const A = s('hello');
        const dp = _lcsMatrix(A, A);
        expect(dp[0][0]).toBe(A.length);
    });

    it('no common elements', () => {
        const dp = _lcsMatrix(s('abc'), s('xyz'));
        expect(dp[0][0]).toBe(0);
    });

    it('matrix dimensions are (M+1) × (N+1)', () => {
        const A = [1, 2, 3], B = [4, 5];
        const dp = _lcsMatrix(A, B);
        expect(dp.length).toBe(4);
        expect(dp[0].length).toBe(3);
    });

    it('boundary rows/cols are zero', () => {
        const dp = _lcsMatrix(s('abc'), s('de'));
        // Last row (i = M) and last col (j = N) are all zero
        expect([...dp[3]]).toEqual([0, 0, 0]);
        for (const row of dp) expect(row[2]).toBe(0);
    });
});

// ── _lcsDiff ──────────────────────────────────────────────────────────────────

describe('_lcsDiff', () => {
    it('both empty', () => {
        expect(_lcsDiff([], [])).toEqual([]);
    });

    it('A empty → all inserts', () => {
        const ops = _lcsDiff([], s('abc'));
        expect(ops).toEqual([
            { type: '+', text: 'a' },
            { type: '+', text: 'b' },
            { type: '+', text: 'c' },
        ]);
    });

    it('B empty → all deletes', () => {
        const ops = _lcsDiff(s('abc'), []);
        expect(ops).toEqual([
            { type: '-', text: 'a' },
            { type: '-', text: 'b' },
            { type: '-', text: 'c' },
        ]);
    });

    it('identical arrays → all matches', () => {
        const A = s('hello');
        const ops = _lcsDiff(A, A);
        expect(ops.every(o => o.type === ' ')).toBe(true);
        expect(ops.map(o => o.text)).toEqual(A);
    });

    it('no common elements → all deletes then inserts', () => {
        const A = s('abc'), B = s('xyz');
        const ops = _lcsDiff(A, B);
        const deletes = ops.filter(o => o.type === '-').map(o => o.text);
        const inserts = ops.filter(o => o.type === '+').map(o => o.text);
        expect(deletes).toEqual(A);
        expect(inserts).toEqual(B);
    });

    it('satisfies apply-diff invariant: classic example', () => {
        diffInvariant(s('abcde'), s('ace'));
    });

    it('satisfies apply-diff invariant: prefix change', () => {
        diffInvariant(s('abcde'), s('xbcde'));
    });

    it('satisfies apply-diff invariant: suffix change', () => {
        diffInvariant(s('abcde'), s('abcdx'));
    });

    it('satisfies apply-diff invariant: middle insertion', () => {
        diffInvariant(s('abde'), s('abcde'));
    });

    it('satisfies apply-diff invariant: completely changed', () => {
        diffInvariant(s('foo'), s('bar'));
    });

    it('satisfies apply-diff invariant: line-level code edit', () => {
        const A = L('function foo() {\n  return 1;\n}');
        const B = L('function foo(x) {\n  return x + 1;\n}');
        diffInvariant(A, B);
    });

    it('satisfies apply-diff invariant: insert at start', () => {
        diffInvariant(['b', 'c', 'd'], ['a', 'b', 'c', 'd']);
    });

    it('satisfies apply-diff invariant: insert at end', () => {
        diffInvariant(['a', 'b', 'c'], ['a', 'b', 'c', 'd']);
    });

    it('satisfies apply-diff invariant: delete from middle', () => {
        diffInvariant(['a', 'b', 'c', 'd'], ['a', 'd']);
    });

    it('ops are in source order (no reverse needed)', () => {
        // If the traceback were backward and forgot ops.reverse(), ops would be backwards.
        const A = ['x', 'y', 'z'];
        const B = ['x', 'w', 'z'];
        const ops = _lcsDiff(A, B);
        expect(ops[0]).toMatchObject({ type: ' ', text: 'x' });
        expect(ops[ops.length - 1]).toMatchObject({ type: ' ', text: 'z' });
    });
});

// ── lcsMatches ────────────────────────────────────────────────────────────────

describe('lcsMatches', () => {
    it('returns [] for empty inputs', () => {
        expect(lcsMatches([], ['a'])).toEqual([]);
        expect(lcsMatches(['a'], [])).toEqual([]);
        expect(lcsMatches([], [])).toEqual([]);
    });

    it('match pairs are strictly increasing in both dimensions', () => {
        const a = s('abcde'), b = s('ace');
        const matches = lcsMatches(a, b);
        for (let k = 1; k < matches.length; k++) {
            expect(matches[k][0]).toBeGreaterThan(matches[k-1][0]);
            expect(matches[k][1]).toBeGreaterThan(matches[k-1][1]);
        }
    });

    it('all matched pairs satisfy a[i] === b[j]', () => {
        const a = s('abcde'), b = s('ace');
        for (const [i, j] of lcsMatches(a, b)) {
            expect(a[i]).toBe(b[j]);
        }
    });

    it('match count equals LCS length', () => {
        const a = s('abcde'), b = s('ace');
        const dp = _lcsMatrix(a, b);
        expect(lcsMatches(a, b).length).toBe(dp[0][0]);
    });

    it('no common elements → no matches', () => {
        expect(lcsMatches(s('abc'), s('xyz'))).toEqual([]);
    });

    it('identical arrays → all lines matched', () => {
        const a = s('hello');
        const m = lcsMatches(a, a);
        expect(m.length).toBe(a.length);
        m.forEach(([i, j], k) => { expect(i).toBe(k); expect(j).toBe(k); });
    });
});
