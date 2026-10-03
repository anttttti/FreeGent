import type { Command } from './index';
import { runSubcommand } from './run-subcommand';

// Patterns that indicate a sensitive env var (case-insensitive match on key)
/** Shell bookkeeping that lives in the same table as the environment but is not part of it. */
export const INTERNAL_VARS = new Set(['LINENO', '?', '#', '@', '*', '$', '!', '_', 'OLDPWD_INTERNAL']);
const SECRET_PATTERNS = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL|API_KEY|AUTH_TOKEN|ACCESS_TOKEN|GITHUB_TOKEN)$/i;

/**
 * env [-i] [-u NAME]... [NAME=VALUE]... [COMMAND [ARG]...]
 * With no command, prints the resulting environment (secrets masked: the output goes to the model).
 */
export const env: Command = {
  name: "env",
  description: "Print environment variables, or run a command in a modified one",
  async exec(ctx) {
    const args = ctx.args;
    let ignore = false, nullSep = false;
    const unset: string[] = [];
    let i = 0;
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { i++; break; }
      if (a === '-i' || a === '--ignore-environment' || a === '-') ignore = true;
      else if (a === '-0' || a === '--null') nullSep = true;
      else if (a === '-u' || a === '--unset') {
        if (i + 1 >= args.length) { ctx.stderr += `env: option requires an argument -- 'u'\n`; return 125; }
        unset.push(args[++i]);
      } else if (a.startsWith('--unset=')) unset.push(a.slice(8));
      else if (a.startsWith('-u') && a.length > 2) unset.push(a.slice(2));
      else if (a.startsWith('-') && a.length > 1 && !a.includes('=')) { ctx.stderr += `env: invalid option -- '${a.replace(/^-+/, '')}'\n`; return 125; }
      else break;
    }
    const next: Record<string, string> = ignore ? {} : { ...ctx.env };
    for (const k of Object.keys(next)) if (INTERNAL_VARS.has(k) || /^\d+$/.test(k)) delete next[k];
    for (const name of unset) delete next[name];
    for (; i < args.length; i++) {
      const eq = args[i].indexOf('=');
      if (eq <= 0) break;
      next[args[i].slice(0, eq)] = args[i].slice(eq + 1);
    }
    const command = args.slice(i);

    if (command.length === 0) {
      const lines = Object.entries(next)
        .map(([k, v]) => {
          if (SECRET_PATTERNS.test(k) && v && v.length >= 8) {
            return `${k}=${v.slice(0, 4)}${'*'.repeat(Math.min(v.length - 4, 20))}`;
          }
          return `${k}=${v}`;
        })
        .sort();
      ctx.stdout += lines.join(nullSep ? '\0' : '\n') + (lines.length ? (nullSep ? '\0' : '\n') : '');
      return 0;
    }

    // Run the command with the modified environment, then put the shell's own back
    const shellEnv = ctx.shell.env;
    const saved = { ...shellEnv };
    for (const k of Object.keys(shellEnv)) delete shellEnv[k];
    Object.assign(shellEnv, next);
    let out = '', err = '';
    let code: number;
    try {
      code = await runSubcommand(ctx, command, s => { out += s; }, s => { err += s; });
    } finally {
      for (const k of Object.keys(shellEnv)) delete shellEnv[k];
      Object.assign(shellEnv, saved);
    }
    ctx.stdout += out;
    ctx.stderr += err;
    return code === 127 ? 127 : code;
  },
};
