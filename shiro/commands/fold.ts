import type { Command } from './index';
import { readOperands } from './flags';

// GNU fold: wrap lines at -w width (default 80) columns; -s breaks after the last blank that fits;
// -b counts bytes. Tabs advance to the next multiple of 8 and backspace steps back (column mode).
export const fold: Command = {
  name: "fold",
  description: "Wrap each input line to fit in specified width",
  async exec(ctx) {
    let width = 80, spaces = false, bytes = false;
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (/^-\d+$/.test(a)) width = parseInt(a.slice(1), 10);
      else if (a === '-w' || a === '--width') width = parseInt(args[++i], 10);
      else if (a.startsWith('--width=')) width = parseInt(a.slice(8), 10);
      else if (/^-[sb]*w\d+$/.test(a)) { width = parseInt(a.replace(/^-[sb]*w/, ''), 10); if (a.includes('s')) spaces = true; if (a.includes('b')) bytes = true; }
      else if (/^-[sbw]+$/.test(a)) { if (a.includes('s')) spaces = true; if (a.includes('b')) bytes = true; if (a.endsWith('w')) width = parseInt(args[++i], 10); }
      else if (a === '--spaces') spaces = true;
      else if (a === '--bytes') bytes = true;
      else files.push(a);
    }
    const adv = (col: number, c: string) => bytes ? col + 1 : c === '\t' ? col + 8 - (col % 8) : c === '\b' ? Math.max(0, col - 1) : c === '\r' ? 0 : col + 1;
    const inputs = await readOperands(ctx, 'fold', files);
    for (const { text } of inputs) {
      let out = '';
      let line = '';
      let col = 0;
      for (const c of text) {
        if (c === '\n') { out += line + '\n'; line = ''; col = 0; continue; }
        if (adv(col, c) > width) {
          if (spaces) {
            const k = Math.max(line.lastIndexOf(' '), line.lastIndexOf('\t'));
            if (k >= 0) {
              out += line.slice(0, k + 1) + '\n';
              line = line.slice(k + 1);
              col = 0; for (const x of line) col = adv(col, x);
            } else { out += line + '\n'; line = ''; col = 0; }
          } else { out += line + '\n'; line = ''; col = 0; }
        }
        line += c;
        col = adv(col, c);
      }
      out += line;
      ctx.stdout += out;
    }
    return inputs.failed ? 1 : 0;
  },
};
