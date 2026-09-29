import type { Command } from './index';
import { readOperands } from './flags';

// GNU head: -n N / -n -N (all but the last N), -c N / -c -N, -q / -v, "==> name <==" headers for
// several files. Output is the input's bytes, so a missing final newline stays missing.
export function headText(text: string, n: number, bytes: boolean, allBut: boolean): string {
  if (bytes) return allBut ? text.slice(0, Math.max(0, text.length - n)) : text.slice(0, n);
  if (!allBut) {
    let idx = 0;
    for (let k = 0; k < n; k++) { const nl = text.indexOf('\n', idx); if (nl < 0) return text; idx = nl + 1; }
    return text.slice(0, idx);
  }
  // All but the last n lines
  const ends: number[] = [];
  for (let k = text.indexOf('\n'); k >= 0; k = text.indexOf('\n', k + 1)) ends.push(k + 1);
  if (text && !text.endsWith('\n')) ends.push(text.length);
  const keep = ends.length - n;
  return keep <= 0 ? '' : text.slice(0, ends[keep - 1]);
}

export const head: Command = {
  name: "head",
  description: "Output the first part of files",
  async exec(ctx) {
    let count = '10', bytes = false, quiet = false, verbose = false;
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (/^-\d+$/.test(a)) { count = a.slice(1); continue; }
      if (a === '-n' || a === '--lines') { count = args[++i]; bytes = false; continue; }
      if (a.startsWith('--lines=')) { count = a.slice(8); bytes = false; continue; }
      if (a.startsWith('-n')) { count = a.slice(2); bytes = false; continue; }
      if (a === '-c' || a === '--bytes') { count = args[++i]; bytes = true; continue; }
      if (a.startsWith('--bytes=')) { count = a.slice(8); bytes = true; continue; }
      if (a.startsWith('-c')) { count = a.slice(2); bytes = true; continue; }
      if (a === '-q' || a === '--quiet' || a === '--silent') { quiet = true; continue; }
      if (a === '-v' || a === '--verbose') { verbose = true; continue; }
      files.push(a);
    }
    const allBut = count.startsWith('-');
    const m = /^[-+]?(\d+)([bkKmMgG]?)$/.exec(count ?? '');
    if (!m) { ctx.stderr += `head: invalid number of ${bytes ? 'bytes' : 'lines'}: '${count}'\n`; return 1; }
    const mult: Record<string, number> = { '': 1, b: 512, k: 1024, K: 1024, m: 1048576, M: 1048576, g: 1073741824, G: 1073741824 };
    const n = parseInt(m[1], 10) * mult[m[2]];
    const inputs = await readOperands(ctx, 'head', files);
    const headers = verbose || (!quiet && (files.length > 1));
    inputs.forEach((inp, k) => {
      if (headers) ctx.stdout += `${k ? '\n' : ''}==> ${inp.name === '-' ? 'standard input' : inp.name} <==\n`;
      ctx.stdout += headText(inp.text, n, bytes, allBut);
    });
    return inputs.failed ? 1 : 0;
  },
};
