
import type { Command } from './index';
import { parseArgs } from './flags';

// GNU wc output: one line per file and a "total" line for several files. Numbers are padded to
// the digit count of the files' total size (7 for stdin with several columns, whose size isn't
// known), so `wc -l < file` prints a bare number.
export const wc: Command = {
  name: "wc",
  description: "Word, line, and byte count",
  async exec(ctx) {
    const args = ctx.args;
    const { flags, positional } = parseArgs(args);
    const showLines = flags.l;
    const showWords = flags.w;
    const showChars = flags.c || flags.m;
    const showAll = !showLines && !showWords && !showChars;

    const count = (content: string) => {
      const nums: number[] = [];
      if (showAll || showLines) nums.push(content.split("\n").length - 1);
      if (showAll || showWords) nums.push(content.split(/\s+/).filter(Boolean).length);
      if (showAll || showChars) nums.push(new TextEncoder().encode(content).length);
      return nums;
    };

    const rows: { nums: number[]; name: string | null }[] = [];
    let status = 0;
    let totalBytes = 0;
    if (positional.length === 0) {
      rows.push({ nums: count(ctx.stdin), name: null });
    } else {
      for (const p of positional) {
        try {
          const content = p === '-' ? ctx.stdin : await ctx.fs.readFile(ctx.fs.resolvePath(p, ctx.cwd), 'utf8') as string;
          rows.push({ nums: count(content), name: p });
          totalBytes += new TextEncoder().encode(content).length;
        } catch (e: unknown) {
          ctx.stderr += `wc: ${p}: ${e instanceof Error ? e.message : e}\n`;
          status = 1;
        }
      }
      if (rows.length > 1) {
        rows.push({ nums: rows[0].nums.map((_, k) => rows.reduce((s, r) => s + r.nums[k], 0)), name: 'total' });
      }
    }
    const columns = rows[0]?.nums.length ?? 0;
    const width = positional.length === 0
      ? (columns > 1 ? 7 : 1)
      : Math.max(1, String(totalBytes).length);
    for (const r of rows) {
      const cells = r.nums.map(v => String(v).padStart(width));
      ctx.stdout += cells.join(" ") + (r.name !== null ? ` ${r.name}` : "") + "\n";
    }
    return status;
  },
};
