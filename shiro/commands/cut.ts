import type { Command } from './index';
import { readOperands, toLines, fromLines } from './flags';

// GNU cut: -f fields (-d delimiter, -s only delimited lines, --output-delimiter), -c characters,
// -b bytes, --complement. Selected parts come out in input order, each once; a line with no
// delimiter is printed whole (unless -s).
function parseList(spec: string): (n: number) => boolean {
  const ranges = spec.split(',').map(part => {
    const m = /^(\d*)(-?)(\d*)$/.exec(part);
    if (!m || (!m[1] && !m[3])) throw new Error(`invalid field range '${part}'`);
    const a = m[1] ? parseInt(m[1], 10) : 1;
    const b = m[2] ? (m[3] ? parseInt(m[3], 10) : Infinity) : a;
    if (a === 0) throw new Error('fields and positions are numbered from 1');
    return [a, b] as const;
  });
  return n => ranges.some(([a, b]) => n >= a && n <= b);
}

export const cut: Command = {
  name: "cut",
  description: "Remove sections from each line of files",
  async exec(ctx) {
    let mode: 'f' | 'c' | 'b' | null = null, list = '', delim = '\t', outDelim: string | null = null;
    let onlyDelimited = false, complement = false, zero = false;
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const val = (flagLen: number) => a.length > flagLen ? a.slice(flagLen) : args[++i];
      if (a === '--complement') complement = true;
      else if (a === '-s' || a === '--only-delimited') onlyDelimited = true;
      else if (a === '-z' || a === '--zero-terminated') zero = true;
      else if (a.startsWith('--output-delimiter=')) outDelim = a.slice(19);
      else if (a.startsWith('--delimiter=')) delim = a.slice(12);
      else if (a.startsWith('--fields=')) { mode = 'f'; list = a.slice(9); }
      else if (a.startsWith('--characters=')) { mode = 'c'; list = a.slice(13); }
      else if (a.startsWith('--bytes=')) { mode = 'b'; list = a.slice(8); }
      else if (a.startsWith('-d')) delim = val(2);
      else if (a.startsWith('-f')) { mode = 'f'; list = val(2); }
      else if (a.startsWith('-c')) { mode = 'c'; list = val(2); }
      else if (a.startsWith('-b')) { mode = 'b'; list = val(2); }
      else if (a === '-n') { /* ignored, as in GNU */ }
      else files.push(a);
    }
    if (!mode) { ctx.stderr += 'cut: you must specify a list of bytes, characters, or fields\n'; return 1; }
    if (delim.length !== 1) { ctx.stderr += 'cut: the delimiter must be a single character\n'; return 1; }
    let pick: (n: number) => boolean;
    try { pick = parseList(list); } catch (e: any) { ctx.stderr += `cut: ${e.message}\n`; return 1; }
    const want = (n: number) => pick(n) !== complement;
    const sep = zero ? '\0' : '\n';
    const inputs = await readOperands(ctx, 'cut', files);
    for (const { text } of inputs) {
      const { lines, lastNl } = toLines(text, sep);
      const out: string[] = [];
      for (const line of lines) {
        if (mode === 'f') {
          if (!line.includes(delim)) { if (!onlyDelimited) out.push(line); continue; }
          out.push(line.split(delim).filter((_, k) => want(k + 1)).join(outDelim ?? delim));
        } else {
          const units = mode === 'c' ? [...line] : [...new TextEncoder().encode(line)].map(b => String.fromCharCode(b));
          const picked = units.filter((_, k) => want(k + 1)).join('');
          out.push(mode === 'b' ? new TextDecoder().decode(Uint8Array.from(picked, c => c.charCodeAt(0))) : picked);
        }
      }
      ctx.stdout += fromLines(out, lastNl || out.length > 0, sep);
    }
    return inputs.failed ? 1 : 0;
  },
};
