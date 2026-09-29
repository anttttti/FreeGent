import type { Command, CommandContext } from './index';

// GNU diff: Myers' algorithm; normal (default), unified (-u / -U N) and context (-c / -C N)
// output, -q brief, -s report identical, -i -w -b -B comparisons, -r for directories, and
// "\ No newline at end of file". Exit 0 same, 1 different, 2 trouble.

type Op = { t: '=' | '-' | '+'; a: number; b: number };

function myers(a: string[], b: string[], eq: (x: string, y: string) => boolean): Op[] {
  const n = a.length, m = b.length, max = n + m;
  const v = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && eq(a[x], b[y])) { x++; y++; }
      v.set(k, x);
      if (x >= n && y >= m) { found = true; break; }
    }
  }
  // Backtrack
  const ops: Op[] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && (vv.get(k - 1) ?? -1) < (vv.get(k + 1) ?? -1))) ? k + 1 : k - 1;
    const px = vv.get(prevK) ?? 0, py = px - prevK;
    while (x > px && y > py) { ops.push({ t: '=', a: x - 1, b: y - 1 }); x--; y--; }
    if (d > 0) { if (x === px) ops.push({ t: '+', a: x, b: y - 1 }); else ops.push({ t: '-', a: x - 1, b: y }); }
    x = px; y = py;
  }
  return ops.reverse();
}

interface Hunk { a0: number; a1: number; b0: number; b1: number }   // half-open ranges

function hunks(ops: Op[]): Hunk[] {
  const out: Hunk[] = [];
  let ai = 0, bi = 0, i = 0;
  while (i < ops.length) {
    if (ops[i].t === '=') { ai++; bi++; i++; continue; }
    const h: Hunk = { a0: ai, a1: ai, b0: bi, b1: bi };
    while (i < ops.length && ops[i].t !== '=') { if (ops[i].t === '-') { h.a1++; ai++; } else { h.b1++; bi++; } i++; }
    out.push(h);
  }
  return out;
}

const range = (s: number, e: number) => e - s <= 1 ? `${e - s === 0 ? s : s + 1}` : `${s + 1},${e}`;
const NO_NL = '\\ No newline at end of file\n';

function lines(text: string) { const l = text.split('\n'); const lastNl = text.endsWith('\n') || text === ''; if (text.endsWith('\n') || text === '') l.pop(); return { l, lastNl }; }

async function readText(ctx: CommandContext, f: string): Promise<string | null> {
  if (f === '-') return ctx.stdin;
  try { return await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd), 'utf8') as string; } catch { return null; }
}

export const diffCmd: Command = {
  name: "diff",
  description: "Compare files line by line",
  async exec(ctx) {
    let mode: 'normal' | 'unified' | 'context' = 'normal', ctxLines = 3;
    let brief = false, reportSame = false, icase = false, iallspace = false, ispace = false, iblank = false, recursive = false;
    let labels: string[] = [];
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-u' || a === '--unified') mode = 'unified';
      else if (/^-U\d*$/.test(a)) { mode = 'unified'; ctxLines = parseInt(a.slice(2) || args[++i], 10); }
      else if (a.startsWith('--unified=')) { mode = 'unified'; ctxLines = parseInt(a.slice(10), 10); }
      else if (a === '-c' || a === '--context') mode = 'context';
      else if (/^-C\d*$/.test(a)) { mode = 'context'; ctxLines = parseInt(a.slice(2) || args[++i], 10); }
      else if (a === '-q' || a === '--brief') brief = true;
      else if (a === '-s' || a === '--report-identical-files') reportSame = true;
      else if (a === '-i' || a === '--ignore-case') icase = true;
      else if (a === '-w' || a === '--ignore-all-space') iallspace = true;
      else if (a === '-b' || a === '--ignore-space-change') ispace = true;
      else if (a === '-B' || a === '--ignore-blank-lines') iblank = true;
      else if (a === '-r' || a === '--recursive') recursive = true;
      else if (a === '--label') labels.push(args[++i]);
      else if (a.startsWith('--label=')) labels.push(a.slice(8));
      else if (a === '-a' || a === '--text' || a === '-N' || a === '--color=never' || a === '--strip-trailing-cr') { /* no-op */ }
      else if (/^-[uqsiwbBrac]+$/.test(a)) {
        for (const c of a.slice(1)) {
          if (c === 'u') mode = 'unified'; else if (c === 'c') mode = 'context'; else if (c === 'q') brief = true; else if (c === 's') reportSame = true;
          else if (c === 'i') icase = true; else if (c === 'w') iallspace = true; else if (c === 'b') ispace = true; else if (c === 'B') iblank = true; else if (c === 'r') recursive = true;
        }
      }
      else files.push(a);
    }
    if (files.length !== 2) { ctx.stderr += `diff: ${files.length < 2 ? 'missing operand after' : 'extra operand'} '${files[files.length - 1] ?? 'diff'}'\n`; return 2; }
    const norm = (s: string) => {
      if (iallspace) s = s.replace(/[ \t]+/g, '');
      else if (ispace) s = s.replace(/[ \t]+/g, ' ').replace(/ $/, '');
      return icase ? s.toLowerCase() : s;
    };
    const eq = (x: string, y: string) => norm(x) === norm(y);

    const compareFiles = async (fa: string, fb: string, la: string, lb: string): Promise<number> => {
      const ta = await readText(ctx, fa), tb = await readText(ctx, fb);
      if (ta === null || tb === null) { ctx.stderr += `diff: ${ta === null ? fa : fb}: No such file or directory\n`; return 2; }
      const A = lines(ta), B = lines(tb);
      // A missing final newline makes the last line differ unless both lack it.
      const ka = A.l.map((s, k) => k === A.l.length - 1 && !A.lastNl ? s + '\0' : s);
      const kb = B.l.map((s, k) => k === B.l.length - 1 && !B.lastNl ? s + '\0' : s);
      let hs = hunks(myers(ka, kb, eq));
      if (iblank) hs = hs.filter(h => !(A.l.slice(h.a0, h.a1).every(s => !s.trim()) && B.l.slice(h.b0, h.b1).every(s => !s.trim())));
      if (!hs.length) { if (reportSame) ctx.stdout += `Files ${la} and ${lb} are identical\n`; return 0; }
      if (brief) { ctx.stdout += `Files ${la} and ${lb} differ\n`; return 1; }
      const lineA = (k: number, pre: string) => pre + A.l[k] + '\n' + (k === A.l.length - 1 && !A.lastNl ? NO_NL : '');
      const lineB = (k: number, pre: string) => pre + B.l[k] + '\n' + (k === B.l.length - 1 && !B.lastNl ? NO_NL : '');
      if (mode === 'normal') {
        for (const h of hs) {
          const kind = h.a0 === h.a1 ? 'a' : h.b0 === h.b1 ? 'd' : 'c';
          ctx.stdout += `${kind === 'a' ? h.a0 : range(h.a0, h.a1)}${kind}${kind === 'd' ? h.b0 : range(h.b0, h.b1)}\n`;
          for (let k = h.a0; k < h.a1; k++) ctx.stdout += lineA(k, '< ');
          if (kind === 'c') ctx.stdout += '---\n';
          for (let k = h.b0; k < h.b1; k++) ctx.stdout += lineB(k, '> ');
        }
        return 1;
      }
      // Group hunks whose context overlaps.
      const groups: Hunk[][] = [];
      for (const h of hs) {
        const g = groups[groups.length - 1];
        if (g && h.a0 - g[g.length - 1].a1 <= 2 * ctxLines) g.push(h); else groups.push([h]);
      }
      if (mode === 'unified') {
        ctx.stdout += `--- ${labels[0] ?? la}\n+++ ${labels[1] ?? lb}\n`;
        for (const g of groups) {
          const s = Math.max(0, g[0].a0 - ctxLines), e = Math.min(A.l.length, g[g.length - 1].a1 + ctxLines);
          const sb = s + (g[0].b0 - g[0].a0), eb = e + (g[g.length - 1].b1 - g[g.length - 1].a1);
          const r = (st: number, en: number) => en - st === 1 ? `${st + 1}` : `${en - st === 0 ? st : st + 1},${en - st}`;
          ctx.stdout += `@@ -${r(s, e)} +${r(sb, eb)} @@\n`;
          let k = s;
          for (const h of g) {
            for (; k < h.a0; k++) ctx.stdout += lineA(k, ' ');
            for (let x = h.a0; x < h.a1; x++) ctx.stdout += lineA(x, '-');
            for (let x = h.b0; x < h.b1; x++) ctx.stdout += lineB(x, '+');
            k = h.a1;
          }
          for (; k < e; k++) ctx.stdout += lineA(k, ' ');
        }
        return 1;
      }
      ctx.stdout += `*** ${labels[0] ?? la}\n--- ${labels[1] ?? lb}\n`;
      for (const g of groups) {
        const s = Math.max(0, g[0].a0 - ctxLines), e = Math.min(A.l.length, g[g.length - 1].a1 + ctxLines);
        const sb = s + (g[0].b0 - g[0].a0), eb = e + (g[g.length - 1].b1 - g[g.length - 1].a1);
        const r = (st: number, en: number) => en - st <= 1 ? `${en}` : `${st + 1},${en}`;
        ctx.stdout += `***************\n*** ${r(s, e)} ****\n`;
        if (g.some(h => h.a1 > h.a0)) {
          let k = s;
          for (const h of g) {
            for (; k < h.a0; k++) ctx.stdout += lineA(k, '  ');
            for (let x = h.a0; x < h.a1; x++) ctx.stdout += lineA(x, h.b1 > h.b0 ? '! ' : '- ');
            k = h.a1;
          }
          for (; k < e; k++) ctx.stdout += lineA(k, '  ');
        }
        ctx.stdout += `--- ${r(sb, eb)} ----\n`;
        if (g.some(h => h.b1 > h.b0)) {
          let k = sb;
          for (const h of g) {
            for (; k < h.b0; k++) ctx.stdout += lineB(k, '  ');
            for (let x = h.b0; x < h.b1; x++) ctx.stdout += lineB(x, h.a1 > h.a0 ? '! ' : '+ ');
            k = h.b1;
          }
          for (; k < eb; k++) ctx.stdout += lineB(k, '  ');
        }
      }
      return 1;
    };

    const [fa, fb] = files;
    const sa = fa === '-' ? null : await ctx.fs.stat(ctx.fs.resolvePath(fa, ctx.cwd)).catch(() => null);
    const sb = fb === '-' ? null : await ctx.fs.stat(ctx.fs.resolvePath(fb, ctx.cwd)).catch(() => null);
    if (sa?.isDirectory() || sb?.isDirectory()) {
      if (sa?.isDirectory() && sb?.isDirectory()) {
        const walk = async (da: string, db: string): Promise<number> => {
          const ea = await ctx.fs.readdir(ctx.fs.resolvePath(da, ctx.cwd)).catch(() => [] as string[]);
          const eb = await ctx.fs.readdir(ctx.fs.resolvePath(db, ctx.cwd)).catch(() => [] as string[]);
          let rc = 0;
          for (const name of [...new Set([...ea, ...eb])].sort()) {
            const pa = `${da}/${name}`, pb = `${db}/${name}`;
            if (!ea.includes(name)) { ctx.stdout += `Only in ${db}: ${name}\n`; rc = Math.max(rc, 1); continue; }
            if (!eb.includes(name)) { ctx.stdout += `Only in ${da}: ${name}\n`; rc = Math.max(rc, 1); continue; }
            const isDirA = (await ctx.fs.stat(ctx.fs.resolvePath(pa, ctx.cwd))).isDirectory();
            const isDirB = (await ctx.fs.stat(ctx.fs.resolvePath(pb, ctx.cwd))).isDirectory();
            if (isDirA && isDirB) {
              if (recursive) rc = Math.max(rc, await walk(pa, pb));
              else ctx.stdout += `Common subdirectories: ${pa} and ${pb}\n`;
            } else if (!isDirA && !isDirB) {
              const before = ctx.stdout.length;
              const r = await compareFiles(pa, pb, pa, pb);
              if (r === 1 && !brief && mode === 'normal') {
                ctx.stdout = ctx.stdout.slice(0, before) + `diff ${ctx.args.filter(x => x.startsWith('-')).join(' ')}${ctx.args.some(x => x.startsWith('-')) ? ' ' : ''}${pa} ${pb}\n` + ctx.stdout.slice(before);
              }
              rc = Math.max(rc, r);
            }
          }
          return rc;
        };
        return walk(fa.replace(/\/+$/, ''), fb.replace(/\/+$/, ''));
      }
      // One directory: compare with the same-named file inside it.
      const dirIsA = !!sa?.isDirectory();
      const file = dirIsA ? fb : fa;
      const inDir = `${(dirIsA ? fa : fb).replace(/\/+$/, '')}/${file.split('/').pop()}`;
      return dirIsA ? compareFiles(inDir, fb, inDir, fb) : compareFiles(fa, inDir, fa, inDir);
    }
    return compareFiles(fa, fb, fa, fb);
  },
};
