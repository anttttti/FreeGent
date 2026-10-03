import type { Command } from './index';
import { canonicalize, type CanonMode } from './canonical';

/** readlink [-f|-e|-m] [-n] [-q|-s] [-v] [-z] FILE... */
export const readlink: Command = {
  name: "readlink",
  description: "Print symlink target or canonical path",
  async exec(ctx) {
    let canon: CanonMode | null = null, noNewline = false, verbose = false, zero = false;
    const files: string[] = [];
    const a = ctx.args;
    const fail = (m: string) => { ctx.stderr += `readlink: ${m}\n`; return 1; };
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x === '--') { files.push(...a.slice(i + 1)); break; }
      if (x === '-f' || x === '--canonicalize') canon = 'missing-last';
      else if (x === '-e' || x === '--canonicalize-existing') canon = 'existing';
      else if (x === '-m' || x === '--canonicalize-missing') canon = 'missing-ok';
      else if (x === '-n' || x === '--no-newline') noNewline = true;
      else if (x === '-v' || x === '--verbose') verbose = true;
      else if (x === '-q' || x === '-s' || x === '--quiet' || x === '--silent') verbose = false;
      else if (x === '-z' || x === '--zero') zero = true;
      else if (/^-[femnvqsz]+$/.test(x)) {
        for (const c of x.slice(1)) {
          if (c === 'f') canon = 'missing-last'; else if (c === 'e') canon = 'existing'; else if (c === 'm') canon = 'missing-ok';
          else if (c === 'n') noNewline = true; else if (c === 'v') verbose = true; else if (c === 'z') zero = true;
        }
      } else if (x.startsWith('-') && x.length > 1) return fail(`invalid option -- '${x.replace(/^-+/, '')}'`);
      else files.push(x);
    }
    if (files.length === 0) return fail('missing operand');
    if (files.length > 1 && noNewline) noNewline = false;       // GNU ignores -n with several files
    let status = 0;
    for (const f of files) {
      let out: string | null = null;
      if (canon) out = await canonicalize(ctx.fs, ctx.cwd, f, canon, true);
      else {
        try { out = await ctx.fs.readlink(ctx.fs.resolvePath(f, ctx.cwd)); } catch { out = null; }
      }
      if (out === null) {
        if (verbose) ctx.stderr += `readlink: ${f}: ${canon ? 'No such file or directory' : 'Invalid argument'}\n`;
        status = 1;
        continue;
      }
      ctx.stdout += out + (noNewline ? '' : zero ? '\0' : '\n');
    }
    return status;
  },
};
