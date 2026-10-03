import type { Command } from './index';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomName(n: number): string {
  let s = '';
  const bytes = new Uint8Array(n);
  (globalThis.crypto ?? undefined)?.getRandomValues?.(bytes);
  for (let i = 0; i < n; i++) s += ALPHABET[(bytes[i] || Math.floor(Math.random() * 256)) % ALPHABET.length];
  return s;
}

/**
 * mktemp [-d] [-u] [-q] [-p DIR | --tmpdir[=DIR]] [-t] [--suffix=S] [TEMPLATE]
 * No template: $TMPDIR/tmp.XXXXXXXXXX. A template is relative to the current directory
 * unless -t / -p / --tmpdir says otherwise; its last run of three or more X's is replaced.
 */
export const mkTempCmd: Command = {
  name: 'mktemp',
  description: 'Create temporary file or directory',
  async exec(ctx) {
    let makeDir = false, dryRun = false, quiet = false, useTmp = false;
    let tmpdir: string | null = null;
    let suffix = '';
    let template: string | null = null;
    const a = ctx.args;
    const fail = (m: string) => { if (!quiet) ctx.stderr += `mktemp: ${m}\n`; return 1; };
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x === '--') { if (a[i + 1] !== undefined) template = a[i + 1]; break; }
      if (x === '-d' || x === '--directory') makeDir = true;
      else if (x === '-u' || x === '--dry-run') dryRun = true;
      else if (x === '-q' || x === '--quiet') quiet = true;
      else if (x === '-t') useTmp = true;
      else if (x === '-p') { tmpdir = a[++i] ?? null; useTmp = true; }
      else if (x === '--tmpdir') { useTmp = true; }
      else if (x.startsWith('--tmpdir=')) { tmpdir = x.slice(9); useTmp = true; }
      else if (x.startsWith('-p') && x.length > 2) { tmpdir = x.slice(2); useTmp = true; }
      else if (x === '--suffix') suffix = a[++i] ?? '';
      else if (x.startsWith('--suffix=')) suffix = x.slice(9);
      else if (/^-[duqt]+$/.test(x)) { if (x.includes('d')) makeDir = true; if (x.includes('u')) dryRun = true; if (x.includes('q')) quiet = true; if (x.includes('t')) useTmp = true; }
      else if (x.startsWith('-') && x.length > 1) return fail(`invalid option -- '${x.replace(/^-+/, '')}'`);
      else if (template === null) template = x;
      else return fail(`too many templates`);
    }
    const base = tmpdir ?? ctx.env.TMPDIR ?? '/tmp';
    let tpl = template ?? 'tmp.XXXXXXXXXX';
    if (template === null) useTmp = true;
    if (suffix.includes('/')) return fail(`invalid suffix '${suffix}', contains directory separator`);
    const m = /X{3,}(?!.*X{3,})/.exec(tpl.slice(tpl.lastIndexOf('/') + 1));
    if (!m) return fail(`too few X's in template '${tpl}'`);
    if (template !== null && template.includes('/') && useTmp && tmpdir !== null) return fail(`invalid template, '${tpl}', contains directory separator`);
    // where it goes: a template with a slash stands on its own; otherwise -p/-t use the temp dir, else the cwd
    const dir = tpl.includes('/') ? '' : useTmp ? base : '';
    const slash = tpl.lastIndexOf('/');
    const head = slash >= 0 ? tpl.slice(0, slash + 1) : '';
    const leaf = tpl.slice(slash + 1);
    const xStart = m.index, xLen = m[0].length;
    for (let attempt = 0; attempt < 100; attempt++) {
      const name = leaf.slice(0, xStart) + randomName(xLen) + leaf.slice(xStart + xLen) + suffix;
      const shown = (dir ? dir.replace(/\/+$/, '') + '/' : '') + head + name;
      const full = ctx.fs.resolvePath(shown, ctx.cwd);
      let exists = false;
      try { exists = !!(await ctx.fs.stat(full)); } catch { /* free */ }
      if (exists) continue;
      try {
        if (!dryRun) {
          if (dir) await ctx.fs.mkdir(ctx.fs.resolvePath(dir, ctx.cwd), { recursive: true });
          if (makeDir) await ctx.fs.mkdir(full);
          else await ctx.fs.writeFile(full, '');
        }
      } catch (e: any) { return fail(`failed to create ${makeDir ? 'directory' : 'file'} via template '${shown}': ${e.message}`); }
      ctx.stdout += shown + '\n';
      return 0;
    }
    return fail('could not find an unused name');
  },
};
