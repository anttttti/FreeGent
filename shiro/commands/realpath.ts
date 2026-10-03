import type { Command } from './index';
import { canonicalize, relativeTo, type CanonMode } from './canonical';

/** realpath [-e|-m] [-s] [-q] [-z] [--relative-to=DIR] [--relative-base=DIR] FILE... */
export const realpath: Command = {
  name: "realpath",
  description: "Print the resolved absolute path",
  async exec(ctx) {
    let mode: CanonMode = 'missing-last', symlinks = true, quiet = false, zero = false;
    let relTo: string | null = null, relBase: string | null = null;
    const files: string[] = [];
    const a = ctx.args;
    const fail = (m: string) => { ctx.stderr += `realpath: ${m}\n`; return 1; };
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x === '--') { files.push(...a.slice(i + 1)); break; }
      if (x === '-e' || x === '--canonicalize-existing') mode = 'existing';
      else if (x === '-E') mode = 'missing-last';
      else if (x === '-m' || x === '--canonicalize-missing') mode = 'missing-ok';
      else if (x === '-s' || x === '--strip' || x === '--no-symlinks') symlinks = false;
      else if (x === '-L' || x === '-P' || x === '--logical' || x === '--physical') { /* accepted */ }
      else if (x === '-q' || x === '--quiet') quiet = true;
      else if (x === '-z' || x === '--zero') zero = true;
      else if (x === '--relative-to') relTo = a[++i] ?? null;
      else if (x.startsWith('--relative-to=')) relTo = x.slice(14);
      else if (x === '--relative-base') relBase = a[++i] ?? null;
      else if (x.startsWith('--relative-base=')) relBase = x.slice(16);
      else if (/^-[eEmsLPqz]+$/.test(x)) {
        for (const c of x.slice(1)) {
          if (c === 'e') mode = 'existing'; else if (c === 'E') mode = 'missing-last'; else if (c === 'm') mode = 'missing-ok';
          else if (c === 's') symlinks = false; else if (c === 'q') quiet = true; else if (c === 'z') zero = true;
        }
      } else if (x.startsWith('-') && x.length > 1) return fail(`invalid option -- '${x.replace(/^-+/, '')}'`);
      else files.push(x);
    }
    if (files.length === 0) return fail('missing operand');
    const toAbs = async (p: string) => canonicalize(ctx.fs, ctx.cwd, p, mode === 'existing' ? 'existing' : 'missing-ok', symlinks);
    const base = relTo !== null ? await toAbs(relTo) : null;
    const rbase = relBase !== null ? await toAbs(relBase) : null;
    let status = 0;
    for (const f of files) {
      const abs = await canonicalize(ctx.fs, ctx.cwd, f, mode, symlinks);
      if (abs === null) {
        if (!quiet) ctx.stderr += `realpath: ${f}: ${mode === 'existing' ? 'No such file or directory' : 'No such file or directory'}\n`;
        status = 1;
        continue;
      }
      let shown = abs;
      const under = (root: string) => abs === root || abs.startsWith(root === '/' ? '/' : root + '/');
      if (base !== null && (rbase === null || under(rbase))) shown = relativeTo(abs, base);
      else if (rbase !== null && under(rbase)) shown = relativeTo(abs, rbase);
      ctx.stdout += shown + (zero ? '\0' : '\n');
    }
    return status;
  },
};
