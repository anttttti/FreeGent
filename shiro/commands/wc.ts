
import type { Command } from './index';
import { bytesToText, textToBytes } from '../utils/bytes';
import { parseArgs } from './flags';

// GNU wc output: one line per file and a "total" line for several files. Numbers are padded to
// the digit count of the files' total size (7 for stdin with several columns, whose size isn't
// known; 1 for a single number), so `wc -l < file` prints a bare number.
export const wc: Command = {
  name: "wc",
  description: "Word, line, and byte count",
  async exec(ctx) {
    const args = ctx.args;
    const { flags, positional } = parseArgs(args);
    const showLines = flags.l, showWords = flags.w, showChars = flags.m, showBytes = flags.c, showMax = flags.L;
    const showAll = !showLines && !showWords && !showChars && !showBytes && !showMax;

    // GNU column order: lines, words, characters, bytes, longest line.
    const count = (content: string) => {
      const nums: number[] = [];
      if (showAll || showLines) nums.push(content.split("\n").length - 1);
      if (showAll || showWords) nums.push(content.split(/\s+/).filter(Boolean).length);
      if (showChars) nums.push([...content].length);
      if (showAll || showBytes) nums.push(textToBytes(content).length);
      if (showMax) nums.push(Math.max(0, ...content.split("\n").map(l => { let c = 0; for (const ch of l) c = ch === '\t' ? c + 8 - (c % 8) : c + 1; return c; })));
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
          totalBytes += textToBytes(content).length;
        } catch (e: unknown) {
          ctx.stderr += `wc: ${p}: ${e instanceof Error ? e.message : e}\n`;
          status = 1;
        }
      }
      // A total for several operands, even when some (or all) could not be read, as GNU wc does.
      if (positional.length > 1) {
        const zero = count('').map(() => 0);
        const last = zero.length - 1;
        rows.push({ nums: zero.map((_, k) => showMax && k === last ? Math.max(0, ...rows.map(r => r.nums[k])) : rows.reduce((s, r) => s + r.nums[k], 0)), name: 'total' });
      }
    }
    const columns = rows[0]?.nums.length ?? 0;
    // Stdin's size isn't known beforehand: GNU pads to at least 7 then.
    const width = positional.length === 0
      ? (columns > 1 ? 7 : 1)
      : positional.length === 1 && columns === 1 ? 1
      : Math.max(positional.includes('-') ? 7 : 1, String(totalBytes).length);
    for (const r of rows) {
      const cells = r.nums.map(v => String(v).padStart(width));
      ctx.stdout += cells.join(" ") + (r.name !== null ? ` ${r.name}` : "") + "\n";
    }
    return status;
  },
};
