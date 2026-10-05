/**
 * Shiro-specific command implementations.
 *
 * These override unix.ts versions with Shiro FS-aware behavior,
 * or provide browser-specific functionality.
 */
import type { Command } from './index';
import { getAssociation } from '../file-associations';
import { sha1sum, sha256sum, sha384sum, sha512sum } from './hashsum';

export const rmCmd: Command = {
  name: 'rm',
  description: 'Remove files or directories',
  async exec(ctx) {
    let recursive = false;
    let force = false;
    const files: string[] = [];
    for (const arg of ctx.args) {
      if (arg.startsWith('-')) {
        if (arg.includes('r') || arg.includes('R')) recursive = true;
        if (arg.includes('f')) force = true;
      } else {
        files.push(arg);
      }
    }
    for (const f of files) {
      const resolved = ctx.fs.resolvePath(f, ctx.cwd);
      if (!(await ctx.fs.exists(resolved))) {
        if (force) continue;
        ctx.stderr += `rm: cannot remove '${f}': No such file or directory\n`; return 1;
      }
      try { await ctx.fs.rm(resolved, { recursive }); }
      catch (e: any) {
        if (!force) { ctx.stderr += `rm: ${e.message}\n`; return 1; }
      }
    }
    return 0;
  },
};

export const lnCmd: Command = {
  name: 'ln',
  description: 'Create links between files (requires native execution)',
  route:'native-only', parityScope:'capability-only', requirements:['filesystem links'],
  async exec(ctx) {
    let symbolic = false;
    let force = false;
    const args: string[] = [];
    for (const arg of ctx.args) {
      if (arg.startsWith('-') && arg !== '--') {
        for (const ch of arg.slice(1)) {
          if (ch === 's') symbolic = true;
          else if (ch === 'f') force = true;
        }
      } else {
        args.push(arg);
      }
    }
    if (args.length < 2) {
      ctx.stderr = 'ln: missing file operand\n';
      return 1;
    }
    // No copy can satisfy link identity or later write semantics.
    ctx.stderr = 'ln: workspace links are unavailable in the browser; select native execution\n';
    return 1;

  },
};

export const colCmd:Command = {
  name:'col', description:'Filter reverse line feeds (requires a validated native-compatible utility)',
  route:'native-only', parityScope:'capability-only', requirements:['validated terminal filter'],
  async exec(ctx) {
    ctx.stderr += 'col: validated terminal filtering is unavailable in the browser; select native execution\n';
    return 2;
  },
};

export const hostnameCmd: Command = {
  name: 'hostname',
  description: 'Show system hostname',
  async exec(ctx) {
    ctx.stdout = 'shiro\n';
    return 0;
  },
};

// Reports the userland the shell presents — Linux on x86-64, the ABI its static-binary emulator runs —
// not the host it happens to run in. Scripts branch on `uname -s` (Linux vs Darwin) and `uname -m`;
// "Shiro"/"wasm" matched none of their cases, and real bash prints Linux/x86_64 (coverage-uname-*).
export const unameCmd: Command = {
  name: 'uname',
  description: 'Print system information',
  async exec(ctx) {
    const flags = ctx.args.filter(a => a.startsWith('-') && !a.startsWith('--')).join('');
    const long = new Set(ctx.args.filter(a => a.startsWith('--')));
    const has = (short: string, name: string) => flags.includes(short) || long.has('--' + name);
    const all = has('a', 'all');
    const parts: string[] = [];
    if (all || has('s', 'kernel-name')) parts.push('Linux');
    if (all || has('n', 'nodename')) parts.push('shiro');
    if (all || has('r', 'kernel-release')) parts.push('0.1.0');
    if (all || has('v', 'kernel-version')) parts.push('Shiro/WASM');
    if (all || has('m', 'machine')) parts.push('x86_64');
    if (all || has('o', 'operating-system')) parts.push('GNU/Linux');
    ctx.stdout = (parts.length ? parts.join(' ') : 'Linux') + '\n';
    return 0;
  },
};

export const whichCmd: Command = {
  name: 'which',
  description: 'Locate a command',
  async exec(ctx) {
    if (ctx.args.length === 0) {
      ctx.stderr = 'which: missing argument\n';
      return 1;
    }
    let status = 0;
    for (const name of ctx.args) {
      const resolution = await ctx.shell.resolveCommand(name, true, true,{ignoreHash:true,pathOnly:true});
      if (resolution?.kind === 'file') ctx.stdout += `${resolution.path ?? '/usr/bin/' + name}\n`;
      else status = 1;
    }
    return status;
  },
};

export const typeCmd: Command = {
  name: 'type',
  description: 'Describe a command',
  async exec(ctx) {
    const result = await ctx.shell.processType(ctx.args);
    ctx.stdout += result.stdout;
    ctx.stderr += result.stderr;
    return result.exitCode;
  },
};

export const rmdirCmd: Command = {
  name: 'rmdir',
  description: 'Remove empty directories',
  async exec(ctx) {
    let parents = false, verbose = false, ignoreNonEmpty = false;
    const dirs: string[] = [];
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (a === '--') { dirs.push(...ctx.args.slice(i + 1)); break; }
      if (a === '-p' || a === '--parents') parents = true;
      else if (a === '-v' || a === '--verbose') verbose = true;
      else if (a === '--ignore-fail-on-non-empty') ignoreNonEmpty = true;
      else if (/^-[pv]+$/.test(a)) { if (a.includes('p')) parents = true; if (a.includes('v')) verbose = true; }
      else if (a.startsWith('-') && a.length > 1) { ctx.stderr += `rmdir: invalid option -- '${a.replace(/^-+/, '')}'\n`; return 1; }
      else dirs.push(a);
    }
    if (dirs.length === 0) { ctx.stderr += 'rmdir: missing operand\n'; return 1; }
    let status = 0;
    const remove = async (path: string): Promise<boolean> => {
      const full = ctx.fs.resolvePath(path, ctx.cwd);
      let st;
      try { st = await ctx.fs.stat(full); }
      catch { ctx.stderr += `rmdir: failed to remove '${path}': No such file or directory\n`; return false; }
      if (st.type !== 'dir') { ctx.stderr += `rmdir: failed to remove '${path}': Not a directory\n`; return false; }
      if ((await ctx.fs.readdir(full)).length > 0) {
        if (!ignoreNonEmpty) ctx.stderr += `rmdir: failed to remove '${path}': Directory not empty\n`;
        return ignoreNonEmpty;
      }
      try { await ctx.fs.rmdir(full); }
      catch (e: any) { ctx.stderr += `rmdir: failed to remove '${path}': ${e.message}\n`; return false; }
      if (verbose) ctx.stdout += `rmdir: removing directory, '${path}'\n`;
      return true;
    };
    for (const d of dirs) {
      let path = d.replace(/\/+$/, '') || d;
      if (!(await remove(path))) { status = 1; continue; }
      while (parents) {                              // rmdir -p a/b/c removes c, then b, then a
        const slash = path.lastIndexOf('/');
        if (slash <= 0) break;
        path = path.slice(0, slash);
        if (!(await remove(path))) { status = 1; break; }
      }
    }
    return status;
  },
};


export const shasumCmd: Command = {
  name: 'shasum',
  description: 'Compute SHA checksums',
  async exec(ctx) {
    let algorithm = '1';
    const forwarded: string[] = [];

    for (let i = 0; i < ctx.args.length; i++) {
      const arg = ctx.args[i];
      if ((arg === '-a' || arg === '--algorithm') && ctx.args[i + 1]) {
        algorithm = ctx.args[++i];
      } else if (arg.startsWith('--algorithm=')) algorithm = arg.slice(12);
      else forwarded.push(arg);
    }

    const command = {'1':sha1sum,'256':sha256sum,'384':sha384sum,'512':sha512sum}[algorithm];
    if (!command) {
      ctx.stderr = `shasum: unrecognized algorithm: ${algorithm}\n`;
      return 1;
    }

    const previous = ctx.args;
    ctx.args = forwarded;
    try {return await command.exec(ctx);} finally {ctx.args = previous;}
  },
};

export const openCmd: Command = {
  name: 'open',
  description: 'Open files, directories, or URLs',
  parityScope:'integration-only',
  async exec(ctx) {
    let app: string | null = null;
    const targets: string[] = [];
    for (let i = 0; i < ctx.args.length; i++) {
      if (ctx.args[i] === '-a' && ctx.args[i + 1]) { app = ctx.args[++i]; continue; }
      targets.push(ctx.args[i]);
    }
    if (targets.length === 0) {
      ctx.stderr = 'Usage: open [-a app] <file|url>\n';
      return 1;
    }

    for (const target of targets) {
      // URL?
      if (/^https?:\/\//.test(target)) {
        // Intercept OAuth URLs — rewrite redirect_uri for manual code flow
        // and show clickable links instead of opening a window that won't work
        if (target.includes('claude.ai/oauth/')) {
          const fixedUrl = target.replace(
            /redirect_uri=http%3A%2F%2Flocalhost%3A\d+%2F[^&]*/,
            'redirect_uri=' + encodeURIComponent('https://platform.claude.com/oauth/code/callback')
          );
          if (ctx.terminal) {
            const openBtn = `\x1b]8;;${fixedUrl}\x07\x1b[1;36m[ Open in Browser ]\x1b[0m\x1b]8;;\x07`;
            ctx.terminal.writeOutput(`\r\n  ${openBtn}\r\n`);
          } else {
            if (typeof window !== 'undefined') window.open(fixedUrl, '_blank');
          }
          continue;
        }
        if (typeof window !== 'undefined') window.open(target, '_blank');
        continue;
      }
      // File or directory
      const resolved = ctx.fs.resolvePath(target, ctx.cwd);
      const stat = await ctx.fs.stat(resolved).catch(() => null);
      if (!stat) {
        ctx.stderr += `open: ${target}: No such file or directory\n`;
        return 1;
      }

      const cmd = app || getAssociation(target);
      if (!cmd) {
        ctx.stderr += `open: no browser handler for '${target}'; select native execution\n`;
        return 2;
      }
      const result = await ctx.shell.execArgv([cmd,resolved]);
      ctx.stdout += result.stdout;
      ctx.stderr += result.stderr;
      if (result.exitCode !== 0) return result.exitCode;
    }
    return 0;
  },
};

/**
 * Shiro-specific command owners included once in COMMAND_CATALOG.
 */
export const shiroCmds: Command[] = [
  rmCmd, lnCmd, colCmd,
  hostnameCmd, unameCmd,
  whichCmd, typeCmd,
  rmdirCmd,
  // cut and sha256sum come from cut.ts and hashsum.ts (GNU-compatible)
  shasumCmd,
  openCmd, { name: 'xdg-open', description: 'Open a URL in the browser', parityScope:'integration-only', exec: (ctx) => openCmd.exec(ctx) },
];
