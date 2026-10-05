
import type { Command } from './index';
export const echo: Command = {
  name: "echo",
  description: "Display text",
  async exec(ctx) {
    const args = ctx.args;
    let offset = 0, noNewline = false, escapes = false;
    while (/^-[neE]+$/.test(args[offset] ?? '')) {
      for (const flag of args[offset++].slice(1)) {if (flag === 'n') noNewline = true; else escapes = flag === 'e';}
    }
    const text = args.slice(offset).join(' ');
    let output = escapes
      ? text
          .replace(/\\\\/g, "\x00ESCAPED_BACKSLASH\x00")
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t")
          .replace(/\\r/g, "\r")
          .replace(/\\a/g, "\x07")
          .replace(/\\b/g, "\b")
          .replace(/\\f/g, "\f")
          .replace(/\\v/g, "\v")
          .replace(/\\0([0-7]{0,3})/g, (_, oct) => String.fromCharCode(parseInt(oct || '0', 8)))
          .replace(/\\x([0-9a-fA-F]{1,2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
          .replace(/\x00ESCAPED_BACKSLASH\x00/g, "\\")
      : text;
    if (!noNewline) output += "\n";
    ctx.stdout += output;
    return 0;
  },
};
