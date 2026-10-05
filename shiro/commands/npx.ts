import type { Command, CommandContext } from './index';

/**
 * npx: Execute npm package binaries
 *
 * Looks for the binary in node_modules/.bin first.
 * If not found, runs `npm install <package>` then executes.
 */
export const npxCmd: Command = {
  name: 'npx',
  description: 'Execute npm package binaries',
  async exec(ctx: CommandContext): Promise<number> {
    const args = ctx.args; // args already excludes the command name

    // Filter flags we handle
    let noInstall = false;
    const passthrough: string[] = [];
    let packageArg: string | null = null;

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!packageArg && (a === '--help' || a === '-h')) {
        ctx.stdout += 'Usage: npx [options] <command> [args...]\n\n';
        ctx.stdout += 'Execute a package binary, installing if needed.\n\n';
        ctx.stdout += 'Options:\n';
        ctx.stdout += '  -y, --yes    Skip install confirmation\n';
        ctx.stdout += '  -h, --help   Show this help\n';
        return 0;
      }
      if (!packageArg && (a === '-y' || a === '--yes')) {
        continue;
      }
      if (!packageArg && (a === '--no-install' || a === '--no')) {noInstall = true; continue;}
      if (!packageArg) {
        packageArg = a;
      } else {
        passthrough.push(a);
      }
    }

    if (!packageArg) {
      ctx.stderr += 'npx: missing command\nUsage: npx [options] <command> [args...]\n';
      return 1;
    }

    // Parse package@version and scoped packages
    let binName: string;
    let installSpec: string = packageArg;
    if (packageArg.startsWith('@')) {
      // Scoped: @scope/pkg or @scope/pkg@version
      const slashIdx = packageArg.indexOf('/');
      if (slashIdx === -1) {
        ctx.stderr += `npx: invalid scoped package: ${packageArg}\n`;
        return 1;
      }
      const afterSlash = packageArg.slice(slashIdx + 1);
      const atIdx = afterSlash.indexOf('@');
      if (atIdx > 0) {
        binName = afterSlash.slice(0, atIdx);
      } else {
        binName = afterSlash;
      }
    } else {
      // Unscoped: pkg or pkg@version
      const atIdx = packageArg.indexOf('@');
      if (atIdx > 0) {
        binName = packageArg.slice(0, atIdx);
      } else {
        binName = packageArg;
      }
    }

    // Check if binary already exists in PATH
    const localBin = ctx.fs.resolvePath('node_modules/.bin/' + binName,ctx.cwd);
    const existingBin = await ctx.fs.exists(localBin) ? localBin : await ctx.shell.findExecutableInPath(binName);
    const child = ctx.shell.fork();
    child.env.PATH = ctx.fs.resolvePath('node_modules/.bin',ctx.cwd) + ':' + child.env.PATH;
    const run = async(argv:string[]) => {
      const result = await child.execArgv(argv,ctx.stdin);
      ctx.stdout += result.stdout; ctx.stderr += result.stderr; return result.exitCode;
    };
    if (existingBin) {
      // Execute directly
      return run([existingBin,...passthrough]);
    }
    if (noInstall) {ctx.stderr += `npx: local executable not found: ${binName}\n`; return 1;}

    // Install the package first
    ctx.shell.onProgress?.(`Installing ${installSpec}...`);
    const installCode = await run(['npm','install',installSpec]);
    if (installCode !== 0) {
      ctx.stderr += `npx: npm install failed with exit code ${installCode}\n`;
      return installCode;
    }

    // Now execute the binary
    return run([binName,...passthrough]);
  },
};
