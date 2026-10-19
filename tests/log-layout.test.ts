import { describe, it, expect } from 'vitest';
import { layoutWindow, wrapRows, cellWidth } from '../log-layout.ts';

describe('log layout', () => {
    it('picks items by rows: a tall answer does not hide what comes after it (case 065)', () => {
        // user(1) header(1) step(1) answer(60 rows+1) user(1) header(1) step(1) answer(2)
        const heights = [1, 1, 1, 61, 1, 1, 1, 3];
        const w = layoutWindow(heights, 24, 0);
        expect(w.end).toBe(8);
        expect(w.start).toBe(4);                     // the long answer is out of the window; the later exchange is all there
        expect(w.tailRows).toBeNull();
    });
    it('a newest item taller than the window is shown from its end, with the items before it kept in view', () => {
        const w = layoutWindow([1, 1, 1, 61], 24, 0);
        expect(w).toMatchObject({ start: 0, end: 4, tailRows: 21 });   // 24 rows less the three small items above
        const long = layoutWindow([1, 1, 1, 1, 61], 24, 0);
        expect(long).toMatchObject({ start: 1, end: 5, tailRows: 21 });  // only the three before it
        // an open Output pane above the answer (14 rows) counts at its real height, but at most half the window
        const pane = layoutWindow([1, 1, 15, 61], 30, 0);
        expect(pane).toMatchObject({ start: 2, end: 4, tailRows: 15 });
    });
    it('scrolling by items moves the window and the offset cannot exceed the log (cases 069, 070)', () => {
        const heights = [1, 1, 1, 1, 1, 1];
        expect(layoutWindow(heights, 3, 2)).toMatchObject({ end: 4, start: 2 });   // one row is taken by the "scrolled up" line
        const far = layoutWindow(heights, 3, 500);
        expect(far.maxOffset).toBe(5);
        expect(far.end).toBe(1);                      // clamped: the oldest item, not nothing
        expect(layoutWindow(heights, 3, 5).end).toBe(far.end);
    });
    it('wrapRows breaks by cell width, with wide characters counting twice', () => {
        expect(wrapRows('abcdef', 4)).toEqual(['abcd', 'ef']);
        expect(wrapRows('資料資料', 4)).toEqual(['資料', '資料']);
        expect(wrapRows('a\n\nb', 10)).toEqual(['a', '', 'b']);
        expect(cellWidth('🙂')).toBe(2); expect(cellWidth('a')).toBe(1); expect(cellWidth('́')).toBe(0);
    });
    it('an empty log is a window of nothing', () => {
        expect(layoutWindow([], 10, 0)).toMatchObject({ start: 0, end: 0, maxOffset: 0 });
    });
});
