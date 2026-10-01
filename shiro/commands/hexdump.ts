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

export const hexdump: Command = {
  name: "hexdump",
  description: "Display file contents in hexadecimal",
  async exec(ctx) {
    let mode = 'x2', verbose = false, length = Infinity, skip = 0;
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-C' || a === '--canonical') mode = 'C';
      else if (a === '-x') mode = 'x2';
      else if (a === '-d') mode = 'd2';
      else if (a === '-o') mode = 'o2';
      else if (a === '-c') mode = 'c';
      else if (a === '-b') mode = 'b';
      else if (a === '-v') verbose = true;
      else if (a === '-n') length = parseInt(args[++i], 10);
      else if (a === '-s') skip = parseInt(args[++i], 10);
      else files.push(a);
    }
    let data: Uint8Array;
    try { data = await readBytes(ctx, files); } catch { ctx.stderr += `hexdump: ${files[0]}: No such file or directory\n`; return 1; }
    data = data.slice(skip, skip + length);
    const hex = (n: number, w: number) => n.toString(16).padStart(w, '0');
    let out = '';
    let prev = '';
    let starred = false;
    for (let off = 0; off < data.length; off += 16) {
      const row = data.slice(off, off + 16);
      const key = Array.from(row).join(',');
      if (!verbose && key === prev && row.length === 16) { if (!starred) out += '*\n'; starred = true; continue; }
      prev = key; starred = false;
      if (mode === 'C') {
        let line = hex(off, 8) + '  ';
        for (let k = 0; k < 16; k++) {
          line += k < row.length ? hex(row[k], 2) + ' ' : '   ';
          if (k === 7) line += ' ';
        }
        line += ' |' + Array.from(row).map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('') + '|';
        out += line + '\n';
      } else if (mode === 'c' || mode === 'b') {
        let line = hex(off, 7);
        for (let k = 0; k < 16; k++) {
          if (k >= row.length) { line += '    '; continue; }
          const b = row[k];
          if (mode === 'b') line += ' ' + b.toString(8).padStart(3, '0');
          else line += ' ' + (({ 0: ' \\0', 7: ' \\a', 8: ' \\b', 9: ' \\t', 10: ' \\n', 11: ' \\v', 12: ' \\f', 13: ' \\r' } as Record<number, string>)[b] ?? (b >= 32 && b < 127 ? '   ' + String.fromCharCode(b) : ' ' + b.toString(8).padStart(3, '0')));
        }
        out += line + '\n';
      } else {
        let line = hex(off, 7);
        for (let k = 0; k < 16; k += 2) {
          if (k >= row.length) { line += mode === 'x2' ? '     ' : mode === 'd2' ? '      ' : '       '; continue; }
          const w = row[k] | ((row[k + 1] ?? 0) << 8);
          line += mode === 'x2' ? ' ' + hex(w, 4) : mode === 'd2' ? '  ' + String(w).padStart(5, '0') : '  ' + w.toString(8).padStart(6, '0');
        }
        out += line + '\n';
      }
    }
    if (data.length) out += (mode === 'C' ? hex(data.length, 8) : hex(data.length, 7)) + '\n';
    ctx.stdout += out;
    return 0;
  },
};
