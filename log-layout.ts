// log-layout.ts — which part of the conversation fits the screen. Pure functions, so they can be tested without a terminal.
//
// The event log used to treat terminal height as a number of items. An item can be dozens of rows (a long final answer), so the newest
// content was clipped away below it and no scrolling could bring it back (TUI report case 065): a sixty-line answer hid itself and every
// later reply.

/** Width of a character in terminal cells: wide CJK and emoji take two, combining marks none. */
export function cellWidth(ch: string): number {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x200d || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
    if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
        || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
        || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
    return 1;
}

/** `text` broken into terminal rows of at most `width` cells (hard line breaks kept; long lines cut at the width). */
export function wrapRows(text: string, width: number): string[] {
    const w = Math.max(1, width);
    const rows: string[] = [];
    for (const line of text.split('\n')) {
        let cur = '', used = 0;
        for (const ch of line) {
            const cw = cellWidth(ch);
            if (used + cw > w) { rows.push(cur); cur = ''; used = 0; }
            cur += ch; used += cw;
        }
        rows.push(cur);
    }
    return rows;
}

/** The rows [start, end) of a list of `count` that fit `visible` lines and keep row `cursor` in view, roughly centred. A list longer than its
 *  panel was squeezed by the layout (rows 1,3,5,7,10… shown, the selected one not: TUI report case 073). */
export function cursorWindow(count: number, cursor: number, visible: number): { start: number; end: number } {
    const v = Math.max(1, visible);
    if (count <= v) return { start: 0, end: count };
    const c = Math.max(0, Math.min(count - 1, cursor));
    const start = Math.max(0, Math.min(count - v, c - Math.floor(v / 2)));
    return { start, end: start + v };
}

export interface LogWindow {
    /** First and one-past-last item shown. */
    start: number; end: number;
    /** Set when the newest shown item alone is taller than the window: only this many of its last rows fit. */
    tailRows: number | null;
    /** The largest useful scroll offset (items): scrolling further only stores an offset nobody sees (case 069/070). */
    maxOffset: number;
}

/**
 * Pick the items that fit `height` rows, ending `offset` items before the newest. The newest item of the window is always included: a
 * too-tall one is shown from its tail. `heights[i]` is the number of rows item i needs.
 */
export function layoutWindow(heights: ArrayLike<number>, height: number, offset: number): LogWindow {
    const n = heights.length;
    const maxOffset = Math.max(0, n - 1);
    const off = Math.max(0, Math.min(offset, maxOffset));
    const end = n - off;
    const rows = Math.max(1, height - (off > 0 ? 1 : 0));   // the "scrolled up" line takes one
    let start = end, used = 0, tailRows: number | null = null;
    if (end > 0 && heights[end - 1] > rows) {
        // The newest item alone is taller than the window: show its end, but keep the few items before it (the user's message, the turn
        // header, the step with its Output control) in view above it, so the way into the full text stays reachable (cases 066, 067).
        // Their real heights count (an open Output pane is a dozen rows), but never more than half the window: the answer keeps the rest.
        const half = Math.floor(rows / 2);
        let reserved = 0, j = end - 1;
        while (j > 0 && end - 1 - j < 3 && reserved + heights[j - 1] <= half) { reserved += heights[j - 1]; j--; }
        start = j;
        tailRows = Math.max(3, rows - reserved);
        return { start, end, tailRows, maxOffset };
    }
    while (start > 0) {
        const h = heights[start - 1];
        if (used + h > rows) break;
        used += h; start--;
    }
    return { start, end, tailRows, maxOffset };
}

/**
 * Heights worked out only for the items asked about, once each. layoutWindow reads the few items at the end of the log, but the log used to
 * measure every item of the conversation (wrapping each answer) on every redraw, so the cost of a redraw grew with the length of the chat.
 */
export function lazyHeights(length: number, heightOf: (i: number) => number): ArrayLike<number> {
    const memo = new Map<number, number>();
    return new Proxy({ length } as ArrayLike<number>, {
        get(target, key) {
            if (typeof key === 'string' && /^\d+$/.test(key)) {
                const i = Number(key);
                let h = memo.get(i);
                if (h === undefined) { h = heightOf(i); memo.set(i, h); }
                return h;
            }
            return (target as any)[key];
        },
    });
}
