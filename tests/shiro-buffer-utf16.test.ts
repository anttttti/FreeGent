import { describe, it, expect } from 'vitest';
import { createFakeBuffer } from '../shiro/node-compat/buffer';

// Day exploration D012: isEncoding said yes to utf16le/ucs2, but the bytes were UTF-8 (and read back as UTF-8, so a round trip hid it).
describe('Buffer utf16le', () => {
    const B = createFakeBuffer();
    it('is two little-endian bytes per code unit, under every spelling', () => {
        for (const enc of ['utf16le', 'utf-16le', 'ucs2', 'UCS-2']) {
            const b = B.from('aé😀', enc);
            expect([...b]).toEqual([0x61, 0, 0xe9, 0, 0x3d, 0xd8, 0x00, 0xde]);
            expect(b.toString(enc)).toBe('aé😀');
            expect(B.byteLength('aé😀', enc)).toBe(8);
        }
    });
    it('write() encodes the same way, and utf8 is unchanged', () => {
        const b = B.alloc(6); expect(b.write('ab', 0, 6, 'utf16le')).toBe(4);
        expect([...b]).toEqual([0x61, 0, 0x62, 0, 0, 0]);
        expect([...B.from('é')]).toEqual([0xc3, 0xa9]);
    });
});

// Night exploration N020: copy() walked forward over overlapping ranges, and concat() threw when the requested length was shorter than the list.
describe('Buffer copy and concat', () => {
    const B = createFakeBuffer();
    it('copy handles an overlap in either direction', () => {
        const a = B.from([1, 2, 3, 4, 5, 6]); expect(a.copy(a, 2, 0, 4)).toBe(4); expect([...a]).toEqual([1, 2, 1, 2, 3, 4]);
        const b = B.from([1, 2, 3, 4, 5, 6]); b.copy(b, 0, 2, 6); expect([...b]).toEqual([3, 4, 5, 6, 5, 6]);
        const t = B.alloc(3); expect(B.from([9, 8, 7, 6]).copy(t, 1)).toBe(2); expect([...t]).toEqual([0, 9, 8]);
    });
    it('concat cuts at the length asked for and pads beyond the list', () => {
        expect([...B.concat([B.from([1, 2]), B.from([3, 4])], 3)]).toEqual([1, 2, 3]);
        expect([...B.concat([B.from([1, 2])], 4)]).toEqual([1, 2, 0, 0]);
    });
});
