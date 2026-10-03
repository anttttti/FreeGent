import type { CommandContext } from './index';

/** Quote one argument so the shell reads it back as a single word. */
export function shellQuote(s: string): string {
  return /[^a-zA-Z0-9._\-/=:@%+,]/.test(s) || s === '' ? `'${s.replace(/'/g, "'\\''")}'` : s;
}

/**
 * Run `argv` as a command line through the host shell (so builtins, functions, aliases and
 * PATH lookup all apply). Piped stdin is handed over through a temp file. Output arrives
 * through `onOut` / `onErr` with terminal line endings already turned back into \n.
 */
export async function runSubcommand(
  ctx: CommandContext,
  argv: string[],
  onOut: (s: string) => void,
  onErr: (s: string) => void,
): Promise<number> {
  let line = argv.map(shellQuote).join(' ');
  let tmp: string | null = null;
  if (ctx.stdin) {
    tmp = ctx.fs.resolvePath(`/tmp/.stdin.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ctx.cwd);
    await ctx.fs.writeFile(tmp, ctx.stdin);
    line += ` < ${shellQuote(tmp)}`;
  }
  try {
    return await ctx.shell.execute(
      line,
      s => onOut(s.replace(/\r\n/g, '\n')),
      s => onErr(s.replace(/\r\n/g, '\n')),
      false, undefined, true,
    );
  } finally {
    if (tmp) { try { await ctx.fs.unlink(tmp); } catch { /* best effort */ } }
  }
}
