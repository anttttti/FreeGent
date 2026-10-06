// shiro/utils/bytes.ts — file and pipe data as strings, byte for byte.
//
// Data moves between commands as JS strings. Valid UTF-8 decodes to its characters (a BOM
// included). Each byte that is not part of valid UTF-8 becomes a lone surrogate U+DC80..U+DCFF
// (Python's "surrogateescape"), which valid text never contains, and encodes back to that byte.
// So binary and Latin-1 data survives cat, pipes and redirects unchanged, and byte-counting tools
// (wc -c, od, head -c, sha256sum …) see the bytes a real system would.

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

export function concatBytes(parts:Uint8Array[]): Uint8Array {
  const all = new Uint8Array(parts.reduce((n,p) => n + p.length,0));
  let offset = 0;
  for (const part of parts) {all.set(part,offset); offset += part.length;}
  return all;
}

export function sameBytes(a:Uint8Array,b:Uint8Array): boolean {
  return a.length === b.length && a.every((byte,i) => byte === b[i]);
}

/** Bytes → string: UTF-8, with each invalid byte as U+DC00+byte. */
export function bytesToText(b: Uint8Array): string {
  try { return strictUtf8.decode(b); } catch { /* not all valid UTF-8: decode piece by piece */ }
  let out = '';
  let start = 0;   // start of the current run of valid UTF-8
  const flush = (end: number) => { if (end > start) out += strictUtf8.decode(b.subarray(start, end)); };
  for (let i = 0; i < b.length;) {
    const n = utf8SeqLen(b, i);
    if (n) { i += n; continue; }
    flush(i);
    out += String.fromCharCode(0xdc00 + b[i]);
    start = ++i;
  }
  flush(b.length);
  return out;
}

/** Length of the valid UTF-8 sequence starting at b[i], or 0 when there is none. */
function utf8SeqLen(b: Uint8Array, i: number): number {
  const c = b[i];
  if (c < 0x80) return 1;
  const cont = (k: number) => i + k < b.length && (b[i + k] & 0xc0) === 0x80;
  if (c >= 0xc2 && c <= 0xdf) return cont(1) ? 2 : 0;
  if (c >= 0xe0 && c <= 0xef) {
    if (!cont(1) || !cont(2)) return 0;
    const c1 = b[i + 1];
    if (c === 0xe0 && c1 < 0xa0) return 0;   // overlong
    if (c === 0xed && c1 > 0x9f) return 0;   // UTF-16 surrogate
    return 3;
  }
  if (c >= 0xf0 && c <= 0xf4) {
    if (!cont(1) || !cont(2) || !cont(3)) return 0;
    const c1 = b[i + 1];
    if (c === 0xf0 && c1 < 0x90) return 0;   // overlong
    if (c === 0xf4 && c1 > 0x8f) return 0;   // above U+10FFFF
    return 4;
  }
  return 0;
}

// A low surrogate U+DC80..U+DCFF not preceded by a high one: an escaped byte. Matched as "a
// surrogate pair, else a lone escaped byte" rather than with a lookbehind: a lookbehind literal
// is a SyntaxError before Safari 16.4 and would stop every module that imports this one.
const ESCAPED_BYTE = /[\ud800-\udbff][\udc00-\udfff]|[\udc80-\udcff]/g;
const hasEscapedByte = (s: string): boolean => {
  ESCAPED_BYTE.lastIndex = 0;
  for (let m; (m = ESCAPED_BYTE.exec(s));) if (m[0].length === 1) return true;
  return false;
};

/** String → bytes: UTF-8, with each escaped byte (U+DC80..U+DCFF) as that byte. */
export function textToBytes(s: string): Uint8Array {
  if (!hasEscapedByte(s)) return encoder.encode(s);
  const parts: number[] = [];
  let run = '';
  const flush = () => { if (run) { for (const x of encoder.encode(run)) parts.push(x); run = ''; } };
  for (const ch of s) {   // for…of yields a lone surrogate as its own one-unit string
    const c = ch.charCodeAt(0);
    if (ch.length === 1 && c >= 0xdc80 && c <= 0xdcff) { flush(); parts.push(c - 0xdc00); }
    else run += ch;
  }
  flush();
  return Uint8Array.from(parts);
}

/** The byte b (0..255) as it appears in a data string: itself below 0x80, else escaped. */
export function byteChar(b: number): string {
  return String.fromCharCode(b < 0x80 ? b : 0xdc00 + b);
}

/**
 * Re-reads a string whose escaped bytes may form UTF-8 sequences ($'\xc3\xa9', printf '\303\251'),
 * so those become the characters they encode, as they would in a real shell.
 */
export function normalizeBytes(s: string): string {
  return hasEscapedByte(s) ? bytesToText(textToBytes(s)) : s;
}

/** Number of bytes the string stands for. */
export function byteLength(s: string): number {
  return textToBytes(s).length;
}

/** Bytes → base64 in one btoa call (chunked btoa puts '=' mid-string; atob stops there). */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** base64 → bytes, tolerating interior '=' from legacy chunked encoding (atob alone stops there). */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = b64.replace(/=/g, '');
  const raw = atob(s + '='.repeat((4 - s.length % 4) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** True when the bytes are UTF-8 text a workspace text record can hold (valid, no NULs). */
export function isTextBytes(b: Uint8Array): boolean {
  if (b.includes(0)) return false;
  try { strictUtf8.decode(b); return true; } catch { return false; }
}

/** The bytes a data string stands for, one char (U+0000..U+00FF) per byte, for byte-wise dumps. */
export function toByteString(s: string): string {
  const b = textToBytes(s);
  let out = '';
  for (let i = 0; i < b.length; i += 0x8000) out += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return out;
}

/** The inverse of toByteString: one char per byte back to a data string. */
export function fromByteString(s: string): string {
  return bytesToText(Uint8Array.from(s, c => c.charCodeAt(0) & 0xff));
}

/** A data string as UTF-8 text: each escaped byte shown as U+FFFD, as a UTF-8 decoder would. */
export function toDisplayText(s: string): string {
  return hasEscapedByte(s) ? s.replace(ESCAPED_BYTE, m => m.length === 2 ? m : '�') : s;
}
