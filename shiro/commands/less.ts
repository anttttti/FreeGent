
import type { Command } from './index';
import { parseArgs, filesystemError } from './flags';

export const less: Command = {
  name: "less",
  description: "View file contents with pagination",
  async exec(ctx) {
    const { positional } = parseArgs(ctx.args);

    try {
      // Native less copies bytes when stdout is not a terminal; display flags
      // do not number/reformat them, and read errors appear in that stream.
      for (const path of positional.length ? positional : ['-']) {
        if (path === '-') ctx.stdout += ctx.stdin;
        else {
          try { ctx.stdout += await ctx.fs.readFile(ctx.fs.resolvePath(path,ctx.cwd),'utf8') as string; }
          catch (error) { ctx.stdout += `${path}: ${filesystemError(error)}\n`; }
        }
      }
      return 0;
    } catch (error) {
      ctx.stderr += `less: ${error instanceof Error ? error.message : error}\n`;
      return 1;
    }
  },
};
