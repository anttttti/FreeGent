// diff-utils.ts — FreeGent: shared LCS/diff utilities
// Consolidates three previously-duplicate implementations:
//   - _lcsMatrix: was in llm-shared.ts (Issue 13 shared DP core)
//   - splitLines, lcsMatches, diffRegions, applyMergeHunks, tryMerge: were in workers.ts
//   - _lcsDiff, _diffContent: were in llm-loops.ts

// Shared LCS DP core (backward-fill). dp[i][j] = length of LCS of A[i..] and B[j..].
export function _lcsMatrix(A, B) {
    const M = A.length, N = B.length;
    const dp = Array.from({ length: M + 1 }, () => new Int32Array(N + 1));
    for (let i = M - 1; i >= 0; i--)
        for (let j = N - 1; j >= 0; j--)
            dp[i][j] = A[i] === B[j] ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);
    return dp;
}

export function splitLines(text: string): string[] { return text === '' ? [] : text.split('\n'); }

// LCS match pairs [iA, iB]; greedy hash for large files, DP for small ones
export function lcsMatches(a: string[], b: string[]): [number, number][] {
    const M = a.length, N = b.length;
    if (!M || !N) return [];
    if (M * N > 500000) {
        const idx = new Map();
        for (let j = 0; j < N; j++) { if (!idx.has(b[j])) idx.set(b[j], []); idx.get(b[j]).push(j); }
        const matches = [];
        let jMin = 0;
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

export function diffRegions(base: string[], side: string[]): Array<{type: 'eq'|'del'|'ins'|'rep'; baseStart: number; baseEnd: number; sideStart: number; sideEnd: number}> {
    const matches = lcsMatches(base, side);
    const regions = []; let bi = 0, si = 0;
    for (const [bm, sm] of matches) {
        if (bi < bm || si < sm) {
            regions.push({ type: bi < bm && si < sm ? 'rep' : bi < bm ? 'del' : 'ins',
                           baseStart: bi, baseEnd: bm, sideStart: si, sideEnd: sm });
        }
        regions.push({ type: 'eq', baseStart: bm, baseEnd: bm + 1, sideStart: sm, sideEnd: sm + 1 });
        bi = bm + 1; si = sm + 1;
    }
    if (bi < base.length || si < side.length)
        regions.push({ type: bi < base.length && si < side.length ? 'rep' : bi < base.length ? 'del' : 'ins',
                       baseStart: bi, baseEnd: base.length, sideStart: si, sideEnd: side.length });
    return regions;
}

function applyMergeHunks(baseLines: string[], hunks: Array<{bs: number; be: number; rep: string[]}>, start: number, end: number): string[] {
    const out = []; let bi = start;
    for (const h of hunks) {
        if (h.bs > bi) out.push(...baseLines.slice(bi, h.bs));
        out.push(...h.rep); bi = h.be;
    }
    if (bi < end) out.push(...baseLines.slice(bi, end));
    return out;
}

export function tryMerge(base: string, sideA: string, sideB: string): { merged: string; conflicts: boolean } {
    const bLines = splitLines(base);
    const aLines = splitLines(sideA);
    const cLines = splitLines(sideB);
    function extractHunks(baseArr, sideArr) {
        return diffRegions(baseArr, sideArr)
            .filter(r => r.type !== 'eq')
            .map(r => ({ bs: r.baseStart, be: r.baseEnd, rep: sideArr.slice(r.sideStart, r.sideEnd) }));
    }
    const HA = extractHunks(bLines, aLines);
    const HB = extractHunks(bLines, cLines);
    const out = []; let hasConflicts = false, ai = 0, bj = 0, bi = 0;
    while (bi <= bLines.length) {
        const hA = ai < HA.length ? HA[ai] : null;
        const hB = bj < HB.length ? HB[bj] : null;
        if (!hA && !hB) { out.push(...bLines.slice(bi)); break; }
        const next = Math.min(hA ? hA.bs : Infinity, hB ? hB.bs : Infinity);
        if (next > bi) {
            if (bi < bLines.length) out.push(...bLines.slice(bi, Math.min(next, bLines.length)));
            bi = next; continue;
        }
        const groupA = [], groupB = [];
        let spanEnd = bi, again = true;
        while (again) {
            again = false;
            while (ai < HA.length && HA[ai].bs <= spanEnd) { spanEnd = Math.max(spanEnd, HA[ai].be); groupA.push(HA[ai++]); again = true; }
            while (bj < HB.length && HB[bj].bs <= spanEnd) { spanEnd = Math.max(spanEnd, HB[bj].be); groupB.push(HB[bj++]); again = true; }
        }
        if (!groupA.length) {
            out.push(...applyMergeHunks(bLines, groupB, bi, spanEnd));
        } else if (!groupB.length) {
            out.push(...applyMergeHunks(bLines, groupA, bi, spanEnd));
        } else {
            // Only treat as a true conflict if any A and B hunks overlap in base lines.
            // Adjacent edits (one ends where another begins) are not real conflicts.
            const baseOverlap = groupA.some(a => groupB.some(b => a.bs < b.be && b.bs < a.be));
            if (!baseOverlap) {
                const allHunks = [...groupA, ...groupB].sort((x, y) => x.bs - y.bs);
                out.push(...applyMergeHunks(bLines, allHunks, bi, spanEnd));
            } else {
                const wantA = applyMergeHunks(bLines, groupA, bi, spanEnd);
                const wantB = applyMergeHunks(bLines, groupB, bi, spanEnd);
                if (JSON.stringify(wantA) === JSON.stringify(wantB)) {
                    out.push(...wantA);
                } else {
                    hasConflicts = true;
                    out.push('<<<<<<< A', ...wantA, '=======', ...wantB, '>>>>>>> B');
                }
            }
        }
        bi = spanEnd;
    }
    return { merged: out.join('\n'), conflicts: hasConflicts };
}

// LCS diff on two arrays of strings. Returns [{type:' '|'+'|'-', text}].
// Falls back to all-changed for very large inputs to avoid O(nm) stall.
export function _lcsDiff(A: string[], B: string[]): Array<{type: string; text: string}> {
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

// Build a proper unified diff string. Returns diff if shorter than newContent, else null.
export function _diffContent(oldContent: string | null, newContent: string, path: string): string | null {
    // New file — no diff to compute, but still replace content with a summary so the full
    // file body doesn't inflate the history for every subsequent step.
    if (oldContent === null) return `[write_file: ${path} — new file, ${newContent.length} bytes written]`;
    if (oldContent === newContent) return `[write_file: ${path} — no changes]`;

    const A = oldContent.split('\n');
    const B = newContent.split('\n');

    let p = 0;
    while (p < A.length && p < B.length && A[p] === B[p]) p++;
    let s = 0;
    const maxS = Math.min(A.length - p, B.length - p);
    while (s < maxS && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;

    const Amid = A.slice(p, s > 0 ? A.length - s : A.length);
    const Bmid = B.slice(p, s > 0 ? B.length - s : B.length);
    const midOps = _lcsDiff(Amid, Bmid);

    const CTX = 3;
    const pCtx = Math.min(CTX, p);
    const sCtx = s > 0 ? Math.min(CTX, s) : 0;

    const script = []; // {type, text, oldLine, newLine}
    let oldLine = p - pCtx + 1;
    let newLine = p - pCtx + 1;

    for (let k = p - pCtx; k < p; k++)
        script.push({ type: ' ', text: A[k], oldLine: oldLine++, newLine: newLine++ });

    for (const op of midOps) {
        if (op.type === ' ')       script.push({ ...op, oldLine: oldLine++, newLine: newLine++ });
        else if (op.type === '-')  script.push({ ...op, oldLine: oldLine++, newLine: null });
        else                       script.push({ ...op, oldLine: null,      newLine: newLine++ });
    }

    const suffixStart = s > 0 ? A.length - s : A.length;
    for (let k = suffixStart; k < suffixStart + sCtx; k++)
        script.push({ type: ' ', text: A[k], oldLine: oldLine++, newLine: newLine++ });

    const changed = script.map((op, i) => op.type !== ' ' ? i : -1).filter(i => i >= 0);
    if (!changed.length) return `[write_file: ${path} — no changes]`;

    const ranges = [];
    let rFrom = null, rTo = null;
    for (const ci of changed) {
        const from = Math.max(0, ci - CTX);
        const to   = Math.min(script.length - 1, ci + CTX);
        if (rFrom === null) { rFrom = from; rTo = to; }
        else if (from <= rTo + 1) { rTo = to; }
        else { ranges.push([rFrom, rTo]); rFrom = from; rTo = to; }
    }
    if (rFrom !== null) ranges.push([rFrom, rTo]);

    const lines = [`--- ${path}`, `+++ ${path}`];
    for (const [from, to] of ranges) {
        const ops = script.slice(from, to + 1);
        const oldStart = ops.find(o => o.oldLine != null)?.oldLine ?? 1;
        const newStart = ops.find(o => o.newLine != null)?.newLine ?? 1;
        const oldCount = ops.filter(o => o.type !== '+').length;
        const newCount = ops.filter(o => o.type !== '-').length;
        lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
        for (const op of ops) lines.push(`${op.type}${op.text}`);
    }

    const diff = lines.join('\n');
    // Use diff only when it's strictly shorter than the full new content
    return diff.length < newContent.length ? diff : null;
}
