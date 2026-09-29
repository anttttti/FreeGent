/**
 * Shell builtins — commands that need direct access to ctx.shell.
 *
 * cd, export, help, command, sh, bash, and the POSIX [ bracket alias.
 * Also re-exports grep/sed/diff so they override the unix.ts versions.
 */
import type { Command } from './index';
import { bracket } from './posix-test';
import { grepCmd } from './grep';
import { sedCmd } from './sed';
import { diffCmd } from './diff';

export const cdCmd: Command = {
  name: 'cd',
  description: 'Change directory',
  async exec(ctx) {
    const args = ctx.args[0] === '--' ? ctx.args.slice(1) : ctx.args;
    const dash = args[0] === '-';
    if (dash && !ctx.env['OLDPWD']) { ctx.stderr = 'bash: cd: OLDPWD not set\n'; return 1; }
    const target = dash ? ctx.env['OLDPWD'] : args[0] || ctx.env['HOME'] || '/';
    const resolved = ctx.fs.resolvePath(target === '~' ? (ctx.env['HOME'] || '/') : target, ctx.cwd);
    const stat = await ctx.fs.stat(resolved).catch(() => null);
    if (!stat) { ctx.stderr = `cd: no such file or directory: ${target}\n`; return 1; }
    if (!stat.isDirectory()) { ctx.stderr = `cd: not a directory: ${target}\n`; return 1; }
    ctx.shell.env['OLDPWD'] = ctx.shell.cwd;
    ctx.shell.cwd = resolved;
    ctx.shell.env['PWD'] = resolved;
    if (dash) ctx.stdout += resolved + '\n';
    return 0;
  },
};

// Map of env vars to localStorage keys for persistence across sessions
const PERSIST_ENV: Record<string, string> = {
  ANTHROPIC_API_KEY: 'shiro_anthropic_key',
  OPENAI_API_KEY: 'shiro_openai_key',
  GOOGLE_API_KEY: 'shiro_google_key',
};

export const exportCmd: Command = {
  name: 'export',
  description: 'Set environment variables',
  async exec(ctx) {
    for (const arg of ctx.args) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx === -1) continue;
      const key = arg.substring(0, eqIdx);
      const val = arg.substring(eqIdx + 1);
      ctx.shell.env[key] = val;
      // Persist API keys to localStorage so they survive page refreshes
      if (PERSIST_ENV[key] && typeof localStorage !== 'undefined') {
        localStorage.setItem(PERSIST_ENV[key], val);
      }
    }
    return 0;
  },
};

export const helpCmd: Command = {
  name: 'help',
  description: 'Show available commands',
  async exec(ctx) {
    ctx.stdout = 'shiro - available commands:\n\n';
    const cmds = ctx.shell.commands.list();
    const nameCol = 10;
    for (const cmd of cmds.sort((a, b) => a.name.localeCompare(b.name))) {
      if (cmd.name.length > nameCol) {
        ctx.stdout += ` ${cmd.name}\n`;
        ctx.stdout += `${''.padEnd(nameCol + 5)}${cmd.description}\n`;
      } else {
        ctx.stdout += ` ${cmd.name.padEnd(nameCol + 4)}${cmd.description}\n`;
      }
    }
    ctx.stdout += '\n';
    return 0;
  },
};

export const commandCmd: Command = {
  name: 'command',
  description: 'Run command or check if command exists',
  async exec(ctx) {
    if (ctx.args[0] === '-v' && ctx.args[1]) {
      const cmdName = ctx.args[1];
      const cmd = ctx.shell.commands.get(cmdName);
      if (cmd) {
        ctx.stdout = cmdName + '\n';
        return 0;
      }
      const executable = await ctx.shell.findExecutableInPath?.(cmdName);
      if (executable) {
        ctx.stdout = executable + '\n';
        return 0;
      }
      return 1;
    }
    if (ctx.args[0] === '-V' && ctx.args[1]) {
      const cmdName = ctx.args[1];
      const cmd = ctx.shell.commands.get(cmdName);
      if (cmd) {
        ctx.stdout = `${cmdName} is a shell builtin\n`;
        return 0;
      }
      ctx.stderr = `command: ${cmdName}: not found\n`;
      return 1;
    }
    if (ctx.args.length > 0) {
      const cmdName = ctx.args[0];
      const cmd = ctx.shell.commands.get(cmdName);
      if (cmd) {
        const newCtx = { ...ctx, args: ctx.args.slice(1) };
        return await cmd.exec(newCtx);
      }
      ctx.stderr = `command: ${cmdName}: not found\n`;
      return 127;
    }
    return 0;
  },
};

// The shell writes terminal output (\n as \r\n); captured output goes on as plain lines.
const lf = (s: string) => s.replace(/\r\n/g, '\n');

// sh/bash: execute shell commands from stdin or -c flag
export const shCmd: Command = {
  name: 'sh',
  description: 'Execute shell commands',
  async exec(ctx) {
    const cIdx = ctx.args.indexOf('-c');
    if (cIdx !== -1 && ctx.args[cIdx + 1]) {
      // A child shell, like a new process: variables it sets don't reach the caller.
      const r = await ctx.shell.fork().exec(ctx.args[cIdx + 1]);
      ctx.stdout += lf(r.stdout);
      ctx.stderr += lf(r.stderr);
      return r.exitCode;
    }

    if (ctx.args.length > 0 && !ctx.args[0].startsWith('-')) {
      const scriptPath = ctx.fs.resolvePath(ctx.args[0], ctx.cwd);
      const scriptArgs = ctx.args.slice(1);
      try {
        const content = await ctx.fs.readFile(scriptPath, 'utf8');
        const script = typeof content === 'string' ? content : new TextDecoder().decode(content as any);
        let stdout = '';
        let stderr = '';
        const exitCode = await ctx.shell.executeShellScript(
          script, scriptArgs, ctx,
          (s: string) => { stdout += s; },
          (s: string) => { stderr += s; },
        );
        ctx.stdout += lf(stdout);
        ctx.stderr += lf(stderr);
        return exitCode;
      } catch (e: any) {
        ctx.stderr += `sh: ${ctx.args[0]}: ${e.message}\n`;
        return 1;
      }
    }

    if (ctx.stdin) {
      let stdout = '';
      let stderr = '';
      const exitCode = await ctx.shell.executeShellScript(
        ctx.stdin, [], ctx,
        (s: string) => { stdout += s; },
        (s: string) => { stderr += s; },
      );
      ctx.stdout += lf(stdout);
      ctx.stderr += lf(stderr);
      return exitCode;
    }

    return 0;
  },
};

export const bashCmd: Command = {
  name: 'bash',
  description: 'Execute shell commands',
  async exec(ctx) {
    return shCmd.exec(ctx);
  },
};

/**
 * Shell builtins that need ctx.shell access, plus re-exports that
 * override unix.ts versions. Registered AFTER unix commands.
 */
export const shellBuiltins: Command[] = [
  cdCmd, exportCmd, helpCmd, commandCmd,
  shCmd, bashCmd,
  // Re-exports that override unix.ts versions:
  grepCmd, sedCmd, diffCmd,
  // [ … ] (posix-test.ts: requires the closing ])
  bracket,
];
