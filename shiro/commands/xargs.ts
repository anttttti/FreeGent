
import type { Command } from './index';
import { parseArgs } from './flags';
import { shellQuote } from './run-subcommand';
export const xargs: Command = {
  name: "xargs",
  description: "Build and execute command lines from stdin",
  async exec(ctx) {
    // -0 / --null: parseArgs doesn't take digit flags, so pick it out first.
    const nullFlag = ctx.args.some(a => a === '-0' || a === '--null');
    const args = ctx.args.filter(a => a !== '-0' && a !== '--null');
    const { flags, positional, values } = parseArgs(args, ["n", "I", "i", "d", "delimiter"]);
    const onePerLine = flags.I || flags.L || flags.l;
    const replaceStr = values.I || values.i; // -I{} or -i
    const maxArgs = values.n ? parseInt(values.n) : undefined;
    const nullDelim = nullFlag;
    const delimiter = nullDelim ? '\0' : (values.d || values.delimiter || /\s+/);
    const verbose = flags.t || flags.verbose;
    const noRunIfEmpty = flags.r;

    const template = positional.length ? positional : ['echo'];
    if (maxArgs !== undefined && (!Number.isInteger(maxArgs) || maxArgs < 1)) {
      ctx.stderr += `xargs: invalid number for -n option: ${values.n}\n`;
      return 1;
    }
    let items: string[];
    const separator = replaceStr ? '\n' : delimiter;
    if (typeof separator === 'string') {
      items = ctx.stdin === '' ? [] : ctx.stdin.split(separator);
      if (ctx.stdin.endsWith(separator)) items.pop();
      if (replaceStr) items = items.filter(s => /\S/.test(s));
    } else {
      items = [];
      let word = '', active = false, quote = '', escape = false;
      for (const c of ctx.stdin) {
        if (escape) { word += c; active = true; escape = false; }
        else if (c === '\\' && !quote) { escape = true; active = true; }
        else if (quote) { if (c === quote) quote = ''; else word += c; }
        else if (c === '"' || c === "'") { quote = c; active = true; }
        else if (/\s/.test(c)) { if (active) { items.push(word); word = ''; active = false; } }
        else { word += c; active = true; }
      }
      if (quote || escape) { ctx.stderr += 'xargs: unmatched quote or trailing backslash\n'; return 1; }
      if (active) items.push(word);
    }
    if (!items.length && (noRunIfEmpty || replaceStr)) return 0;
    const batches: string[][] = [];
    if (replaceStr || onePerLine) for (const item of items) batches.push([item]);
    else if (maxArgs) for (let i = 0; i < items.length; i += maxArgs) batches.push(items.slice(i, i + maxArgs));
    else batches.push(items);
    if (!batches.length) batches.push([]);
    let status = 0;
    for (const batch of batches) {
      const argv = replaceStr ? template.map(a => a.split(String(replaceStr)).join(batch[0])) : [...template, ...batch];
      if (verbose) ctx.stderr += argv.map(shellQuote).join(' ') + '\n';
      // xargs consumes its own stdin; children read /dev/null unless explicitly redirected.
      const result = await ctx.shell.fork().execArgv(argv, '', true);
      ctx.stdout += result.stdout;
      ctx.stderr += result.stderr;
      if (result.exitCode === 255) return 124;
      if (result.exitCode === 126 || result.exitCode === 127) return result.exitCode;
      if (result.exitCode !== 0) status = 123;
    }
    return status;
  },
};
