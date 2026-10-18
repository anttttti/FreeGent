import { decodeTextBytes } from '../text-decode.js';

const u = (...n: number[]) => Uint8Array.from(n);
const enc = (s: string) => new TextEncoder().encode(s);

describe('decodeTextBytes (codex campaign 7, case 074)', () => {
    it('decodes UTF-8, dropping a BOM', () => {
        expect(decodeTextBytes(enc('café 漢字'))).toBe('café 漢字');
        expect(decodeTextBytes(u(0xef, 0xbb, 0xbf, 0x61))).toBe('a');
        expect(decodeTextBytes(u())).toBe('');
    });
    it('decodes UTF-16 with a BOM, which Blob.text() turned into NUL-filled garbage', () => {
        const le = u(0xff, 0xfe, 0x43, 0x00, 0x61, 0x00, 0x66, 0x00, 0xe9, 0x00, 0x09, 0x00, 0x31, 0x00);
        expect(decodeTextBytes(le)).toBe('Café\t1');
        const be = u(0xfe, 0xff, 0x00, 0x43, 0x00, 0xe9);
        expect(decodeTextBytes(be)).toBe('Cé');
    });
    it('reads legacy 8-bit text as windows-1252 instead of inserting U+FFFD', () => {
        expect(decodeTextBytes(u(0x43, 0x61, 0x66, 0xe9, 0x20, 0x80))).toBe('Café €');
    });
    it('says binary for bytes with a NUL that are not UTF-16', () => {
        expect(decodeTextBytes(u(0x41, 0x00, 0xff, 0x80))).toBeNull();
        expect(decodeTextBytes(u(0x00, 0x01, 0x02))).toBeNull();
    });
});
