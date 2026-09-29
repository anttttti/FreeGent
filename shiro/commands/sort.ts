
import type { Command, CommandContext } from './index';

// GNU sort in the C locale: byte order; keys (-k) with their own options overriding the global
// ones; a last-resort whole-line comparison unless -s or -u; -n, -g, -h, -V, -M, -f, -d, -i, -b,
// -r, -u, -c/-C, -o, -t, -z.

interface Opts { b: boolean; d: boolean; f: boolean; g: boolean; i: boolean; M: boolean; n: boolean; r: boolean; V: boolean; h: boolean }
interface Key { sf: number; sc: number; ef: number; ec: number; opts: Opts; hasOpts: boolean }

const noOpts = (): Opts => ({ b: false, d: false, f: false, g: false, i: false, M: false, n: false, r: false, V: false, h: false });
const setOpt = (o: Opts, ch: string) => { if (ch in o) (o as any)[ch] = true; };

function parseKey(spec: string): Key {
  const [a, b] = spec.split(',');
  const pa = /^(\d+)(?:\.(\d+))?([bdfgiMnrVhR]*)$/.exec(a);
  if (!pa) throw new Error(`invalid number at field start: invalid count at start of '${spec}'`);
  const opts = noOpts();
  for (const ch of pa[3]) setOpt(opts, ch);
  let ef = 0, ec = 0;
  let hasOpts = pa[3].length > 0;
  if (b !== undefined) {
    const pb = /^(\d+)(?:\.(\d+))?([bdfgiMnrVhR]*)$/.exec(b);
    if (!pb) throw new Error(`invalid number after ',': invalid count at start of '${b}'`);
    ef = parseInt(pb[1], 10); ec = pb[2] ? parseInt(pb[2], 10) : 0;
    for (const ch of pb[3]) setOpt(opts, ch);
    hasOpts = hasOpts || pb[3].length > 0;
  }
  return { sf: parseInt(pa[1], 10), sc: pa[2] ? parseInt(pa[2], 10) : 1, ef, ec, opts, hasOpts };
}

const isBlank = (c: string) => c === ' ' || c === '\t';

/** Field start offsets (default: a field is its leading blanks + non-blanks). */
function fieldStarts(line: string, tab: string | null): number[] {
  const starts = [0];
  if (tab !== null) {
    for (let k = 0; k < line.length; k++) if (line[k] === tab) starts.push(k + 1);
    return starts;
  }
  let k = 0;
  while (k < line.length) {
    while (k < line.length && isBlank(line[k])) k++;
    while (k < line.length && !isBlank(line[k])) k++;
    if (k < line.length) starts.push(k);
  }
  return starts;
}

function keyText(line: string, key: Key, tab: string | null, bStart: boolean, bEnd: boolean): string {
  const starts = fieldStarts(line, tab);
  const fieldEnd = (f: number) => {
    if (f >= starts.length) return line.length;
    if (tab !== null) return f + 1 < starts.length ? starts[f + 1] - 1 : line.length;
    return f + 1 < starts.length ? starts[f + 1] : line.length;
  };
  // Start
  let s: number;
  if (key.sf - 1 >= starts.length) s = line.length;
  else {
    s = starts[key.sf - 1];
    if (bStart) while (s < line.length && isBlank(line[s])) s++;
    s = Math.min(s + key.sc - 1, fieldEnd(key.sf - 1));
  }
  // End
  let e: number;
  if (key.ef === 0) e = line.length;
  else if (key.ec === 0) e = fieldEnd(key.ef - 1);
  else if (key.ef - 1 >= starts.length) e = line.length;
  else {
    let fs = starts[key.ef - 1];
    if (bEnd) while (fs < line.length && isBlank(line[fs])) fs++;
    e = Math.min(fs + key.ec, fieldEnd(key.ef - 1));
  }
  return e > s ? line.slice(s, e) : '';
}

const numPrefix = (s: string): number => {
  const m = /^[ \t]*(-?)(\d*)(?:\.(\d*))?/.exec(s);
  if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) return 0;
  return parseFloat(`${m[1]}${m[2] || '0'}.${m[3] || '0'}`);
};
const generalNum = (s: string): number => {
  const m = /^[ \t]*[-+]?(?:\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?|inf(?:inity)?|nan)/i.exec(s);
  return m ? parseFloat(m[0].trim().replace(/^([-+]?)inf.*/i, '$1Infinity')) : -Infinity;
};
const humanKey = (s: string): [number, number] => {
  const m = /^[ \t]*(-?)(\d*(?:\.\d*)?)([KMGTPEZY]?)/i.exec(s);
  if (!m || !m[2]) return [0, 0];
  const n = parseFloat(m[1] + m[2]) || 0;
  const mag = m[3] ? 'KMGTPEZY'.indexOf(m[3].toUpperCase()) + 1 : 0;
  return [n < 0 ? -mag : mag, n];
};
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const monthKey = (s: string) => MONTHS.indexOf(s.trim().slice(0, 3).toUpperCase()) + 1;

// GNU filevercmp, simplified: compare non-digit parts (letters < non-letters, ~ first) and
// digit runs numerically.
function verCmp(a: string, b: string): number {
  const order = (c: string | undefined) => c === undefined ? 0 : c === '~' ? -1 : /[A-Za-z]/.test(c) ? c.charCodeAt(0) : c.charCodeAt(0) + 256;
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    let first = 0;
    while ((i < a.length && !/\d/.test(a[i])) || (j < b.length && !/\d/.test(b[j]))) {
      const ac = i < a.length && !/\d/.test(a[i]) ? a[i] : undefined;
      const bc = j < b.length && !/\d/.test(b[j]) ? b[j] : undefined;
      const d = order(ac) - order(bc);
      if (d) return d;
      i++; j++;
    }
    while (a[i] === '0') i++;
    while (b[j] === '0') j++;
    while (i < a.length && /\d/.test(a[i]) && j < b.length && /\d/.test(b[j])) {
      if (!first) first = a.charCodeAt(i) - b.charCodeAt(j);
      i++; j++;
    }
    if (i < a.length && /\d/.test(a[i])) return 1;
    if (j < b.length && /\d/.test(b[j])) return -1;
    if (first) return first;
  }
  return 0;
}

const bytesCmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function compareBy(a: string, b: string, o: Opts): number {
  if (o.b) { a = a.replace(/^[ \t]+/, ''); b = b.replace(/^[ \t]+/, ''); }
  if (o.n) return Math.sign(numPrefix(a) - numPrefix(b));
  if (o.g) { const x = generalNum(a), y = generalNum(b); return x === y ? 0 : x < y ? -1 : 1; }
  if (o.h) { const [ma, na] = humanKey(a), [mb, nb] = humanKey(b); return ma !== mb ? Math.sign(ma - mb) : Math.sign(na - nb); }
  if (o.M) return Math.sign(monthKey(a) - monthKey(b));
  if (o.V) return Math.sign(verCmp(a, b));
  if (o.d) { a = a.replace(/[^A-Za-z0-9 \t]/g, ''); b = b.replace(/[^A-Za-z0-9 \t]/g, ''); }
  if (o.i) { a = a.replace(/[^\x20-\x7e]/g, ''); b = b.replace(/[^\x20-\x7e]/g, ''); }
  if (o.f) { a = a.toUpperCase(); b = b.toUpperCase(); }
  return bytesCmp(a, b);
}

async function readAll(ctx: CommandContext, files: string[]): Promise<string> {
  if (!files.length) return ctx.stdin;
  let text = '';
  for (const f of files) {
    const t = f === '-' ? ctx.stdin : await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd), 'utf8') as string;
    text += t && !t.endsWith('\n') ? t + '\n' : t;
  }
  return text;
}

export const sort: Command = {
  name: "sort",
  description: "Sort lines of text",
  async exec(ctx) {
    const args = ctx.args;
    const g = noOpts();
    const keys: Key[] = [];
    let tab: string | null = null;
    let unique = false, stable = false, check: false | 'c' | 'C' = false, zero = false;
    let output: string | null = null;
    const files: string[] = [];
    try {
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--') { files.push(...args.slice(i + 1)); break; }
        if (a.startsWith('--')) {
          const [k, v] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
          const map: Record<string, string> = { '--numeric-sort': 'n', '--reverse': 'r', '--ignore-case': 'f', '--general-numeric-sort': 'g',
            '--human-numeric-sort': 'h', '--version-sort': 'V', '--month-sort': 'M', '--ignore-leading-blanks': 'b',
            '--dictionary-order': 'd', '--ignore-nonprinting': 'i' };
          if (map[k]) setOpt(g, map[k]);
          else if (k === '--unique') unique = true;
          else if (k === '--stable') stable = true;
          else if (k === '--check') check = v === 'quiet' || v === 'silent' ? 'C' : 'c';
          else if (k === '--key') keys.push(parseKey(v ?? args[++i]));
          else if (k === '--field-separator') tab = v ?? args[++i];
          else if (k === '--output') output = v ?? args[++i];
          else if (k === '--zero-terminated') zero = true;
          else if (k === '--merge' || k === '--parallel' || k === '--buffer-size' || k === '--temporary-directory') { if (v === undefined && k !== '--merge') i++; }
          else { ctx.stderr += `sort: unrecognized option '${a}'\n`; return 2; }
          continue;
        }
        if (a.startsWith('-') && a.length > 1) {
          for (let j = 1; j < a.length; j++) {
            const ch = a[j];
            const rest = a.slice(j + 1);
            if (ch === 'k') { keys.push(parseKey(rest || args[++i])); break; }
            if (ch === 't') { tab = rest || args[++i]; if (tab === '\\t') tab = '\t'; if (tab === '\\0') tab = '\0'; break; }
            if (ch === 'o') { output = rest || args[++i]; break; }
            if (ch === 'S' || ch === 'T') { if (!rest) i++; break; }
            if (ch === 'u') unique = true;
            else if (ch === 's') stable = true;
            else if (ch === 'c') check = 'c';
            else if (ch === 'C') check = 'C';
            else if (ch === 'z') zero = true;
            else if (ch === 'm' || ch === 'R') { /* merge: sorting is fine; random: unsupported */ }
            else if ('bdfgiMnrVh'.includes(ch)) setOpt(g, ch);
            else { ctx.stderr += `sort: invalid option -- '${ch}'\n`; return 2; }
          }
          continue;
        }
        files.push(a);
      }
    } catch (e: any) {
      ctx.stderr += `sort: ${e.message}\n`;
      return 2;
    }

    let text: string;
    try { text = await readAll(ctx, files); }
    catch { ctx.stderr += `sort: cannot read: ${files.find(f => f !== '-') ?? '-'}: No such file or directory\n`; return 2; }
    const sep = zero ? '\0' : '\n';
    const lines = text === '' ? [] : text.split(sep);
    if (text.endsWith(sep)) lines.pop();

    const keyCmp = (a: string, b: string): number => {
      for (const k of keys) {
        const o = k.hasOpts ? k.opts : { ...g, r: g.r };
        const r = o.r;
        const c = compareBy(keyText(a, k, tab, o.b, o.b), keyText(b, k, tab, o.b, o.b), { ...o, r: false, b: false });
        if (c) return r ? -c : c;
      }
      if (!keys.length) {
        const c = compareBy(a, b, { ...g, r: false });
        if (c) return g.r ? -c : c;
      }
      return 0;
    };
    // Last resort (no -s, -u): whole lines as bytes, reversed with -r.
    const cmp = (a: string, b: string): number => {
      const c = keyCmp(a, b);
      if (c || stable || unique) return c;
      const l = bytesCmp(a, b);
      return g.r ? -l : l;
    };

    if (check) {
      for (let j = 1; j < lines.length; j++) {
        const c = cmp(lines[j - 1], lines[j]);
        if (c > 0 || (unique && c === 0)) {
          if (check === 'c') ctx.stderr += `sort: ${files[0] ?? '-'}:${j + 1}: disorder: ${lines[j]}\n`;
          return 1;
        }
      }
      return 0;
    }

    const sorted = lines.map((l, k) => [l, k] as [string, number]).sort((x, y) => cmp(x[0], y[0]) || x[1] - y[1]).map(x => x[0]);
    const out = unique ? sorted.filter((l, k) => k === 0 || keyCmp(sorted[k - 1], l) !== 0) : sorted;
    const result = out.map(l => l + sep).join('');
    if (output) await ctx.fs.writeFile(ctx.fs.resolvePath(output, ctx.cwd), result);
    else ctx.stdout += result;
    return 0;
  },
};
