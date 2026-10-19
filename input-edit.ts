// input-edit.ts — cursor movement and deletion by whole characters (grapheme clusters) for the TUI's message box.
//
// JavaScript strings are UTF-16: an emoji is two code units, a flag four, a family emoji a dozen with joiners. Moving and deleting one
// unit at a time left a lone surrogate in the message that was sent to the model (TUI report cases 019 and 023: "A🙂B" with Backspace
// before B became "A\ud83dB"). Offsets here are UTF-16 offsets, always on a cluster boundary.

const segmenter = typeof Intl !== 'undefined' && (Intl as any).Segmenter ? new (Intl as any).Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** Start offsets of the clusters of `s`, and its length as the last boundary. */
function boundaries(s: string): number[] {
    if (!segmenter) {   // no Intl.Segmenter: code points, which at least never split a surrogate pair
        const out: number[] = []; let i = 0;
        for (const ch of s) { out.push(i); i += ch.length; }
        out.push(s.length); return out;
    }
    const out: number[] = [];
    for (const seg of segmenter.segment(s)) out.push(seg.index);
    out.push(s.length);
    return out;
}

/** The boundary before `i` (0 at the start). An offset inside a cluster counts from that cluster's start. */
export function prevBoundary(s: string, i: number): number {
    const b = boundaries(s);
    let prev = 0;
    for (const x of b) { if (x >= i) break; prev = x; }
    return prev;
}

/** The boundary after `i` (s.length at the end). */
export function nextBoundary(s: string, i: number): number {
    for (const x of boundaries(s)) if (x > i) return x;
    return s.length;
}

/** Backspace: remove the character before the cursor. */
export function deleteBackward(s: string, cursor: number): { text: string; cursor: number } {
    if (cursor <= 0) return { text: s, cursor: 0 };
    const from = prevBoundary(s, cursor);
    return { text: s.slice(0, from) + s.slice(cursor), cursor: from };
}

/** Delete: remove the character at the cursor. */
export function deleteForward(s: string, cursor: number): { text: string; cursor: number } {
    if (cursor >= s.length) return { text: s, cursor };
    const to = nextBoundary(s, cursor);
    return { text: s.slice(0, cursor) + s.slice(to), cursor };
}
