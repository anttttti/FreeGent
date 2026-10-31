// edit-assist.ts — FreeGent: harness-side help for replace_in_file's old_string/new_string edits (experiment edit_assist).
//
// The model edits as it always does, with exact text; nothing new is shown to it and its tool schema is the same. What the
// line-tag experiment asked the model to do (name lines by tag, notice moved lines, notice an edit already made) is done here
// from the text instead: A/B 2026-10-31, the tags arm used the tags as designed in 28% of its edit calls, pasted tagged lines
// into start_line or sent bare numbers in a third, and sent twice as many edits as control.
//
// - noteSeen / seenShare: the file lines the model has been shown (read_file, execute_code output), per chat. A close match is
//   only taken where the model has seen the text: its old_string is then its memory of those lines, not a guess.
// - assistLocate: where a missed old_string most nearly stands, and the edit applied there as a line diff, so the file's own
//   text is kept wherever old_string only misremembered it.
// - alreadyAt: new_string already standing in the file (the model re-sending an edit it made).
// - trimBoundaryDup: new_string that repeats the line just above or below what it replaces.

const _seen = new Map<string, Set<string>>();
const _SEEN_MAX = 200_000;
// Line-number prefixes of cat -n, nl, grep -n and read views: "  42\t", "42:", "file.py:42:", "42│".
const _NUM_PREFIX = /^(?:[^\s:]+:)?\s*\d+(?:\t|:|│|\|)\s?/;

/** Remember the lines of `text` as shown to the model in chat `chat`. */
export function noteSeen(chat: string, text: unknown): void {
    if (typeof text !== 'string' || !text) return;
    let s = _seen.get(chat);
    if (!s) _seen.set(chat, s = new Set());
    if (s.size > _SEEN_MAX) s.clear();
    for (const raw of text.split('\n')) {
        const t = raw.trim();
        if (!t) continue;
        s.add(t);
        const bare = raw.replace(_NUM_PREFIX, '').trim();
        if (bare && bare !== t) s.add(bare);
    }
}

/** Share of the non-blank lines of `lines` the model has been shown in chat `chat` (1 when there are none). */
export function seenShare(chat: string, lines: string[]): number {
    const s = _seen.get(chat);
    const solid = lines.map(l => l.trim()).filter(Boolean);
    if (!solid.length) return 1;
    if (!s) return 0;
    return solid.filter(l => s.has(l)).length / solid.length;
}

export function _resetSeenForTest(): void { _seen.clear(); }

const _split = (t: string): string[] => {
    const x = t.replace(/\r\n/g, '\n');
    return (x.endsWith('\n') ? x.slice(0, -1) : x).split('\n');
};
const _indent = (l: string): string => (/^[ \t]*/.exec(l) ?? [''])[0];

// Similarity of two trimmed lines, 0..1: shared characters in order (LCS) over the longer length.
function _lineSim(a: string, b: string): number {
    if (a === b) return 1;
    if (!a || !b) return 0;
    if (Math.abs(a.length - b.length) > Math.max(a.length, b.length) / 2) return 0;
    const n = b.length; let prev = new Array(n + 1).fill(0), cur = new Array(n + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= n; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
        [prev, cur] = [cur, prev];
    }
    return prev[n] / Math.max(a.length, b.length);
}

/** Pairs (i, j) aligning a[i] to b[j]: equal lines first (LCS), then each line left between two pairs to the next close one (≥ 0.6) within four lines, in order. */
function _align(a: string[], b: string[], close = true): Array<[number, number]> {
    const m = a.length, n = b.length;
    const L: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--)
        L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const eq: Array<[number, number]> = [];
    for (let i = 0, j = 0; i < m && j < n;) {
        if (a[i] === b[j]) { eq.push([i, j]); i++; j++; }
        else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
    }
    if (!close) return eq;
    const out: Array<[number, number]> = [];
    let pi = -1, pj = -1;
    for (const [i, j] of [...eq, [m, n] as [number, number]]) {
        // The unmatched runs a[pi+1..i-1] and b[pj+1..j-1]: pair them in order while they are close.
        for (let x = pi + 1, y = pj + 1; x < i && y < j; x++) {
            if (!a[x]) continue;
            for (let yy = y; yy < Math.min(j, y + 4); yy++) if (b[yy] && _lineSim(a[x], b[yy]) >= 0.6) { out.push([x, yy]); y = yy + 1; break; }
        }
        if (i < m) out.push([i, j]);
        pi = i; pj = j;
    }
    return out;
}

export type AssistHit = { s: number; e: number; out: string[]; score: number; reindent: string; misremembered: number };

/**
 * Where old_string most nearly stands in `lines`, and the edit applied there. Null unless one region clearly wins:
 * Dice ≥ 0.8 over trimmed lines (close lines count), the next-best region at least 0.15 lower, and old_string of 2–80 lines.
 * Two regions about as close (the same block twice in a file) are told apart by `range`, the start_line/end_line the model gave:
 * the one region close to old_string near that range is taken (A/B 2026-10-31, django-12497: two identical hint blocks).
 * The edit is the line diff old_string → new_string replayed on the region: lines old_string kept keep the file's text, the
 * lines it changed or removed are changed or removed, and lines of the file old_string left out stay (unless new_string inserts them).
 */
export function assistLocate(lines: string[], oldString: string, newString: string, range?: { s?: number; e?: number }): AssistHit | null {
    const old = _split(oldString);
    while (old.length && !old[old.length - 1].trim()) old.pop();
    if (old.length < 2 || old.length > 80) return null;
    const oldT = old.map(l => l.trim());
    const fileT = lines.map(l => l.replace(/\r$/, '').trim());
    const k = old.length;
    // Diff old → new (exact lines): which old lines are kept, and the new lines inserted before each old line (and at the end).
    const neu = newString === '' ? [] : _split(newString);
    const keep = new Map<number, number>();
    for (const [i, j] of _align(old, neu, false)) keep.set(i, j);
    const ins: string[][] = Array.from({ length: k + 1 }, () => []);
    {
        let j = 0;
        for (let i = 0; i <= k; i++) {
            const stop = i < k && keep.has(i) ? keep.get(i)! : (i === k ? neu.length : -1);
            if (stop < 0) continue;
            while (j < stop) ins[i].push(neu[j++]);
            j = stop + 1;
        }
    }
    // A line of the file old_string left out that new_string inserts anyway is the model's earlier edit (an old_string written
    // before it): the insertion stands for it, so it is not kept as well, and it counts as accounted for in the score
    // (A/B 2026-10-31 replay, scikit-learn-10297).
    const inserted = new Set(ins.flat().map(l => l.trim()).filter(Boolean));
    type C = { st: number; len: number; score: number; pairs: Array<[number, number]> };
    // The best region of `ft`: starts from the distinctive lines of old_string found there; each start's old_string aligned to a
    // window a few lines wider on both sides, cut to the span the alignment covers, scored by Dice over that span (close lines
    // count by their similarity, and a line of the file new_string inserts counts as accounted for).
    const search = (ft: string[]): C | null => {
        const index = new Map<string, number[]>();
        ft.forEach((t, i) => { if (t.length >= 4) (index.get(t) ?? index.set(t, []).get(t)!).push(i); });
        const starts = new Set<number>();
        oldT.forEach((t, j) => { if (t.length >= 4) for (const i of index.get(t) ?? []) if (starts.size < 100) starts.add(Math.max(0, i - j)); });
        let best: C | null = null;
        for (const st0 of starts) {
            const w0 = Math.max(0, st0 - 3), w1 = Math.min(ft.length, st0 + k + 3);
            const win = ft.slice(w0, w1);
            const p0 = _align(oldT, win);
            if (!p0.length) continue;
            const f = Math.min(...p0.map(p => p[1])), l = Math.max(...p0.map(p => p[1]));
            let sum = 0, explained = 0;
            for (const [i, j] of p0) sum += oldT[i] === win[j] ? 1 : _lineSim(oldT[i], win[j]);
            const used = new Set(p0.map(p => p[1]));
            for (let j = f; j <= l; j++) if (!used.has(j) && win[j] && inserted.has(win[j])) explained++;
            const len = l - f + 1, score = (2 * sum + explained) / (k + len);
            if (!best || score > best.score || (score === best.score && len < best.len))
                best = { st: w0 + f, len, score, pairs: p0.map(([i, j]) => [i, j - f] as [number, number]) };
        }
        return best;
    };
    let best = search(fileT);
    if (!best || best.score < 0.8) return null;
    // A rival: the best region once the winner's lines are blanked out.
    const blank = (ft: string[], c: C) => ft.map((t, i) => i >= c.st && i < c.st + c.len ? '' : t);
    const rival = search(blank(fileT, best));
    if (rival && rival.score > best.score - 0.15) {
        if (!range || (range.s == null && range.e == null)) return null;
        // The range, three lines wider each side (its numbers are often a little off), must hold one clear region.
        const lo = Math.max(0, (range.s ?? range.e!) - 1 - 3), hi = Math.min(fileT.length, (range.e ?? range.s!) + 3);
        const near = fileT.map((t, i) => i >= lo - k && i < hi + k ? t : '');
        const inR = search(near);
        const overlaps = (c: C | null) => !!c && c.st < hi && c.st + c.len > lo;
        if (!inR || inR.score < 0.8 || !overlaps(inR)) return null;
        const rival2 = search(blank(near, inR));
        if (rival2 && overlaps(rival2) && rival2.score > inR.score - 0.15) return null;
        best = inR;
    }
    const { st, len, pairs } = best!;
    const region = lines.slice(st, st + len);
    // Indentation: one constant shift between old_string's lines and the file's, on every exactly-equal pair.
    const shifts = new Set<string>();
    let reindent = '';
    for (const [i, j] of pairs) if (oldT[i] === region[j].trim() && oldT[i]) {
        const a = _indent(old[i]), b = _indent(region[j].replace(/\r$/, ''));
        shifts.add(b.startsWith(a) ? '+' + b.slice(a.length) : a.startsWith(b) ? '-' + a.slice(b.length) : '?');
    }
    if (shifts.size === 1) { const s = [...shifts][0]; if (s !== '+' && s !== '-' && s !== '?') reindent = s; }
    const fix = (l: string): string => {
        if (!reindent || !l.trim()) return l;
        if (reindent[0] === '+') return reindent.slice(1) + l;
        const cut = reindent.slice(1);
        return l.startsWith(cut) ? l.slice(cut.length) : l;
    };
    // Replay on the region. A line of the file aligned to old line i: emit what was inserted before i (and before every earlier
    // old line not yet emitted), then the file's own line if old line i was kept. A line of the file old_string left out stays.
    const byJ = new Map<number, number>();
    for (const [i, j] of pairs) byJ.set(j, i);
    const out: string[] = [];
    let next = 0;   // the next old index whose insertions are still to emit
    const crlf = (region[0] ?? '').endsWith('\r');
    const emitIns = (upTo: number) => { for (; next <= upTo; next++) for (const l of ins[next]) out.push(fix(l) + (crlf && !l.endsWith('\r') ? '\r' : '')); };
    for (let j = 0; j < region.length; j++) {
        const i = byJ.get(j);
        if (i == null) { if (!inserted.has(region[j].trim())) out.push(region[j]); continue; }
        emitIns(i);
        if (keep.has(i)) out.push(region[j]);
    }
    emitIns(k);
    const misremembered = pairs.filter(([i, j]) => oldT[i] !== region[j].trim()).length + (k - pairs.length);
    return { s: st + 1, e: st + len, out, score: best!.score, reindent, misremembered };
}

/** The first line (1-based) where new_string's lines stand in `lines`, if it is distinctive (two non-blank lines, or one of 25+ characters). */
export function alreadyAt(lines: string[], newString: string): number {
    const want = _split(newString);
    while (want.length && !want[want.length - 1].trim()) want.pop();
    const solid = want.filter(l => l.trim());
    if (!(solid.length >= 2 || (solid.length === 1 && solid[0].trim().length >= 25))) return -1;
    let at = -1;
    for (let i = 0; i + want.length <= lines.length; i++)
        if (want.every((l, k) => lines[i + k].replace(/\r$/, '') === l)) { if (at >= 0) return -1; at = i + 1; }
    return at;
}

/**
 * new_string lines s–e are to be replaced with that repeat the line just above (its first) or below (its last) the replaced
 * lines, where the replaced lines did not start or end with it: that line would appear twice. The repeat is dropped.
 */
export function trimBoundaryDup(lines: string[], s: number, e: number, newLines: string[]): { lines: string[]; note: string } {
    const norm = (l: string | undefined) => (l ?? '').replace(/\r$/, '');
    let out = newLines, note = '';
    if (out.length > 1 && s > 1) {
        const above = norm(lines[s - 2]);
        if (above.trim() && norm(out[0]) === above && norm(lines[s - 1]) !== above) { out = out.slice(1); note += ` new_string began with line ${s - 1}, which stands just above the text it replaced; it was not repeated.`; }
    }
    if (out.length > 1 && e < lines.length) {
        const below = norm(lines[e]);
        if (below.trim() && norm(out[out.length - 1]) === below && norm(lines[e - 1]) !== below) { out = out.slice(0, -1); note += ` new_string ended with line ${e + 1}, which stands just below the text it replaced; it was not repeated.`; }
    }
    return { lines: out, note };
}
