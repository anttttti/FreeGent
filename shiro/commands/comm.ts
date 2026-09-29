import type { Command } from './index';
import { toLines } from './flags';

// GNU comm: compare two sorted files; column 1 only in FILE1, 2 only in FILE2, 3 in both, each
// column indented by one delimiter (tab) per shown column before it. -1 -2 -3 hide columns.
export const comm: Command = {
  name: "comm",
  description: "Compare two sorted files line by line",
  async exec(ctx) {
    const hide = new Set<string>();
    let delim = '\t', ignoreCase = false;
    const files: string[] = [];
    for (const a of ctx.args) {
      if (a.startsWith('--output-delimiter=')) delim = a.slice(19);
      else if (a === '-i') ignoreCase = true;
      else if (a === '--check-order' || a === '--nocheck-order' || a === '--total') { /* no-op */ }
      else if (/^-[123]+$/.test(a)) for (const c of a.slice(1)) hide.add(c);
      else files.push(a);
    }
    if (files.length !== 2) { ctx.stderr += 'comm: missing operand\n'; return 1; }
    const read = async (f: string) => f === '-' ? ctx.stdin : await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd), 'utf8') as string;
    let a: string[], b: string[];
    try { a = toLines(await read(files[0])).lines; b = toLines(await read(files[1])).lines; }
    catch { ctx.stderr += `comm: ${files[0]}: No such file or directory\n`; return 1; }
    const k = (s: string) => ignoreCase ? s.toLowerCase() : s;
    const col = (n: 1 | 2 | 3, s: string) => {
      if (hide.has(String(n))) return;
      let indent = '';
      if (n >= 2 && !hide.has('1')) indent += delim;
      if (n === 3 && !hide.has('2')) indent += delim;
      ctx.stdout += indent + s + '\n';
    };
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (j >= b.length || (i < a.length && k(a[i]) < k(b[j]))) col(1, a[i++]);
      else if (i >= a.length || k(a[i]) > k(b[j])) col(2, b[j++]);
      else { col(3, a[i]); i++; j++; }
    }
    return 0;
  },
};
