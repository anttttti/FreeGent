import type { Command } from './index';
import { bytesToText, textToBytes } from '../utils/bytes';

// iconv -f FROM -t TO [-c] [-o OUT] [FILE…]: converts between UTF-8, ISO-8859-1 (Latin-1), ASCII,
// UTF-16/32 and the single-byte encodings TextDecoder knows (windows-125x, ISO-8859-x, KOI8 …).
// Encoding to anything but UTF-8, Latin-1, ASCII and UTF-16 is not supported.

const norm = (e: string) => {
  const n = e.toUpperCase().replace(/\/\/.*$/, '').replace(/_/g, '-');
  // UTF16LE, UTF-16LE, UCS-2LE … all name the same codec
  const m = /^(UTF|UCS)-?(8|16|32|2|4)(LE|BE)?$/.exec(n);
  if (!m) return n;
  const bits = m[1] === 'UCS' ? (m[2] === '2' ? '16' : '32') : m[2];
  return `UTF-${bits}${m[3] ?? ''}`;
};
const LATIN1 = new Set(['ISO-8859-1', 'ISO8859-1', 'LATIN1', 'L1', 'ISO-IR-100', 'CP819', 'IBM819']);
const UTF8 = new Set(['UTF-8', 'UTF8']);
const ASCII = new Set(['ASCII', 'US-ASCII', 'ANSI-X3.4-1968']);

function decode(bytes: Uint8Array, from: string): string {
  if (UTF8.has(from)) return bytesToText(bytes);
  if (/^UTF-16(LE|BE)?$/.test(from)) {
    let le = from !== 'UTF-16BE', off = 0;
    if (from === 'UTF-16' && bytes.length >= 2) {            // the BOM decides, little endian without one
      if (bytes[0] === 0xff && bytes[1] === 0xfe) off = 2; else if (bytes[0] === 0xfe && bytes[1] === 0xff) { le = false; off = 2; }
    }
    return new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(bytes.subarray(off));
  }
  if (/^UTF-32(LE|BE)?$/.test(from)) {
    let le = from !== 'UTF-32BE', off = 0;
    if (from === 'UTF-32' && bytes.length >= 4) {
      if (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0) off = 4;
      else if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff) { le = false; off = 4; }
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let t = '';
    for (let i = off; i + 4 <= bytes.length; i += 4) t += String.fromCodePoint(dv.getUint32(i, le));
    return t;
  }
  if (LATIN1.has(from) || ASCII.has(from)) return Array.from(bytes, b => String.fromCharCode(b)).join('');
  return new TextDecoder(from.toLowerCase()).decode(bytes);   // throws RangeError when unknown
}

type Decoded = { text: string; err?: 'illegal' | 'incomplete'; at: number };

/** Decodes with the checks iconv makes: the text before the first illegal sequence, and where that is. -c skips illegal sequences (an incomplete one at the end is still an
 *  error, as in glibc). Only UTF-8, ASCII, UTF-16 and UTF-32 are checked; the single-byte encodings come through `decode` (exploration O007: the byte carrier of bytesToText
 *  let a malformed UTF-8 byte through as a success). */
function decodeChecked(bytes: Uint8Array, from: string, discard: boolean): Decoded | null {
  const isU8 = UTF8.has(from), isAscii = ASCII.has(from), m16 = /^UTF-16(LE|BE)?$/.exec(from), m32 = /^UTF-32(LE|BE)?$/.exec(from);
  if (!isU8 && !isAscii && !m16 && !m32) return null;
  let text = '', i = 0;
  const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  if (isU8 || isAscii) {
    while (i < bytes.length) {
      const b = bytes[i];
      if (b < 0x80) { text += String.fromCharCode(b); i++; continue; }
      const len = isAscii ? 0 : b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
      if (len && i + len <= bytes.length) {
        try { text += strict.decode(bytes.subarray(i, i + len)); i += len; continue; } catch { /* illegal */ }
      } else if (len) {
        // The bytes left are the start of a character: incomplete when each is a plausible continuation, else illegal.
        let ok = true; for (let k = i + 1; k < bytes.length; k++) if ((bytes[k] & 0xc0) !== 0x80) ok = false;
        if (ok) return { text, err: 'incomplete', at: i };
      }
      if (!discard) return { text, err: 'illegal', at: i };
      i++;
    }
    return { text, at: i };
  }
  if (m16) {
    let le = from !== 'UTF-16BE';
    if (from === 'UTF-16' && bytes.length >= 2) {            // the BOM decides, little endian without one
      if (bytes[0] === 0xff && bytes[1] === 0xfe) i = 2; else if (bytes[0] === 0xfe && bytes[1] === 0xff) { le = false; i = 2; }
    }
    const unit = (k: number) => le ? bytes[k] | (bytes[k + 1] << 8) : (bytes[k] << 8) | bytes[k + 1];   // an explicit UTF-16LE/BE keeps a leading U+FEFF
    while (i < bytes.length) {
      if (i + 2 > bytes.length) return { text, err: 'incomplete', at: i };
      const u = unit(i);
      if (u >= 0xd800 && u <= 0xdbff) {
        if (i + 4 > bytes.length) return { text, err: 'incomplete', at: i };
        const u2 = unit(i + 2);
        if (u2 >= 0xdc00 && u2 <= 0xdfff) { text += String.fromCharCode(u, u2); i += 4; continue; }
      } else if (u < 0xdc00 || u > 0xdfff) { text += String.fromCharCode(u); i += 2; continue; }
      if (!discard) return { text, err: 'illegal', at: i };
      i += 2;
    }
    return { text, at: i };
  }
  let le = from !== 'UTF-32BE';
  if (from === 'UTF-32' && bytes.length >= 4) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0) i = 4;
    else if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff) { le = false; i = 4; }
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (i < bytes.length) {
    if (i + 4 > bytes.length) return { text, err: 'incomplete', at: i };
    const c = dv.getUint32(i, le);
    if (c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) { if (!discard) return { text, err: 'illegal', at: i }; i += 4; continue; }
    text += String.fromCodePoint(c); i += 4;
  }
  return { text, at: i };
}

/** The encoded bytes, or the index of the first character the target can't represent. */
function encode(text: string, to: string, discard: boolean, translit = false): Uint8Array | number {
  if (UTF8.has(to)) return textToBytes(text);
  const out: number[] = [];
  if (LATIN1.has(to) || ASCII.has(to)) {
    const max = ASCII.has(to) ? 0x7f : 0xff;
    let i = 0;
    for (const ch of text) {
      const c = ch.codePointAt(0)!;
      if (c <= max) out.push(c);
      else if (translit) {
        // é → e (drop the accent), well-known symbols by name, anything else '?', as glibc does
        const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const table: Record<string, string> = { '€': 'EUR', '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', 'ß': 'ss', 'æ': 'ae', 'Æ': 'AE', 'ø': 'o', 'Ø': 'O', '©': '(C)', '®': '(R)', '™': '(TM)' };
        const rep = table[ch] ?? (base !== ch && [...base].every(b => b.codePointAt(0)! <= max) ? base : '?');
        for (const r of rep) out.push(r.codePointAt(0)!);
      } else if (!discard) return i;
      i += ch.length;
    }
    return Uint8Array.from(out);
  }
  if (/^UTF-16(LE|BE)?$/.test(to)) {
    const le = to !== 'UTF-16BE';
    if (to === 'UTF-16') out.push(0xff, 0xfe);   // glibc writes a BOM, little-endian
    for (let i = 0; i < text.length; i++) {
      const u = text.charCodeAt(i);
      if (le) out.push(u & 0xff, u >> 8); else out.push(u >> 8, u & 0xff);
    }
    return Uint8Array.from(out);
  }
  if (/^UTF-32(LE|BE)?$/.test(to)) {
    const le = to !== 'UTF-32BE';
    if (to === 'UTF-32') out.push(0xff, 0xfe, 0, 0);
    for (const ch of text) {
      const c = ch.codePointAt(0)!;
      const b = [c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff, c >>> 24];
      out.push(...(le ? b : b.reverse()));
    }
    return Uint8Array.from(out);
  }
  throw new RangeError(to);
}

export const iconvCmd: Command = {
  name: 'iconv',
  description: 'Convert text from one character encoding to another',
  async exec(ctx) {
    let from = 'UTF-8', to = 'UTF-8', discard = false, outFile = '';
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-l' || a === '--list') { ctx.stdout += 'UTF-8\nISO-8859-1\nASCII\nUTF-16\nUTF-16LE\nUTF-16BE\nUTF-32\nUTF-32LE\nUTF-32BE\nWINDOWS-1252\n'; return 0; }
      if (a === '-f' || a === '--from-code') from = args[++i] ?? from;
      else if (a.startsWith('--from-code=')) from = a.slice(12);
      else if (a.startsWith('-f')) from = a.slice(2);
      else if (a === '-t' || a === '--to-code') to = args[++i] ?? to;
      else if (a.startsWith('--to-code=')) to = a.slice(10);
      else if (a.startsWith('-t')) to = a.slice(2);
      else if (a === '-o' || a === '--output') outFile = args[++i] ?? '';
      else if (a === '-c') discard = true;
      else if (a === '-s' || a === '--silent') { /* no warnings anyway */ }
      else files.push(a);
    }
    const toRaw = to;
    from = norm(from); to = norm(to);
    if (/\/\/IGNORE/i.test(toRaw)) discard = true;

    const inputs: Uint8Array[] = [];
    for (const f of files.length ? files : ['-']) {
      if (f === '-') { inputs.push(textToBytes(ctx.stdin)); continue; }
      try {
        const data = await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd));
        inputs.push(typeof data === 'string' ? textToBytes(data) : data);
      } catch {
        ctx.stderr += `iconv: cannot open input file \`${f}': No such file or directory\n`;
        return 1;
      }
    }
    let result: Uint8Array | number;
    try {
      let text = '', srcErr: { err: 'illegal' | 'incomplete'; at: number } | null = null, before = 0;
      for (const b of inputs) {
        const d = decodeChecked(b, from, discard);
        text += d ? d.text : decode(b, from);
        if (d?.err) { srcErr = { err: d.err, at: before + d.at }; break; }   // the conversion stops at the first bad sequence, what came before is written
        before += b.length;
      }
      result = encode(text, to, discard, /\/\/TRANSLIT/i.test(toRaw));
      if (srcErr && typeof result !== 'number') {
        ctx.stderr += srcErr.err === 'incomplete' ? 'iconv: incomplete character or shift sequence at end of buffer\n' : `iconv: illegal input sequence at position ${srcErr.at}\n`;
        await emit(result);
        return 1;
      }
      if (typeof result === 'number') {
        const prefix = text.slice(0,result);
        const sourceBytes = encode(prefix,from,false);
        if (typeof sourceBytes === 'number') throw new Error('Cannot compute source offset');
        ctx.stderr += `iconv: illegal input sequence at position ${sourceBytes.length}\n`;
        result = encode(text.slice(0, result), to, discard) as Uint8Array;
        await emit(result);
        return 1;
      }
    } catch {
      ctx.stderr += `iconv: conversion from \`${from}' to \`${to}' is not supported\n`;
      return 1;
    }
    await emit(result);
    return 0;

    async function emit(bytes: Uint8Array) {
      if (outFile) await ctx.fs.writeFile(ctx.fs.resolvePath(outFile, ctx.cwd), bytes);
      else ctx.stdout += bytesToText(bytes);
    }
  },
};
