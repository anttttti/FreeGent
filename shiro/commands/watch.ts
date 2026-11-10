
import type { Command } from './index';

export const watch: Command = {
  name: "watch",
  description: "Execute a program periodically, showing output",
  async exec(ctx) {
    // Parse arguments manually for -n, -d, -t, -e, -g
    let interval = 2;
    let noTitle = false;
    let errexit = false;
    const cmdParts: string[] = [];
    let parsingFlags = true;

    let i = 0;
    while (i < ctx.args.length) {
      const arg = ctx.args[i];
      if (parsingFlags && (arg === '-n' || arg === '--interval') && i + 1 < ctx.args.length) {
        interval = parseFloat(ctx.args[++i]) || 2;
      } else if (parsingFlags && (arg === '-d' || arg === '--differences' || arg === '-g' || arg === '--chgexit')) {
        // accepted and ignored: a single batch run has nothing to compare
      } else if (parsingFlags && (arg === '-t' || arg === '--no-title')) {
        noTitle = true;
      } else if (parsingFlags && (arg === '-e' || arg === '--errexit')) {
        errexit = true;
      } else if (parsingFlags && arg === '--help') {
        ctx.stdout += 'Usage: watch [options] command\n\nOptions:\n  -n, --interval <secs>  Seconds between updates (default: 2)\n  -d, --differences      Highlight changes\n  -t, --no-title         Hide header\n  -e, --errexit          Exit on command error\n  -g, --chgexit          Exit when output changes\n';
        return 0;
      } else {
        parsingFlags = false;
        cmdParts.push(arg);
      }
      i++;
    }

    if (cmdParts.length === 0) {
      ctx.stderr += "watch: missing command\nTry 'watch --help' for more information.\n";
      return 1;
    }

    const command = cmdParts.join(' ');

    // Batch: run once and return
    let header = '';
    if (!noTitle) {
      const now = new Date();
      const timeStr = now.toTimeString().slice(0, 8);
      header = `Every ${interval}.0s: ${command}    ${timeStr}\n\n`;
    }
    let out = '';
    const exitCode = await ctx.shell.execute(command, (s: string) => { out += s; });
    ctx.stdout += header + out;
    if (errexit && exitCode !== 0) return exitCode;
    return 0;
  },
};
