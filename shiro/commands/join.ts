import type { Command } from './index';
import { toLines } from './flags';

// GNU join: a merge join of two files sorted on the join field. -1/-2/-j field, -t CHAR (default:
// blank-separated, leading blanks ignored, output joined with a space), -a N unpaired lines too,
// -v N only unpaired lines, -e EMPTY for missing fields, -o FORMAT (N.M list, 0, auto),
// -i ignore case, --header.
export const join: Command = {
  name: "join",
  description: "Join lines of two files on a common field",
  async exec(ctx) {
    let f1 = 1, f2 = 1, tab: string | null = null, empty: string | null = null, format: string | null = null;
    const unpaired = new Set<number>();
    let onlyUnpaired = false, ignoreCase = false, header = false;
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const val = (len: number) => a.length > len ? a.slice(len) : args[++i];
      if (a === '-i' || a === '--ignore-case') ignoreCase = true;
      else if (a === '--header') header = true;
      else if (a === '--check-order' || a === '--nocheck-order') { /* no-op */ }
      else if (a.startsWith('-1')) f1 = parseInt(val(2), 10);
      else if (a.startsWith('-2')) f2 = parseInt(val(2), 10);
      else if (a.startsWith('-j')) f1 = f2 = parseInt(val(2), 10);
      else if (a.startsWith('-t')) tab = val(2);
      else if (a.startsWith('-e')) empty = val(2);
      else if (a.startsWith('-o')) format = val(2);
      else if (a.startsWith('-a')) unpaired.add(parseInt(val(2), 10));
      else if (a.startsWith('-v')) { unpaired.add(parseInt(val(2), 10)); onlyUnpaired = true; }
      else files.push(a);
    }
    if (files.length !== 2) { ctx.stderr += `join: ${files.length < 2 ? 'missing operand' : 'extra operand'}\n`; return 1; }
    const read = async (f: string) => f === '-' ? ctx.stdin : await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd), 'utf8') as string;
    let t1: string, t2: string;
    try { t1 = await read(files[0]); t2 = await read(files[1]); }
    catch { ctx.stderr += `join: ${files[0]}: No such file or directory\n`; return 1; }
    const split = (l: string) => tab === null ? l.split(/[ \t]+/).filter((x, k) => x !== '' || k > 0).filter(x => x !== '') : l.split(tab);
    const rec1 = toLines(t1).lines.map(split), rec2 = toLines(t2).lines.map(split);
    const out: string[] = [];
    const sep = tab ?? ' ';
    const key = (r: string[], f: number) => { const k = r[f - 1] ?? ''; return ignoreCase ? k.toLowerCase() : k; };
    const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    const fmt = (r1: string[] | null, r2: string[] | null): string => {
      const joinVal = r1 ? r1[f1 - 1] ?? '' : r2 ? r2[f2 - 1] ?? '' : '';
      const e = empty ?? '';
      if (format && format !== 'auto') {
        return format.split(/[ ,]+/).map(spec => {
          if (spec === '0') return joinVal;
          const [fnum, field] = spec.split('.').map(Number);
          const r = fnum === 1 ? r1 : r2;
          return r ? (r[field - 1] ?? e) : e;
        }).join(sep);
      }
      const rest = (r: string[] | null, f: number, n: number) => r ? r.filter((_, k) => k !== f - 1) : format === 'auto' ? Array(Math.max(0, n - 1)).fill(e) : [];
      const n1 = rec1[0]?.length ?? 0, n2 = rec2[0]?.length ?? 0;
      return [joinVal, ...rest(r1, f1, n1), ...rest(r2, f2, n2)].join(sep);
    };
    let i = 0, j = 0;
    if (header && rec1.length && rec2.length) { out.push(fmt(rec1[0], rec2[0])); i = 1; j = 1; }
    while (i < rec1.length || j < rec2.length) {
      if (j >= rec2.length || (i < rec1.length && cmp(key(rec1[i], f1), key(rec2[j], f2)) < 0)) {
        if (unpaired.has(1)) out.push(fmt(rec1[i], null));
        i++; continue;
      }
      if (i >= rec1.length || cmp(key(rec1[i], f1), key(rec2[j], f2)) > 0) {
        if (unpaired.has(2)) out.push(fmt(null, rec2[j]));
        j++; continue;
      }
      // Equal keys: every pairing of the two runs.
      const k = key(rec1[i], f1);
      let i2 = i, j2 = j;
      while (i2 < rec1.length && key(rec1[i2], f1) === k) i2++;
      while (j2 < rec2.length && key(rec2[j2], f2) === k) j2++;
      if (!onlyUnpaired) for (let a = i; a < i2; a++) for (let b = j; b < j2; b++) out.push(fmt(rec1[a], rec2[b]));
      i = i2; j = j2;
    }
    ctx.stdout += out.map(l => l + '\n').join('');
    return 0;
  },
};
