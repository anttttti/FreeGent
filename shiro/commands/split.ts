/**
 * split — split a file into pieces (GNU: -l -b -C -n -d -x -a --additional-suffix -e --verbose).
 * Byte-exact: sizes count bytes, not characters, and pieces are written as bytes.
 */

import type { Command } from './index';
import { textToBytes } from '../utils/bytes';
import { parseSize } from './flags';

const enc = new TextEncoder();


/** Suffix number → text: alphabetic (aa, ab …) or numeric / hex with a fixed width. */
function suffix(i: number, len: number, kind: 'alpha' | 'num' | 'hex', from: number): string | null {
  if (kind === 'alpha') {
    let n = i, s = '';
    for (let k = 0; k < len; k++) { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); }
    return n > 0 ? null : s;
  }
  const radix = kind === 'num' ? 10 : 16;
  const s = (i + from).toString(radix);
  return s.length > len ? null : s.padStart(len, '0');
}

export const splitCmd: Command = {
  name: 'split',
  description: 'Split a file into pieces',
  async exec(ctx) {
    const a = ctx.args;
    let lines = 0, bytes = 0, lineBytes = 0;
    let chunks: { mode: 'n' | 'l' | 'k' | 'lk'; n: number; k?: number } | null = null;
    let kind: 'alpha' | 'num' | 'hex' = 'alpha';
    let from = 0, len = 2, lenGiven = false;
    let extra = '', elide = false, verbose = false;
    const operands: string[] = [];
    const bad = (m: string) => { ctx.stderr += `split: ${m}\n`; return 1; };
    const val = (i: number, x: string, long: string, short: string): [string | undefined, number] => {
      if (x === short || x === long) return [a[i + 1], i + 1];
      if (x.startsWith(long + '=')) return [x.slice(long.length + 1), i];
      if (short && x.startsWith(short) && x.length > short.length && !x.startsWith('--')) return [x.slice(short.length), i];
      return [undefined, i];
    };
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x === '--') { operands.push(...a.slice(i + 1)); break; }
      let v: string | undefined;
      if (/^-\d+$/.test(x)) lines = parseInt(x.slice(1), 10);
      else if (x === '-d' || x === '--numeric-suffixes') kind = 'num';
      else if (x.startsWith('--numeric-suffixes=')) { kind = 'num'; from = parseInt(x.slice(19), 10) || 0; }
      else if (x === '-x' || x === '--hex-suffixes') kind = 'hex';
      else if (x.startsWith('--hex-suffixes=')) { kind = 'hex'; from = parseInt(x.slice(15), 16) || 0; }
      else if (x === '-e' || x === '--elide-empty-files') elide = true;
      else if (x === '--verbose') verbose = true;
      else if (x === '-t' || x === '-u' || x === '--unbuffered') { /* accepted */ }
      else if (([v, i] = val(i, x, '--lines', '-l'))[0] !== undefined) { const n = parseInt(v!, 10); if (!(n > 0)) return bad(`invalid number of lines: '${v}'`); lines = n; }
      else if (([v, i] = val(i, x, '--bytes', '-b'))[0] !== undefined) { const n = parseSize(v!); if (!n) return bad(`invalid number of bytes: '${v}'`); bytes = n; }
      else if (([v, i] = val(i, x, '--line-bytes', '-C'))[0] !== undefined) { const n = parseSize(v!); if (!n) return bad(`invalid number of bytes: '${v}'`); lineBytes = n; }
      else if (([v, i] = val(i, x, '--number', '-n'))[0] !== undefined) {
        const m = /^(?:(l)\/)?(?:(\d+)\/)?(\d+)$/.exec(v!) ?? /^r\/(?:\d+\/)?\d+$/.exec(v!);
        if (!m || v!.startsWith('r/')) return bad(`invalid number of chunks: '${v}'`);
        const n = parseInt(m[3], 10), k = m[2] ? parseInt(m[2], 10) : undefined;
        if (!(n > 0)) return bad(`invalid number of chunks: '${m[3]}'`);
        if (k !== undefined && (k < 1 || k > n)) return bad(`invalid chunk number: '${m[2]}'`);
        chunks = { mode: m[1] ? (k ? 'lk' : 'l') : (k ? 'k' : 'n'), n, k };
      }
      else if (([v, i] = val(i, x, '--suffix-length', '-a'))[0] !== undefined) { const n = parseInt(v!, 10); if (!(n >= 0)) return bad(`invalid suffix length: '${v}'`); len = n; lenGiven = true; }
      else if (([v, i] = val(i, x, '--additional-suffix', ''))[0] !== undefined) extra = v!;
      else if (x.startsWith('-') && x.length > 1) return bad(`invalid option -- '${x.replace(/^-+/, '')}'`);
      else operands.push(x);
    }
    if (+!!lines + +!!bytes + +!!lineBytes + +!!chunks > 1) return bad('cannot split in more than one way');
    if (operands.length > 2) return bad(`extra operand '${operands[2]}'`);
    const input = operands[0] && operands[0] !== '-' ? operands[0] : '';
    const prefix = operands[1] ?? 'x';

    let data: Uint8Array;
    if (input) {
      try {
        const raw = await ctx.fs.readFile(ctx.fs.resolvePath(input, ctx.cwd));
        data = typeof raw === 'string' ? textToBytes(raw) : raw;
      } catch { return bad(`cannot open '${input}' for reading: No such file or directory`); }
    } else data = textToBytes(ctx.stdin);

    const NL = 10;
    const pieces: Uint8Array[] = [];
    const total = data.length;
    if (chunks && (chunks.mode === 'n' || chunks.mode === 'k')) {
      for (let i = 0; i < chunks.n; i++) pieces.push(data.subarray(Math.floor(total * i / chunks!.n), Math.floor(total * (i + 1) / chunks!.n)));
    } else if (chunks) {                                   // l/N: whole lines, about equal sizes
      let start = 0;
      for (let i = 1; i <= chunks.n; i++) {
        let end = i === chunks.n ? total : Math.floor(total * i / chunks.n);
        if (i < chunks.n) { while (end < total && end > 0 && data[end - 1] !== NL) end++; }
        end = Math.max(end, start);
        pieces.push(data.subarray(start, end));
        start = end;
      }
    } else if (bytes) {
      for (let i = 0; i < total; i += bytes) pieces.push(data.subarray(i, i + bytes));
    } else if (lineBytes) {                                // as many whole lines as fit
      let start = 0;
      while (start < total) {
        let end = Math.min(start + lineBytes, total);
        if (end < total && data[end - 1] !== NL) {
          let nl = end - 1;
          while (nl > start && data[nl] !== NL) nl--;
          if (data[nl] === NL && nl >= start) end = nl + 1;
        }
        pieces.push(data.subarray(start, end));
        start = end;
      }
    } else {
      const per = lines || 1000;
      let start = 0, count = 0;
      for (let i = 0; i < total; i++) {
        if (data[i] === NL && ++count === per) { pieces.push(data.subarray(start, i + 1)); start = i + 1; count = 0; }
      }
      if (start < total) pieces.push(data.subarray(start));
    }

    if (chunks?.mode === 'k' || chunks?.mode === 'lk') {   // K/N: only chunk K, to stdout
      let k = chunks.k! - 1;
      if (chunks.mode === 'lk') { k = Math.min(k, pieces.length - 1); }
      const p = pieces[k];
      if (p?.length) { const { bytesToText } = await import('../utils/bytes'); ctx.stdout += bytesToText(p); }
      return 0;
    }

    let outputs = pieces.map((p, i) => ({ p, i }));
    if (elide) outputs = outputs.filter(o => o.p.length > 0);
    if (!lenGiven && chunks && kind === 'alpha') {
      // enough letters for N chunks (GNU grows the default suffix length for -n)
      while (suffix(Math.max(0, pieces.length - 1), len, 'alpha', 0) === null) len++;
    }
    let idx = 0;
    for (const { p } of outputs) {
      const sfx = suffix(idx++, len, kind, from);
      if (sfx === null) return bad('output file suffixes exhausted');
      const name = prefix + sfx + extra;
      if (name.includes('/') && !prefix.includes('/')) return bad(`${name}: invalid suffix`);
      await ctx.fs.writeFile(ctx.fs.resolvePath(name, ctx.cwd), p);
      if (verbose) ctx.stdout += `creating file '${name}'\n`;
    }
    return 0;
  },
};
