
import type { Command } from './index';
import { parseArgs } from './flags';
import { applySymbolicMode } from '../utils/permissions';
export const mkdir: Command = {
  name: "mkdir",
  description: "Make directories",
  async exec(ctx) {
    const args = ctx.args;
    const { flags, values, positional } = parseArgs(args,['m','mode']);
    const parents = flags.p || flags.parents;

    if (positional.length === 0) {
      ctx.stderr += "mkdir: missing operand\n";
      return 1;
    }

    const rawMode = values.m ?? values.mode;
    const mode = rawMode === undefined ? undefined : /^[0-7]{1,4}$/.test(rawMode)
      ? parseInt(rawMode,8) : applySymbolicMode(rawMode,0o777,{directory:true});
    if (mode === null) {ctx.stderr += `mkdir: invalid mode ‘${rawMode}’\n`; return 1;}

    try {
      for (const p of positional) {
        const resolved = ctx.fs.resolvePath(p, ctx.cwd);
        if (!parents && await ctx.fs.exists(resolved)) {ctx.stderr += `mkdir: cannot create directory ‘${p}’: File exists\n`; return 1;}
        await ctx.fs.mkdir(resolved, { recursive: parents });
        if (mode !== undefined) await ctx.fs.chmod(resolved,mode);
      }
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `mkdir: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
