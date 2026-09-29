import type { Command } from './index';
import { readOperands } from './flags';

// GNU expand: tabs to spaces at tab stops (-t N, or a list; -i only leading tabs).
export function tabStops(spec: string | null): (col: number) => number {
  if (!spec) return col => col + 8 - (col % 8);
  const list = spec.split(/[, ]+/).filter(Boolean).map(Number);
  if (list.length === 1) return col => col + list[0] - (col % list[0]);
  return col => list.find(s => s > col) ?? col + 1;
}

export const expand: Command = {
  name: "expand",
  description: "Convert tabs to spaces",
  async exec(ctx) {
    let spec: string | null = null, initial = false;
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-t' || a === '--tabs') spec = args[++i];
      else if (a.startsWith('--tabs=')) spec = a.slice(7);
      else if (a.startsWith('-t')) spec = a.slice(2);
      else if (/^-\d+$/.test(a)) spec = a.slice(1);
      else if (a === '-i' || a === '--initial') initial = true;
      else files.push(a);
    }
    const next = tabStops(spec);
    const inputs = await readOperands(ctx, 'expand', files);
    for (const { text } of inputs) {
      let out = '', col = 0, leading = true;
      for (const c of text) {
        if (c === '\n') { out += c; col = 0; leading = true; continue; }
        if (c === '\t' && (!initial || leading)) { const to = next(col); out += ' '.repeat(to - col); col = to; continue; }
        if (c !== ' ' && c !== '\t') leading = false;
        out += c;
        col = c === '\b' ? Math.max(0, col - 1) : col + 1;
      }
      ctx.stdout += out;
    }
    return inputs.failed ? 1 : 0;
  },
};
