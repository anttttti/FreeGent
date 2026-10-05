import type { CommandContext } from './index';

/** Quote one argument so the shell reads it back as a single word. */
export function shellQuote(s: string): string {
  return /[^a-zA-Z0-9._\-/=:@%+,]/.test(s) || s === '' ? `'${s.replace(/'/g, "'\\''")}'` : s;
}

/** Dispatch argv and stdin without shell reparsing or temporary workspace files. */
export async function runSubcommand(
  ctx: CommandContext,
  argv: string[],
  onOut: (s: string) => void,
  onErr: (s: string) => void,
): Promise<number> {
  const result = await ctx.shell.execArgv(argv, ctx.stdin);
  onOut(result.stdout);
  onErr(result.stderr);
  return result.exitCode;
}
