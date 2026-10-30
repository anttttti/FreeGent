import type { Command, CommandContext } from './index';
import { satisfiesRange } from '../utils/semver-utils';

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
    let pkgName: string;
    let version = '';
    const installSpec: string = packageArg;
    if (packageArg.startsWith('@')) {
      // Scoped: @scope/pkg or @scope/pkg@version
      const slashIdx = packageArg.indexOf('/');
      if (slashIdx === -1) {
        ctx.stderr += `npx: invalid scoped package: ${packageArg}\n`;
        return 1;
      }
      const afterSlash = packageArg.slice(slashIdx + 1);
      const atIdx = afterSlash.indexOf('@');
      binName = atIdx > 0 ? afterSlash.slice(0, atIdx) : afterSlash;
      if (atIdx > 0) version = afterSlash.slice(atIdx + 1);
      pkgName = packageArg.slice(0, slashIdx + 1) + binName;
    } else {
      // Unscoped: pkg or pkg@version
      const atIdx = packageArg.indexOf('@');
      binName = atIdx > 0 ? packageArg.slice(0, atIdx) : packageArg;
      if (atIdx > 0) version = packageArg.slice(atIdx + 1);
      pkgName = binName;
    }
    // The installed package's own manifest: its version, and the command its `bin` field names (codex R277: the guessed name, the package's
    // name, is often not the command, e.g. a package "foo-cli" whose bin is "foo").
    const manifest = async (): Promise<any> => { try { return JSON.parse(await ctx.fs.readFile(ctx.fs.resolvePath(`node_modules/${pkgName}/package.json`, ctx.cwd), 'utf8') as string); } catch { return null; } };
    const binOf = (m: any): string => {
      if (!m?.bin) return binName;
      if (typeof m.bin === 'string') return binName;
      const names = Object.keys(m.bin);
      return names.includes(binName) ? binName : names.length === 1 ? names[0] : binName;
    };

    // An explicit version runs the local copy only when it is that version: a same-named command already on PATH, or another version in
    // node_modules, ran instead of the one asked for (codex R276).
    const installed = await manifest();
    const localOk = !version || (installed?.version && satisfiesRange(installed.version, version));
    const localBin = ctx.fs.resolvePath('node_modules/.bin/' + binOf(installed),ctx.cwd);
    const existingBin = !localOk ? null : await ctx.fs.exists(localBin) ? localBin : version ? null : await ctx.shell.findExecutableInPath(binName);
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

    // Now execute the binary the package declares
    return run([binOf(await manifest()),...passthrough]);
  },
};
