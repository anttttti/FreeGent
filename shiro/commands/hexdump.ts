import type { Command, CommandContext } from './index';
import { bytesToText, textToBytes } from '../utils/bytes';

// hexdump (util-linux): default is 16-bit little-endian words, 8 per line; -C canonical
// ("%08x  " 8 bytes, 8 bytes, " |ascii|"); -x/-d/-o/-c variants of the word format. Repeated
// lines are shown as "*" unless -v. -n LENGTH, -s OFFSET.
async function readBytes(ctx: CommandContext, files: string[]): Promise<Uint8Array> {
  if (!files.length) return textToBytes(ctx.stdin);
  const parts: Uint8Array[] = [];
  for (const f of files) {
    const c = await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd));
    parts.push(typeof c === 'string' ? textToBytes(c) : c);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ── format strings (-e / -f): "[iterations/][bytes] "format"" units, as in bsd/util-linux hexdump ──

interface Unit { iter: number; bytes: number; pieces: Piece[]; endOnly: boolean }
type Piece = { lit: string } | { conv: string; flags: string; width: string; prec: string };

function parseFormatSpec(spec: string): Unit[] | string {
  const units: Unit[] = [];
  let i = 0;
  const skipWs = () => { while (i < spec.length && /\s/.test(spec[i])) i++; };
  for (skipWs(); i < spec.length; skipWs()) {
    let iter = 1, bytes = 0, explicitBytes = false;
    // "[iterations][/[bytes]]": a bare number is the iteration count; the byte count follows a slash
    let m = /^(\d+)?\s*\/\s*(\d+)?/.exec(spec.slice(i));
    if (m) {
      if (m[1]) iter = parseInt(m[1], 10);
      if (m[2]) { bytes = parseInt(m[2], 10); explicitBytes = true; }
      i += m[0].length;
    } else if ((m = /^(\d+)/.exec(spec.slice(i)))) { iter = parseInt(m[1], 10); i += m[0].length; }
    skipWs();
    if (spec[i] !== '"') return `bad format {${spec}}`;
    const end = spec.indexOf('"', i + 1);
    if (end < 0) return `bad format {${spec}}`;
    const body = spec.slice(i + 1, end).replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', r: '\r', '0': '\0', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"' } as Record<string, string>)[c] ?? c);
    i = end + 1;
    const pieces: Piece[] = [];
    let lit = '';
    let defBytes = 0;
    for (let k = 0; k < body.length; k++) {
      if (body[k] !== '%') { lit += body[k]; continue; }
      if (body[k + 1] === '%') { lit += '%'; k++; continue; }
      const cm = /^%([-+ #0']*)(\d*)(?:\.(\d*))?(_[aA][dox]|_[cpu]|[diouxXeEfgGcs])/.exec(body.slice(k));
      if (!cm) return `hexdump: bad conversion character %${body[k + 1] ?? ''}`;
      const conv = cm[4];
      const len = cm[0].length;
      if (lit) { pieces.push({ lit }); lit = ''; }
      pieces.push({ conv, flags: cm[1] ?? '', width: cm[2] ?? '', prec: cm[3] === undefined ? '' : '.' + cm[3] });
      if (!defBytes) defBytes = /^_[aA]/.test(conv) ? 0 : /[diouxX]/.test(conv) ? 4 : /[eEfgG]/.test(conv) ? 8 : 1;
      k += len - 1;
    }
    if (lit) pieces.push({ lit });
    if (!explicitBytes) bytes = defBytes;
    const hasEndAddr = pieces.some(p => 'conv' in p && /^_A/.test(p.conv));
    units.push({ iter, bytes, pieces, endOnly: hasEndAddr && !pieces.some(p => 'conv' in p && !/^_A/.test(p.conv)) });
  }
  return units;
}

const UNAMES = ['nul', 'soh', 'stx', 'etx', 'eot', 'enq', 'ack', 'bel', 'bs', 'ht', 'lf', 'vt', 'ff', 'cr', 'so', 'si', 'dle', 'dc1', 'dc2', 'dc3', 'dc4', 'nak', 'syn', 'etb', 'can', 'em', 'sub', 'esc', 'fs', 'gs', 'rs', 'us'];
const CESC: Record<number, string> = { 0: '\\0', 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r' };

function padField(text: string, flags: string, width: string): string {
  const w = width ? parseInt(width, 10) : 0;
  return flags.includes('-') ? text.padEnd(w) : text.padStart(w, flags.includes('0') && /^[-+]?\d/.test(text) ? '0' : ' ');
}

function runFormat(units: Unit[], data: Uint8Array, base: number, verbose: boolean): string {
  const body = units.filter(u => !u.endOnly);
  const per = body.reduce((n, u) => n + u.iter * u.bytes, 0) || 1;
  let out = '';
  let prev: Uint8Array | null = null, starred = false;
  for (let off = 0; off < data.length; off += per) {
    const block = data.subarray(off, off + per);
    if (!verbose && block.length === per && prev && prev.length === per && prev.every((b, i) => b === block[i])) {
      if (!starred) { out += '*\n'; starred = true; }
      continue;
    }
    starred = false;
    prev = block;
    let pos = off;
    for (const u of body) {
      for (let it = 0; it < u.iter; it++) {
        // past the end of the data the rest of the pass is blank, keeping later columns aligned
        const blank = pos >= data.length;
        const chunk = data.subarray(pos, pos + u.bytes);
        const emit = (t: string) => { out += blank ? ' '.repeat(t.length) : t; };
        // in a repeated unit the last iteration drops its trailing blanks ("8/1 "%02x "" ends without one)
        const lastIter = u.iter > 1 && it === u.iter - 1;
        for (let pi = 0; pi < u.pieces.length; pi++) {
          const p = u.pieces[pi];
          if ('lit' in p) { out += lastIter && pi === u.pieces.length - 1 ? p.lit.replace(/[ \t]+$/, '') : p.lit; continue; }
          const c = p.conv;
          if (c[1] === 'a' || c[1] === 'A') {        // address of this byte / of the next byte, in radix d, o or x
            const at = base + (c[1] === 'a' ? pos : pos + u.bytes);
            const radix = c[2] === 'd' ? 10 : c[2] === 'o' ? 8 : 16;
            let t = at.toString(radix);
            if (p.prec) t = t.padStart(parseInt(p.prec.slice(1), 10), '0');
            emit(padField(t, p.flags, p.width));
            continue;
          }
          const buf = new Uint8Array(Math.max(u.bytes, 1));
          buf.set(chunk);
          const dv = new DataView(buf.buffer);
          const size = u.bytes || 1;
          let text: string;
          if (c === '_c') text = chunk.length ? (chunk[0] in CESC ? CESC[chunk[0]] : chunk[0] >= 32 && chunk[0] < 127 ? String.fromCharCode(chunk[0]) : chunk[0].toString(8).padStart(3, '0')) : '';
          else if (c === '_p') text = chunk.length ? (chunk[0] >= 32 && chunk[0] < 127 ? String.fromCharCode(chunk[0]) : '.') : '';
          else if (c === '_u') text = chunk.length ? (chunk[0] < 32 ? UNAMES[chunk[0]] : chunk[0] === 127 ? 'del' : chunk[0] === 32 ? 'sp' : String.fromCharCode(chunk[0])) : '';
          else if (c === 'c') text = String.fromCharCode(buf[0]);
          else if (c === 's') text = new TextDecoder().decode(chunk).slice(0, p.prec ? parseInt(p.prec.slice(1), 10) : undefined);
          else if (/[eEfgG]/.test(c)) {
            const v = size === 4 ? dv.getFloat32(0, true) : dv.getFloat64(0, true);
            const prec = p.prec ? parseInt(p.prec.slice(1), 10) : 6;
            text = c === 'f' ? v.toFixed(prec) : c === 'e' || c === 'E' ? v.toExponential(prec).replace(/e([+-])(\d)$/, 'e$10$2') : String(+v.toPrecision(prec || 1));
            if (c === 'E' || c === 'G') text = text.toUpperCase();
          } else {
            const v = size === 1 ? dv.getUint8(0) : size === 2 ? dv.getUint16(0, true) : size === 4 ? dv.getUint32(0, true) : Number(dv.getBigUint64(0, true));
            const sv = size === 1 ? dv.getInt8(0) : size === 2 ? dv.getInt16(0, true) : size === 4 ? dv.getInt32(0, true) : Number(dv.getBigInt64(0, true));
            text = c === 'd' || c === 'i' ? String(sv) : c === 'u' ? String(v) : c === 'o' ? v.toString(8) : c === 'x' ? v.toString(16) : v.toString(16).toUpperCase();
            if (p.flags.includes('#') && (c === 'x' || c === 'X') && v) text = '0' + c + text;
            if (p.flags.includes('+') && (c === 'd' || c === 'i') && sv >= 0) text = '+' + text;
            if (p.prec) text = text.padStart(parseInt(p.prec.slice(1), 10), '0');
          }
          emit(padField(text, p.flags, p.width));
        }
        pos += u.bytes;
      }
    }
  }
  // units that only print the final address (%_A) run once, after all the data
  for (const u of units.filter(x => x.endOnly)) {
    for (const p of u.pieces) {
      if ('lit' in p) { out += p.lit; continue; }
      let t = (base + data.length).toString(p.conv[2] === 'd' ? 10 : p.conv[2] === 'o' ? 8 : 16);
      if (p.prec) t = t.padStart(parseInt(p.prec.slice(1), 10), '0');
      out += padField(t, p.flags, p.width);
    }
  }
  return out;
}

export const hexdump: Command = {
  name: "hexdump",
  description: "Display file contents in hexadecimal",
  async exec(ctx) {
    let mode = 'x2', verbose = false, length = Infinity, skip = 0;
    const specs: string[] = [];
    const files: string[] = [];
    const args = ctx.args;
    const count = (v: string | undefined) => { const m = /^(0x[0-9a-f]+|\d+)([bkm]?)$/i.exec(v ?? ''); if (!m) return null; const n = m[1].toLowerCase().startsWith('0x') ? parseInt(m[1], 16) : parseInt(m[1], 10); return m[2] === 'b' ? n * 512 : m[2] === 'k' ? n * 1024 : m[2] === 'm' ? n * 1048576 : n; };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-C' || a === '--canonical') mode = 'C';
      else if (a === '-x' || a === '--two-bytes-hex') mode = 'x2';
      else if (a === '-d' || a === '--two-bytes-decimal') mode = 'd2';
      else if (a === '-o' || a === '--two-bytes-octal') mode = 'o2';
      else if (a === '-c' || a === '--one-byte-char') mode = 'c';
      else if (a === '-b' || a === '--one-byte-octal') mode = 'b';
      else if (a === '-v' || a === '--no-squeezing') verbose = true;
      else if (a === '-n' || a === '--length') { const n = count(args[++i]); if (n === null) { ctx.stderr += `hexdump: invalid length\n`; return 1; } length = n; }
      else if (a === '-s' || a === '--skip') { const n = count(args[++i]); if (n === null) { ctx.stderr += `hexdump: invalid offset\n`; return 1; } skip = n; }
      else if (a === '-e' || a === '--format') specs.push(args[++i] ?? '');
      else if (a === '-f' || a === '--format-file') {
        try { specs.push(await ctx.fs.readFile(ctx.fs.resolvePath(args[++i], ctx.cwd), 'utf8') as string); }
        catch { ctx.stderr += `hexdump: ${args[i]}: No such file or directory\n`; return 1; }
      }
      else if (a === '-V' || a === '--version') { ctx.stdout += 'hexdump from util-linux 2.37.2\n'; return 0; }
      else if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) { ctx.stderr += `hexdump: invalid option -- '${a.replace(/^-+/, '')}'\n`; return 1; }
      else files.push(a);
    }
    let data: Uint8Array;
    let status = 0;
    try { data = await readBytes(ctx, files); } catch { ctx.stderr += `hexdump: ${files[0]}: No such file or directory\n`; return 1; }
    data = data.slice(skip, length === Infinity ? undefined : skip + length);
    if (specs.length) {
      const units = parseFormatSpec(specs.join(' '));
      if (typeof units === 'string') { ctx.stderr += units.startsWith('hexdump') ? units + '\n' : `hexdump: ${units}\n`; return 1; }
      ctx.stdout += runFormat(units, data, skip, verbose);
      return status;
    }
    const hex = (n: number, w: number) => n.toString(16).padStart(w, '0');
    let out = '';
    let prev = '';
    let starred = false;
    for (let off = 0; off < data.length; off += 16) {
      const row = data.slice(off, off + 16);
      const key = Array.from(row).join(',');
      if (!verbose && key === prev && row.length === 16) { if (!starred) out += '*\n'; starred = true; continue; }
      prev = key; starred = false;
      const at = skip + off;
      if (mode === 'C') {
        let line = hex(at, 8) + '  ';
        for (let k = 0; k < 16; k++) {
          line += k < row.length ? hex(row[k], 2) + ' ' : '   ';
          if (k === 7) line += ' ';
        }
        line += ' |' + Array.from(row).map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('') + '|';
        out += line + '\n';
      } else if (mode === 'c' || mode === 'b') {
        let line = hex(at, 7);
        for (let k = 0; k < 16; k++) {
          if (k >= row.length) { line += '    '; continue; }
          const b = row[k];
          if (mode === 'b') line += ' ' + b.toString(8).padStart(3, '0');
          else line += ' ' + (({ 0: ' \\0', 7: ' \\a', 8: ' \\b', 9: ' \\t', 10: ' \\n', 11: ' \\v', 12: ' \\f', 13: ' \\r' } as Record<number, string>)[b] ?? (b >= 32 && b < 127 ? '   ' + String.fromCharCode(b) : ' ' + b.toString(8).padStart(3, '0')));
        }
        out += line + '\n';
      } else {
        let line = hex(at, 7);
        for (let k = 0; k < 16; k += 2) {
          if (k >= row.length) { line += mode === 'x2' ? '     ' : mode === 'd2' ? '      ' : '       '; continue; }
          const w = row[k] | ((row[k + 1] ?? 0) << 8);
          line += mode === 'x2' ? ' ' + hex(w, 4) : mode === 'd2' ? '  ' + String(w).padStart(5, '0') : '  ' + w.toString(8).padStart(6, '0');
        }
        out += line + '\n';
      }
    }
    if (data.length) out += (mode === 'C' ? hex(skip + data.length, 8) : hex(skip + data.length, 7)) + '\n';
    ctx.stdout += out;
    return status;
  },
};
