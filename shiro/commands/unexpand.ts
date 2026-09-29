import type { Command } from './index';
import { readOperands } from './flags';
import { tabStops } from './expand';

// GNU unexpand: a run of blanks that reaches a tab stop becomes a tab when it spans two or more
// columns or contains a tab. Only leading blanks unless -a (-t implies -a).
export const unexpand: Command = {
  name: "unexpand",
  description: "Convert spaces to tabs",
  async exec(ctx) {
    let spec: string | null = null, all = false;
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-a' || a === '--all') all = true;
      else if (a === '--first-only') all = false;
      else if (a === '-t' || a === '--tabs') { spec = args[++i]; all = true; }
      else if (a.startsWith('--tabs=')) { spec = a.slice(7); all = true; }
      else if (a.startsWith('-t')) { spec = a.slice(2); all = true; }
      else files.push(a);
    }
    const next = tabStops(spec);
    const inputs = await readOperands(ctx, 'unexpand', files);
    for (const { text } of inputs) {
      ctx.stdout += text.split('\n').map(line => {
        let out = '', col = 0, pending = '', pendingHasTab = false, leading = true;
        for (const c of line) {
          if ((c === ' ' || c === '\t') && (all || leading)) {
            const stop = next(col);
            pending += c;
            if (c === '\t') pendingHasTab = true;
            col = c === '\t' ? stop : col + 1;
            if (col === stop) {
              out += pending.length > 1 || pendingHasTab ? '\t' : pending;
              pending = ''; pendingHasTab = false;
            }
            continue;
          }
          out += pending; pending = ''; pendingHasTab = false;
          leading = false;
          out += c;
          col++;
        }
        return out + pending;
      }).join('\n');
    }
    return inputs.failed ? 1 : 0;
  },
};
