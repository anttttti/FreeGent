import type { Command } from './index';

export const chown: Command = {
  name:'chown', description:'Change ownership (requires native filesystem execution)',
  route:'native-only', parityScope:'capability-only', requirements:['filesystem ownership'],
  async exec(ctx) {
    const operands = ctx.args.filter(arg => arg !== '--' && !arg.startsWith('-'));
    const files = operands.slice(1);
    if (operands.length < 2) {
      ctx.stderr += 'chown: missing operand\n';
      return 1;
    }
    for (const file of files) {
      if (!(await ctx.fs.exists(ctx.fs.resolvePath(file, ctx.cwd)))) {
        ctx.stderr += `chown: cannot access '${file}': No such file or directory\n`;
        return 1;
      }
    }
    ctx.stderr += 'chown: workspace ownership changes are unavailable in the browser; select native execution\n';
    return 1;
  },
};
