
import type { Command } from './index';
import { cannotCreate, parseArgs, readFileText } from './flags';
export const tee: Command = {
  name: "tee",
  description: "Read from stdin and write to stdout and files",
  async exec(ctx) {
    const args = ctx.args;
    const { flags, positional } = parseArgs(args);
    const append = flags.a;
    const input = ctx.stdin;

    let failed = false;
    try {
      for (const file of positional) {
        const resolved = ctx.fs.resolvePath(file, ctx.cwd);
        // A file that can't be opened is reported; the others are still written.
        const why = await cannotCreate(ctx.fs, resolved);
        if (why) { ctx.stderr += `tee: ${file}: ${why}\n`; failed = true; continue; }
        if (append) {
          let existing = "";
          try { existing = await readFileText(ctx.fs, resolved); } catch { /* new file */ }
          await ctx.fs.writeFile(resolved, existing + input);
        } else {
          await ctx.fs.writeFile(resolved, input);
        }
      }
      ctx.stdout += input;
      return failed ? 1 : 0;
    } catch (e: unknown) {
      ctx.stdout += input;
      ctx.stderr += `tee: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
