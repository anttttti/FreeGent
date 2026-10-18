// text-decode.ts — FreeGent: the text of an uploaded file's bytes, or null when the file is binary.
// Pure (no DOM), so the workspace upload, the file reader and the tests share it.

/** UTF-8 (a BOM is dropped), UTF-16 with a BOM (Windows "Unicode" exports), and legacy 8-bit text, which is decoded
 *  as windows-1252 the way a browser reads text with no declared charset. A NUL byte outside UTF-16 means binary.
 *  `Blob.text()` decodes everything as UTF-8, so a UTF-16 file became NUL-filled garbage and a Latin-1 CSV got U+FFFD. */
export function decodeTextBytes(b: Uint8Array): string | null {
    if (!b.length) return '';
    if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
    if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
    if (b.includes(0)) return null;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { /* not UTF-8 */ }
    return new TextDecoder('windows-1252').decode(b);
}
