import type { Command } from './index';
import { readFileText } from './flags';

/**
 * tsort — topological sort (GNU algorithm: items that nothing precedes go first, in sorted order;
 * the successors of each output item are visited newest-first; a loop is reported on stderr, one
 * edge of it is dropped and sorting goes on, with exit status 1).
 */
interface Item { name: string; count: number; succ: Item[]; done: boolean }

export const tsort: Command = {
  name: "tsort",
  description: "Perform topological sort",
  async exec(ctx) {
    const files = ctx.args.filter(a => a !== '--');
    if (files.length > 1) { ctx.stderr += `tsort: extra operand '${files[1]}'\n`; return 1; }
    const label = files[0] ?? '-';
    let content: string;
    try {
      content = label === '-' ? ctx.stdin : await readFileText(ctx.fs, ctx.fs.resolvePath(label, ctx.cwd));
    } catch {
      ctx.stderr += `tsort: ${label}: No such file or directory\n`;
      return 1;
    }
    const tokens = content.split(/\s+/).filter(Boolean);
    if (tokens.length % 2 !== 0) { ctx.stderr += `tsort: ${label}: input contains an odd number of tokens\n`; return 1; }

    const items = new Map<string, Item>();
    const get = (name: string) => { let it = items.get(name); if (!it) items.set(name, it = { name, count: 0, succ: [], done: false }); return it; };
    for (let i = 0; i < tokens.length; i += 2) {
      const from = get(tokens[i]), to = get(tokens[i + 1]);
      if (from !== to) { to.count++; from.succ.unshift(to); }       // newest successor first
    }
    const sorted = [...items.values()].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    let remaining = sorted.length;
    const queue: Item[] = sorted.filter(i => i.count === 0);
    let out = '';
    let status = 0;
    while (remaining > 0) {
      while (queue.length) {
        const p = queue.shift()!;
        p.done = true;
        out += p.name + '\n';
        remaining--;
        for (const k of p.succ) if (--k.count === 0) queue.push(k);
      }
      if (remaining === 0) break;
      // everything left is on or behind a loop: find one, report it, drop one of its edges
      status = 1;
      let cycle: Item[] | null = null;
      for (const start of sorted) {
        if (start.done) continue;
        const path: Item[] = [start];
        let cur = start;
        for (;;) {
          const next = cur.succ.find(s => !s.done);
          if (!next) break;
          const at = path.indexOf(next);
          if (at >= 0) { cycle = path.slice(at); break; }
          path.push(next);
          cur = next;
        }
        if (cycle) break;
      }
      if (!cycle) cycle = [sorted.find(i => !i.done)!];
      ctx.stderr += `tsort: ${label}: input contains a loop:\n` + cycle.map(c => `tsort: ${c.name}\n`).join('');
      const first = cycle[0], last = cycle[cycle.length - 1];
      const edge = last.succ.indexOf(first);
      if (edge >= 0) last.succ.splice(edge, 1);
      if (--first.count === 0) queue.push(first);
    }
    ctx.stdout += out;
    return status;
  },
};
