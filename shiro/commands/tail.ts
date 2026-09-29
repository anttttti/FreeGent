import type { Command } from './index';
import { readOperands } from './flags';

// GNU tail: -n N / -n +N (from line N), -c N / -c +N, -q / -v, "==> name <==" headers. Output is
// the input's bytes, so a missing final newline stays missing.
export function tailText(text: string, n: number, bytes: boolean, fromStart: boolean): string {
  if (bytes) return fromStart ? text.slice(Math.max(0, n - 1)) : n === 0 ? '' : text.slice(-n);
  const starts = [0];
  for (let k = text.indexOf('\n'); k >= 0 && k < text.length - 1; k = text.indexOf('\n', k + 1)) starts.push(k + 1);
  if (text === '') return '';
  if (fromStart) return n <= 1 ? text : n - 1 < starts.length ? text.slice(starts[n - 1]) : '';
  if (n === 0) return '';
  return n >= starts.length ? text : text.slice(starts[starts.length - n]);
}

export const tail: Command = {
  name: "tail",
  description: "Output the last part of files",
  async exec(ctx) {
    let count = '10', bytes = false, quiet = false, verbose = false;
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (/^[-+]\d+$/.test(a)) { count = a.startsWith('+') ? a : a.slice(1); continue; }
      if (a === '-n' || a === '--lines') { count = args[++i]; bytes = false; continue; }
      if (a.startsWith('--lines=')) { count = a.slice(8); bytes = false; continue; }
      if (a.startsWith('-n')) { count = a.slice(2); bytes = false; continue; }
      if (a === '-c' || a === '--bytes') { count = args[++i]; bytes = true; continue; }
      if (a.startsWith('--bytes=')) { count = a.slice(8); bytes = true; continue; }
      if (a.startsWith('-c')) { count = a.slice(2); bytes = true; continue; }
      if (a === '-q' || a === '--quiet' || a === '--silent') { quiet = true; continue; }
      if (a === '-v' || a === '--verbose') { verbose = true; continue; }
      if (a === '-f' || a === '-F' || a === '--follow') continue;   // nothing to follow
      files.push(a);
    }
    const m = /^([-+]?)(\d+)$/.exec(count ?? '');
    if (!m) { ctx.stderr += `tail: invalid number of ${bytes ? 'bytes' : 'lines'}: '${count}'\n`; return 1; }
    const inputs = await readOperands(ctx, 'tail', files);
    const headers = verbose || (!quiet && files.length > 1);
    inputs.forEach((inp, k) => {
      if (headers) ctx.stdout += `${k ? '\n' : ''}==> ${inp.name === '-' ? 'standard input' : inp.name} <==\n`;
      ctx.stdout += tailText(inp.text, parseInt(m[2], 10), bytes, m[1] === '+');
    });
    return inputs.failed ? 1 : 0;
  },
};
