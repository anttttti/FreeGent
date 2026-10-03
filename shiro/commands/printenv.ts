
import type { Command } from './index';
import { parseArgs } from './flags';
import { INTERNAL_VARS } from './env';
export const printenv: Command = {
  name: "printenv",
  description: "Print all or part of environment",
  async exec(ctx) {
    const args = ctx.args;
    const { positional, flags } = parseArgs(args);

    const null0 = flags["0"] || flags.null;

    if (positional.length === 0) {
      // Print all environment variables
      const output: string[] = [];
      for (const [key, value] of Object.entries(ctx.env)) {
        if (INTERNAL_VARS.has(key) || /^\d+$/.test(key)) continue;
        output.push(`${key}=${value}`);
      }

      const separator = null0 ? "\0" : "\n";
      ctx.stdout += output.join(separator) + (output.length > 0 ? separator : "");
      return 0;
    } else {
      // Print the named variables that exist; the status is 1 if any is missing
      const output: string[] = [];
      let missing = false;
      for (const varName of positional) {
        if (Object.prototype.hasOwnProperty.call(ctx.env, varName)) output.push(ctx.env[varName]);
        else missing = true;
      }
      const separator = null0 ? "\0" : "\n";
      ctx.stdout += output.join(separator) + (output.length > 0 ? separator : "");
      return missing ? 1 : 0;
    }
  },
};
