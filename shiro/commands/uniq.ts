
import type { Command } from './index';
import { parseArgs, readOperandBytes } from './flags';
export const uniq: Command = {
  name: "uniq",
  description: "Report or omit repeated lines",
  async exec(ctx) {
    const args = ctx.args;
    const { flags, positional, values } = parseArgs(args, ["f", "s", "w"]);

    const skipFields = values.f ? parseInt(values.f) : 0;
    const skipChars = values.s ? parseInt(values.s) : 0;
    const checkChars = values.w ? parseInt(values.w) : undefined;
    const ignoreCase = flags.i;

    try {
      // uniq [INPUT [OUTPUT]]: no operand or "-" is stdin; the second operand is the file the result is written to.
      if (positional.length > 2) throw new Error(`extra operand '${positional[2]}'`);
      const content = positional.length && positional[0] !== "-"
        ? new TextDecoder().decode(await readOperandBytes(ctx, positional[0]))
        : ctx.stdin;
      const lines = content.split("\n");
      // Remove trailing empty from final newline
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

      const output: string[] = [];
      let prev = "";
      let prevKey = "";
      let count = 0;

      for (const line of lines) {
        const key = getComparisonKey(line, skipFields, skipChars, checkChars, ignoreCase);

        if (count > 0 && key === prevKey) {   // the first line starts a group even when its key is empty
          count++;
        } else {
          if (count > 0) emitLine(prev, count, flags, output);
          prev = line;
          prevKey = key;
          count = 1;
        }
      }
      if (count > 0) emitLine(prev, count, flags, output);

      const text = output.join("\n") + (output.length > 0 ? "\n" : "");
      if (positional[1] && positional[1] !== "-") await ctx.fs.writeFile(ctx.fs.resolvePath(positional[1], ctx.cwd), text);
      else ctx.stdout += text;
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `uniq: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};

function getComparisonKey(
  line: string,
  skipFields: number,
  skipChars: number,
  checkChars: number | undefined,
  ignoreCase: boolean
): string {
  let key = line;

  // Skip fields
  if (skipFields > 0) {
    // A field is the blanks before a word and the word; what follows the skipped fields is compared as it is written.
    key = line.slice((new RegExp(`^(?:[ \\t]*[^ \\t]+){0,${skipFields}}`).exec(line) as RegExpExecArray)[0].length);
  }

  // Skip characters
  if (skipChars > 0) {
    key = key.substring(skipChars);
  }

  // Check only N characters
  if (checkChars !== undefined) {
    key = key.substring(0, checkChars);
  }

  // Case insensitive
  if (ignoreCase) {
    key = key.toLowerCase();
  }

  return key;
}

function emitLine(
  line: string,
  count: number,
  flags: Record<string, boolean>,
  output: string[]
): void {
  // -d: only duplicated lines
  if (flags.d && count < 2) return;

  // -u: only unique lines
  if (flags.u && count > 1) return;

  // -c: prefix with count
  if (flags.c) {
    output.push(`${String(count).padStart(7)} ${line}`);
  } else {
    output.push(line);
  }
}
