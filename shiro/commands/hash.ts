
import type { Command } from './index';
export const hash: Command = {
  name: "hash",
  description: "Remember or report command locations",
  async exec(ctx) {
    const result = await ctx.shell.processHash(ctx.args);
    ctx.stdout += result.stdout;
    ctx.stderr += result.stderr;
    return result.exitCode;
  },
};
