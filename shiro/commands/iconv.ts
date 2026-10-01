import type { Command } from './index';
import { bytesToText, textToBytes } from '../utils/bytes';

// iconv -f FROM -t TO [-c] [-o OUT] [FILE…]: converts between UTF-8, ISO-8859-1 (Latin-1), ASCII,
// UTF-16/32 and the single-byte encodings TextDecoder knows (windows-125x, ISO-8859-x, KOI8 …).
// Encoding to anything but UTF-8, Latin-1, ASCII and UTF-16 is not supported.

const norm = (e: string) => e.toUpperCase().replace(/\/\/.*$/, '').replace(/_/g, '-');
const LATIN1 = new Set(['ISO-8859-1', 'ISO8859-1', 'LATIN1', 'L1', 'ISO-IR-100', 'CP819', 'IBM819']);
const UTF8 = new Set(['UTF-8', 'UTF8']);
const ASCII = new Set(['ASCII', 'US-ASCII', 'ANSI-X3.4-1968']);

function decode(bytes: Uint8Array, from: string): string {
  if (UTF8.has(from)) return bytesToText(bytes);
  if (LATIN1.has(from) || ASCII.has(from)) return Array.from(bytes, b => String.fromCharCode(b)).join('');
  return new TextDecoder(from.toLowerCase()).decode(bytes);   // throws RangeError when unknown
}

/** The encoded bytes, or the index of the first character the target can't represent. */
function encode(text: string, to: string, discard: boolean): Uint8Array | number {
  if (UTF8.has(to)) return textToBytes(text);
  const out: number[] = [];
  if (LATIN1.has(to) || ASCII.has(to)) {
    const max = ASCII.has(to) ? 0x7f : 0xff;
    let i = 0;
    for (const ch of text) {
      const c = ch.codePointAt(0)!;
      if (c <= max) out.push(c); else if (!discard) return i;
      i += ch.length;
    }
    return Uint8Array.from(out);
  }
  if (to === 'UTF-16LE' || to === 'UTF-16BE' || to === 'UTF-16') {
    const le = to !== 'UTF-16BE';
    if (to === 'UTF-16') out.push(0xff, 0xfe);   // glibc writes a BOM, little-endian
    for (let i = 0; i < text.length; i++) {
      const u = text.charCodeAt(i);
      if (le) out.push(u & 0xff, u >> 8); else out.push(u >> 8, u & 0xff);
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
      if (a === '-l' || a === '--list') { ctx.stdout += 'UTF-8\nISO-8859-1\nASCII\nUTF-16\nUTF-16LE\nUTF-16BE\nWINDOWS-1252\n'; return 0; }
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
      const text = inputs.map(b => decode(b, from)).join('');
      result = encode(text, to, discard);
      if (typeof result === 'number') {
        ctx.stderr += `iconv: cannot convert\n`;
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
