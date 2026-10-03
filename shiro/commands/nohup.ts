/**
 * nohup - run a command immune to hangups.
 *
 * There are no real processes or SIGHUP here, so the part that matters is the I/O contract:
 * when stdout is a terminal it is appended to nohup.out (with the usual notice); otherwise
 * output passes through untouched, exactly as GNU nohup does for a pipe or file.
 */
import type { Command } from './index';
import { runSubcommand } from './run-subcommand';

export const nohup: Command = {
  name: 'nohup',
  description: 'Run a command immune to hangups',
  async exec(ctx) {
    let args = ctx.args;
    if (args[0] === '--') args = args.slice(1);
    if (args[0] === '--help') { ctx.stdout += 'Usage: nohup COMMAND [ARG]...\n'; return 0; }
    if (args.length === 0) {
      ctx.stderr += "nohup: missing operand\nTry 'nohup --help' for more information.\n";
      return 125;
    }

    const toFile = !!ctx.terminal;
    let out = '', err = '';
    const code = await runSubcommand(ctx, args, s => { out += s; }, s => { err += s; })
      .catch((e: any) => { err += `nohup: ${e?.message ?? e}\n`; return 126; });

    if (toFile) {
      const path = ctx.fs.resolvePath('nohup.out', ctx.cwd);
      try {
        let existing = '';
        try { existing = await ctx.fs.readFile(path) as any; if (typeof existing !== 'string') existing = new TextDecoder().decode(existing as any); } catch { /* new file */ }
        await ctx.fs.writeFile(path, existing + out);
        ctx.stderr += "nohup: ignoring input and appending output to 'nohup.out'\n";
        out = '';
      } catch (e: any) {
        ctx.stderr += `nohup: cannot create nohup.out: ${e.message}\n`;
        return 125;
      }
    }
    ctx.stdout += out;
    ctx.stderr += err;
    return code;
  },
};
