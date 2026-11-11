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

describe('base64ToBytes, legacy chunks (day exploration D014)', () => {
    it('decodes each padded chunk apart, so bytes after a short chunk keep their place', () => {
        const chunk = (a: number[]) => btoa(String.fromCharCode(...a));
        const legacy = chunk([1, 2, 3, 4, 5]) + chunk([6, 7, 8, 9]) + chunk([10, 11, 12]);   // 'AQIDBAU=' 'BgcICQ==' 'CgsM'
        expect(legacy).toContain('=B');
        expect(Array.from(base64ToBytes(legacy))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    });
});

describe('base64ToBytes, ASCII whitespace (day exploration D029)', () => {
    it('wrapped lines, CRLF and a trailing newline decode as native atob does; other whitespace is still refused', () => {
        const bytes = Array.from({ length: 58 }, (_, i) => i * 3 % 256);
        const flat = btoa(String.fromCharCode(...bytes));
        for (const wrapped of [flat.replace(/(.{76})/g, '$1\n'), flat.replace(/(.{20})/g, '$1\r\n'), flat + '\n', '\t' + flat])
            expect(Array.from(base64ToBytes(wrapped))).toEqual(bytes);
        expect(Array.from(base64ToBytes('AQID\nBA==\n'))).toEqual([1, 2, 3, 4]);
        expect(() => base64ToBytes('AQID\u00a0BA==')).toThrow();
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
