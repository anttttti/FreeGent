import { describe, it, expect } from 'vitest';
import { prevBoundary, nextBoundary, deleteBackward, deleteForward } from '../input-edit.ts';

const lone = (s: string) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

describe('whole-character editing', () => {
    it('Backspace before B removes the whole emoji, not half of it (cases 019, 023)', () => {
        const s = 'A🙂B';
        const r = deleteBackward(s, 3);                   // cursor between 🙂 and B (🙂 is two units)
        expect(r.text).toBe('AB'); expect(r.cursor).toBe(1); expect(lone(r.text)).toBe(false);
    });
    it('Backspace at the end of an emoji', () => {
        const r = deleteBackward('A🙂', 3);
        expect(r.text).toBe('A'); expect(lone(r.text)).toBe(false);
    });
    it('joined and flag emoji, combining marks and CJK delete as one character', () => {
        expect(deleteBackward('x👨‍👩‍👧y', 'x👨‍👩‍👧'.length).text).toBe('xy');
        expect(deleteBackward('a🇳🇿', 5).text).toBe('a');
        expect(deleteBackward('café', 5).text).toBe('caf');
        expect(deleteBackward('資料', 2).text).toBe('資');
    });
    it('ASCII behaves as before, and nothing happens at the start', () => {
        expect(deleteBackward('abc', 2)).toEqual({ text: 'ac', cursor: 1 });
        expect(deleteBackward('abc', 0)).toEqual({ text: 'abc', cursor: 0 });
    });
    it('forward Delete removes the character after the cursor and keeps the cursor (case 020)', () => {
        expect(deleteForward('abc', 0)).toEqual({ text: 'bc', cursor: 0 });
        expect(deleteForward('abc', 1)).toEqual({ text: 'ac', cursor: 1 });
        expect(deleteForward('abc', 3)).toEqual({ text: 'abc', cursor: 3 });
        const r = deleteForward('A🙂B', 1);
        expect(r.text).toBe('AB'); expect(lone(r.text)).toBe(false);
    });
    it('arrow movement never lands inside a pair', () => {
        const s = 'A🙂B';
        expect(nextBoundary(s, 1)).toBe(3);
        expect(prevBoundary(s, 3)).toBe(1);
        expect(prevBoundary(s, 2)).toBe(1);               // an offset inside the pair counts from its start
        expect(nextBoundary(s, 3)).toBe(4);
        expect(nextBoundary(s, 4)).toBe(4);
        expect(prevBoundary(s, 0)).toBe(0);
    });
});
