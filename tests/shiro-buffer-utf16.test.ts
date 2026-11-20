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

// D020: a bounded write stops at a character boundary and reports the bytes it wrote (Node's own Buffer is the oracle); the encoding may stand in the second or third place.
describe('Buffer.write bounds and overloads', () => {
    const FB = createFakeBuffer();
    it('writes what Node writes, bytes and count, for every capacity and offset', () => {
        for (const s of ['AéB', '😀Z', 'abc'])
            for (const enc of [undefined, 'utf8', 'utf16le', 'latin1'] as const)
                for (let cap = 0; cap <= 6; cap++)
                    for (const off of [0, 1]) {
                        const native = Buffer.alloc(8, 0x7e), shim = FB.alloc(8, 0x7e);
                        expect(shim.write(s, off, cap, enc), `${s} ${enc} ${off} ${cap}`).toBe((native as any).write(s, off, cap, enc));
                        expect(Buffer.from(shim).equals(native), `${s} ${enc} ${off} ${cap}`).toBe(true);
                    }
    });
    it('takes the encoding in the second or third place', () => {
        for (const [s, args] of [['é', ['utf8']], ['ff00', [0, 4, 'hex']], ['abcd', [1, 'latin1']], ['é', ['utf16le']]] as const) {
            const native = Buffer.alloc(8, 0x7e), shim = FB.alloc(8, 0x7e);
            expect(shim.write(s, ...args)).toBe((native as any).write(s, ...args));
            expect(Buffer.from(shim).equals(native)).toBe(true);
        }
    });
});

// Z007: Buffer.from(typedArray) copies elements, whatever their width.
describe('Buffer.from of typed arrays', () => {
    it('copies wider elements as Node does, and 8-bit and DataView inputs as bytes', () => {
        const FB = createFakeBuffer();
        for (const arr of [new Uint16Array([1, 300, 65535]), new Int32Array([-1, 258]), new Float32Array([1.9, 300.5]), new Int8Array([-1, 5])])
            expect([...FB.from(arr)], arr.constructor.name).toEqual([...Buffer.from(arr as any)]);
        const dv = new DataView(new Uint8Array([9, 8, 7]).buffer);
        expect([...FB.from(dv)]).toEqual([9, 8, 7]);
        const view = new Uint8Array([0, 1, 2, 3]).subarray(1, 3);
        expect([...FB.from(view)]).toEqual([1, 2]);
    });
});
