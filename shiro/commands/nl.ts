import type { Command } from './index';
import { readOperands, toLines } from './flags';
import { breToJs } from '../utils/posix-regex';

// GNU nl: -b STYLE (a all, t non-empty [default], n none, pBRE matching), -n FORMAT (ln, rn
// [default], rz), -w WIDTH (6), -s SEP (tab), -v START, -i INCR. Unnumbered lines get
// WIDTH + length(SEP) spaces.
export const nl: Command = {
  name: "nl",
  description: "Number lines of files",
  async exec(ctx) {
    let style = 't', format = 'rn', width = 6, sep = '\t', start = 1, incr = 1;
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const m = /^-([bnwsvi])(.*)$/.exec(a) ?? /^--(body-numbering|number-format|number-width|number-separator|starting-line-number|line-increment)=(.*)$/.exec(a);
      if (m) {
        const key = { 'body-numbering': 'b', 'number-format': 'n', 'number-width': 'w', 'number-separator': 's', 'starting-line-number': 'v', 'line-increment': 'i' }[m[1]] ?? m[1];
        const v = m[2] !== '' || a.startsWith('--') ? m[2] : (args[++i] ?? '');
        if (key === 'b') style = v; else if (key === 'n') format = v; else if (key === 'w') width = parseInt(v, 10);
        else if (key === 's') sep = v; else if (key === 'v') start = parseInt(v, 10); else if (key === 'i') incr = parseInt(v, 10);
        continue;
      }
      if (/^-[hfdlp]/.test(a)) { if (a.length === 2 && 'hfdl'.includes(a[1])) i++; continue; }
      files.push(a);
    }
    const re = style.startsWith('p') ? new RegExp(breToJs(style.slice(1))) : null;
    const want = (line: string) => style === 'a' ? true : style === 'n' ? false : re ? re.test(line) : line !== '';
    let n = start;
    const inputs = await readOperands(ctx, 'nl', files);
    for (const { text } of inputs) {
      const { lines, lastNl } = toLines(text);
      lines.forEach((line, k) => {
        let out: string;
        if (want(line)) {
          const num = String(n);
          out = (format === 'ln' ? num.padEnd(width) : format === 'rz' ? num.padStart(width, '0') : num.padStart(width)) + sep + line;
          n += incr;
        } else out = ' '.repeat(width + sep.length) + line;
        ctx.stdout += out + (k < lines.length - 1 || lastNl ? '\n' : '');
      });
    }
    return inputs.failed ? 1 : 0;
  },
};
