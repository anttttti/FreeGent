/**
 * od — dump bytes in octal, hex, decimal, character or floating point form (GNU od).
 * Several -t types per run, -A radix, -j/-N/-w, -v (otherwise repeated lines collapse to `*`),
 * --endian, and the traditional -b -c -d -f -h -i -l -o -s -x -a shorthands.
 */
import type { Command } from './index';
import { textToBytes } from '../utils/bytes';
import { fmtG } from '../utils/format';

interface Format { kind: 'a' | 'c' | 'o' | 'x' | 'd' | 'u' | 'f'; size: number }

const NAMES = ['nul', 'soh', 'stx', 'etx', 'eot', 'enq', 'ack', 'bel', 'bs', 'ht', 'nl', 'vt', 'ff', 'cr', 'so', 'si',
  'dle', 'dc1', 'dc2', 'dc3', 'dc4', 'nak', 'syn', 'etb', 'can', 'em', 'sub', 'esc', 'fs', 'gs', 'rs', 'us', 'sp'];
const CHAR_ESC: Record<number, string> = { 0: '\\0', 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r' };

const WIDTH = {
  o: { 1: 3, 2: 6, 4: 11, 8: 22 }, x: { 1: 2, 2: 4, 4: 8, 8: 16 },
  d: { 1: 4, 2: 6, 4: 11, 8: 20 }, u: { 1: 3, 2: 5, 4: 10, 8: 20 },
} as Record<string, Record<number, number>>;


/** Shortest %g that reads back as the same value (what coreutils prints for floats). */
function shortest(x: number, bits: 32 | 64): string {
  for (let p = 1; p <= (bits === 32 ? 9 : 17); p++) {
    const s = fmtG(x, p);
    const back = Number(s);
    if (bits === 32 ? Math.fround(back) === x : back === x) return s;
  }
  return fmtG(x, bits === 32 ? 9 : 17);
}

function parseType(spec: string): Format[] | string {
  const out: Format[] = [];
  for (let i = 0; i < spec.length;) {
    const k = spec[i++];
    if (k === 'a' || k === 'c') { out.push({ kind: k, size: 1 }); continue; }
    if (!'doxuf'.includes(k)) return `invalid type string '${spec}'`;
    let size = 0;
    const m = /^\d+/.exec(spec.slice(i));
    if (m) { size = parseInt(m[0], 10); i += m[0].length; }
    else if (k === 'f') { const c = spec[i]; if (c === 'F') { size = 4; i++; } else if (c === 'D') { size = 8; i++; } else if (c === 'L') { size = 16; i++; } else size = 8; }
    else { const c = spec[i]; if (c === 'C') { size = 1; i++; } else if (c === 'S') { size = 2; i++; } else if (c === 'I') { size = 4; i++; } else if (c === 'L') { size = 8; i++; } else size = 4; }
    if (k === 'f' ? ![4, 8].includes(size) : ![1, 2, 4, 8].includes(size)) return `invalid type size ${size} in '${spec}'`;
    out.push({ kind: k as Format['kind'], size });
    if (spec[i] === 'z') i++;
  }
  return out;
}

function parseCount(s: string): number | null {
  const m = /^(0x[0-9a-f]+|\d+)([bkKmM]?)$/i.exec(s);
  if (!m) return null;
  const n = m[1].toLowerCase().startsWith('0x') ? parseInt(m[1], 16) : parseInt(m[1], 10);
  const u = m[2];
  return u === 'b' ? n * 512 : u === 'k' || u === 'K' ? n * 1024 : u === 'm' || u === 'M' ? n * 1048576 : n;
}

export const od: Command = {
  name: "od",
  description: "Dump files in octal and other formats",
  async exec(ctx) {
    const a = ctx.args;
    let radix = 'o', skip = 0, limit = Infinity, width = 16, verbose = false, big = false;
    const formats: Format[] = [];
    const files: string[] = [];
    const fail = (m: string) => { ctx.stderr += `od: ${m}\n`; return 1; };
    const addType = (spec: string) => { const f = parseType(spec); if (typeof f === 'string') return f; formats.push(...f); return null; };
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x === '--') { files.push(...a.slice(i + 1)); break; }
      if (x.startsWith('--')) {
        const eq = x.indexOf('=');
        const name = eq > 0 ? x.slice(2, eq) : x.slice(2);
        const v = eq > 0 ? x.slice(eq + 1) : undefined;
        const need = () => v ?? a[++i];
        if (name === 'address-radix') radix = need() ?? 'o';
        else if (name === 'skip-bytes') { const n = parseCount(need() ?? ''); if (n === null) return fail(`invalid skip argument`); skip = n; }
        else if (name === 'read-bytes') { const n = parseCount(need() ?? ''); if (n === null) return fail(`invalid limit argument`); limit = n; }
        else if (name === 'format') { const e = addType(need() ?? ''); if (e) return fail(e); }
        else if (name === 'width') width = v === undefined ? 32 : parseInt(v, 10);
        else if (name === 'endian') big = need() === 'big';
        else if (name === 'output-duplicates') verbose = true;
        else if (name === 'traditional') { /* accepted */ }
        else return fail(`unrecognized option '--${name}'`);
        continue;
      }
      if (x.startsWith('-') && x.length > 1) {
        for (let k = 1; k < x.length; k++) {
          const c = x[k];
          const rest = x.slice(k + 1);
          if ('AjNt'.includes(c)) {
            const v = rest !== '' ? rest : a[++i];
            if (v === undefined) return fail(`option requires an argument -- '${c}'`);
            if (c === 'A') { if (!'doxn'.includes(v)) return fail(`invalid output address radix '${v}'; it must be one character from [doxn]`); radix = v; }
            else if (c === 'j') { const n = parseCount(v); if (n === null) return fail(`invalid skip argument '${v}'`); skip = n; }
            else if (c === 'N') { const n = parseCount(v); if (n === null) return fail(`invalid limit argument '${v}'`); limit = n; }
            else { const e = addType(v); if (e) return fail(e); }
            break;
          }
          if (c === 'w') { width = rest !== '' ? parseInt(rest, 10) : 32; break; }
          if (c === 'v') verbose = true;
          else if (c === 'b') formats.push({ kind: 'o', size: 1 });
          else if (c === 'c') formats.push({ kind: 'c', size: 1 });
          else if (c === 'a') formats.push({ kind: 'a', size: 1 });
          else if (c === 'd') formats.push({ kind: 'u', size: 2 });
          else if (c === 'f') formats.push({ kind: 'f', size: 4 });
          else if (c === 'h' || c === 'x') formats.push({ kind: 'x', size: 2 });
          else if (c === 'i') formats.push({ kind: 'd', size: 4 });
          else if (c === 'l') formats.push({ kind: 'd', size: 8 });
          else if (c === 'o') formats.push({ kind: 'o', size: 2 });
          else if (c === 's') formats.push({ kind: 'd', size: 2 });
          else return fail(`invalid option -- '${c}'`);
        }
        continue;
      }
      files.push(x);
    }
    if (formats.length === 0) formats.push({ kind: 'o', size: 2 });
    if (!(width > 0)) return fail(`invalid width`);

    // gather the bytes of all inputs
    let data: Uint8Array;
    let status = 0;
    if (files.length === 0) data = textToBytes(ctx.stdin);
    else {
      const parts: Uint8Array[] = [];
      for (const f of files) {
        if (f === '-') { parts.push(textToBytes(ctx.stdin)); continue; }
        try {
          const raw = await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd));
          parts.push(typeof raw === 'string' ? textToBytes(raw) : raw);
        } catch { ctx.stderr += `od: ${f}: No such file or directory\n`; status = 1; }
      }
      let total = 0;
      for (const p of parts) total += p.length;
      data = new Uint8Array(total);
      let o = 0;
      for (const p of parts) { data.set(p, o); o += p.length; }
    }
    data = data.subarray(Math.min(skip, data.length), limit === Infinity ? undefined : Math.min(data.length, skip + limit));

    const addrWidth = radix === 'x' ? 6 : 7;
    const addr = (n: number) => (radix === 'n' ? '' : n.toString(radix === 'o' ? 8 : radix === 'd' ? 10 : 16).padStart(addrWidth, '0'));
    const pad = ' '.repeat(radix === 'n' ? 0 : addrWidth);
    // the line width is a multiple of every unit size (GNU rounds it up to the largest)
    const unit = Math.max(...formats.map(f => f.size));
    if (width % unit !== 0) width = Math.ceil(width / unit) * unit;

    // natural width of one field of each type, then equalized so every -t row spans the same width
    const natural = (f: Format) => (f.kind === 'a' || f.kind === 'c' ? 3 : f.kind === 'f' ? (f.size === 4 ? 15 : 24) : WIDTH[f.kind][f.size]);
    const blockWidth = (f: Format) => (natural(f) + 1) * (width / f.size);
    const maxBlock = Math.max(...formats.map(blockWidth));
    const perField = (f: Format) => Math.floor(maxBlock / (width / f.size));

    const raw = (f: Format, bytes: Uint8Array): string => {
      if (f.kind === 'a') return (bytes[0] & 0x7f) === 127 ? 'del' : (bytes[0] & 0x7f) <= 32 ? NAMES[bytes[0] & 0x7f] : String.fromCharCode(bytes[0] & 0x7f);
      if (f.kind === 'c') {
        const c = bytes[0];
        return c in CHAR_ESC ? CHAR_ESC[c] : c >= 32 && c < 127 ? String.fromCharCode(c) : c.toString(8).padStart(3, '0');
      }
      // assemble the unit (missing bytes of a partial last unit are zero)
      const buf = new Uint8Array(f.size);
      buf.set(bytes);
      const dv = new DataView(buf.buffer);
      const le = !big;
      if (f.kind === 'f') return shortest(f.size === 4 ? dv.getFloat32(0, le) : dv.getFloat64(0, le), f.size === 4 ? 32 : 64);
      let v: bigint;
      if (f.size === 1) v = BigInt(f.kind === 'd' ? dv.getInt8(0) : dv.getUint8(0));
      else if (f.size === 2) v = BigInt(f.kind === 'd' ? dv.getInt16(0, le) : dv.getUint16(0, le));
      else if (f.size === 4) v = BigInt(f.kind === 'd' ? dv.getInt32(0, le) : dv.getUint32(0, le));
      else v = f.kind === 'd' ? dv.getBigInt64(0, le) : dv.getBigUint64(0, le);
      const w = WIDTH[f.kind][f.size];
      if (f.kind === 'o') return v.toString(8).padStart(w, '0');
      if (f.kind === 'x') return v.toString(16).padStart(w, '0');
      return v.toString(10);
    };
    const field = (f: Format, bytes: Uint8Array): string => ' ' + raw(f, bytes).padStart(perField(f) - 1);

    const lines: string[] = [];
    let prev: Uint8Array | null = null;
    let starred = false;
    for (let off = 0; off < data.length; off += width) {
      const chunk = data.subarray(off, off + width);
      const full = chunk.length === width;
      if (!verbose && full && prev && prev.length === width && prev.every((b, i) => b === chunk[i])) {
        if (!starred) { lines.push('*'); starred = true; }
        continue;
      }
      starred = false;
      prev = chunk;
      formats.forEach((f, fi) => {
        let text = '';
        for (let p = 0; p < chunk.length; p += f.size) text += field(f, chunk.subarray(p, p + f.size));
        lines.push((fi === 0 ? addr(skip + off) : pad) + text);
      });
    }
    if (radix !== 'n') lines.push(addr(skip + data.length));
    if (lines.length) ctx.stdout += lines.join('\n') + '\n';
    return status;
  },
};
