
import type { Command } from './index';
export const exit: Command = {
  name: "exit",
  description: "Exit the shell with a status code",
  async exec(ctx) {
    const args = ctx.args;
    const positional = args[0] === '--' ? args.slice(1) : args;
    let exitCode = ctx.shell.lastExitCode;
    if (positional.length) {
      if (!/^[+-]?\d+$/.test(positional[0])) {
        ctx.stderr += `bash: line ${ctx.shell.currentLine}: exit: ${positional[0]}: numeric argument required\n`;
        exitCode = 2;
      } else if (positional.length > 1) {
        ctx.stderr += `bash: line ${ctx.shell.currentLine}: exit: too many arguments\n`;
        return 1;
      } else exitCode = Number(((BigInt(positional[0]) % 256n) + 256n) % 256n);
    }
    ctx.shell.lastExitCode = exitCode;
    ctx.env['?'] = String(exitCode);

    // Fire EXIT trap if set
    if (ctx.shell.traps.has('EXIT')) {
      const exitCmd = ctx.shell.traps.get('EXIT')!;
      ctx.shell.traps.delete('EXIT'); // prevent re-entry
      let trapOutput = '';
      await ctx.shell.execute(exitCmd, (s: string) => { trapOutput += s; });
      if (trapOutput) ctx.stdout += trapOutput;
    }
    ctx.shell.requestExit(exitCode);
    return exitCode;
  },
};
