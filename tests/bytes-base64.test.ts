import { describe, it, expect } from 'vitest';
import { bytesToBase64, base64ToBytes } from '../shiro/utils/bytes.js';
import { encodeOutputFile, decodeOutputFile } from '../pyodide-run.js';

describe('shared base64 helpers', () => {
    it('round-trips arbitrary bytes, including > 32 KB', () => {
        const b = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 31) & 255);
        expect(Array.from(base64ToBytes(bytesToBase64(b)))).toEqual(Array.from(b));
    });
    it('decodes unpadded and over-padded input', () => {
        expect(Array.from(base64ToBytes('AQIDBA'))).toEqual([1, 2, 3, 4]);
        expect(Array.from(base64ToBytes('AQIDBA=='))).toEqual([1, 2, 3, 4]);
    });
});

describe('pyodide output encoding uses the shared text/binary rule', () => {
    it('text stays text; NUL or invalid UTF-8 becomes tagged base64; images are tagged', () => {
        expect(encodeOutputFile('a.txt', new TextEncoder().encode('héllo'))).toBe('héllo');
        expect(encodeOutputFile('a.bin', new Uint8Array([104, 0, 105])).startsWith('\x00BIN\x00')).toBe(true);
        expect(encodeOutputFile('a.bin', new Uint8Array([0xff, 0xfe])).startsWith('\x00BIN\x00')).toBe(true);
        const img = encodeOutputFile('p.png', new Uint8Array([1, 2, 3]));
        expect(decodeOutputFile(img)).toMatchObject({ encoding: 'base64', imageMime: 'image/png' });
    });
});
