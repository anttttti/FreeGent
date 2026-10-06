/**
 * du — disk usage (GNU du: -a -s -h --si -b -k -m -c -d/--max-depth --apparent-size -B --exclude -0 -x).
 * Disk usage counts whole 4 KiB blocks, as on a typical filesystem; -b / --apparent-size counts bytes
 * (a directory itself is 4096).
 */
import type { Command } from './index';
import { readdirEntries, statEntry } from './flags';
import { globToRegex } from '../utils/glob-regex.js';

const BLOCK = 4096;

function human(bytes: number, base: 1024 | 1000): string {
  const units = ['', 'K', 'M', 'G', 'T', 'P'];
  let v = bytes, u = 0;
  while (v >= base && u < units.length - 1) { v /= base; u++; }
  if (u === 0) return String(bytes);
  const unit = base === 1000 && u === 1 ? 'k' : units[u];
  return (v < 10 ? (Math.ceil(v * 10) / 10).toFixed(1) : String(Math.ceil(v))) + unit;
}

export const du: Command = {
  name: "du",
  description: "Estimate file space usage",
  async exec(ctx) {
    const a = ctx.args;
    let all = false, summarize = false, hr: 1024 | 1000 | 0 = 0, apparent = false, total = false, nul = false;
    let unit = 1024, maxDepth = Infinity;
    const excludes: RegExp[] = [];
    const targets: string[] = [];
    const bad = (m: string) => { ctx.stderr += `du: ${m}\n`; return 1; };
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x === '--') { targets.push(...a.slice(i + 1)); break; }
      if (x.startsWith('--')) {
        const eq = x.indexOf('=');
        const name = eq > 0 ? x.slice(2, eq) : x.slice(2);
        const v = eq > 0 ? x.slice(eq + 1) : undefined;
        switch (name) {
          case 'all': all = true; break;
          case 'summarize': summarize = true; break;
          case 'human-readable': hr = 1024; break;
          case 'si': hr = 1000; break;
          case 'apparent-size': apparent = true; break;
          case 'bytes': apparent = true; unit = 1; break;
          case 'total': total = true; break;
          case 'null': nul = true; break;
          case 'max-depth': maxDepth = parseInt(v ?? a[++i], 10); if (!(maxDepth >= 0)) return bad(`invalid maximum depth '${v}'`); break;
          case 'exclude': excludes.push(globToRegex(v ?? a[++i] ?? '')); break;
          case 'block-size': { const b = (v ?? a[++i] ?? ''); const m = /^(\d*)([KMG]?)$/i.exec(b); if (!m) return bad(`invalid --block-size argument '${b}'`); unit = (m[1] ? parseInt(m[1], 10) : 1) * ({ '': 1, K: 1024, M: 1048576, G: 1073741824 } as Record<string, number>)[m[2].toUpperCase()]; break; }
          case 'one-file-system': case 'dereference': case 'count-links': case 'separate-dirs': case 'time': break;
          default: return bad(`unrecognized option '--${name}'`);
        }
        continue;
      }
      if (x.startsWith('-') && x.length > 1) {
        for (let k = 1; k < x.length; k++) {
          const c = x[k];
          if (c === 'a') all = true;
          else if (c === 's') summarize = true;
          else if (c === 'h') hr = 1024;
          else if (c === 'b') { apparent = true; unit = 1; }
          else if (c === 'k') unit = 1024;
          else if (c === 'm') unit = 1048576;
          else if (c === 'c') total = true;
          else if (c === '0') nul = true;
          else if (c === 'x' || c === 'L' || c === 'l' || c === 'S') { /* accepted */ }
          else if (c === 'd' || c === 'B') {
            const v = x.length > k + 1 ? x.slice(k + 1) : a[++i];
            if (c === 'd') { maxDepth = parseInt(v, 10); if (!(maxDepth >= 0)) return bad(`invalid maximum depth '${v}'`); }
            else { const m = /^(\d*)([KMG]?)$/i.exec(v ?? ''); if (!m) return bad(`invalid -B argument '${v}'`); unit = (m[1] ? parseInt(m[1], 10) : 1) * ({ '': 1, K: 1024, M: 1048576, G: 1073741824 } as Record<string, number>)[m[2].toUpperCase()]; }
            break;
          } else return bad(`invalid option -- '${c}'`);
        }
        continue;
      }
      targets.push(x);
    }
    if (summarize && maxDepth !== Infinity) return bad('cannot both summarize and show all entries');
    if (summarize) maxDepth = 0;
    if (targets.length === 0) targets.push('.');

    const sep = nul ? '\0' : '\n';
    const fmt = (bytes: number) => (hr ? human(bytes, hr) : String(Math.ceil(bytes / unit)));
    const cost = (size: number, isDir: boolean) => (apparent ? (isDir ? BLOCK : size) : (isDir || size > 0 ? Math.ceil(Math.max(size, 1) / BLOCK) * BLOCK : 0));
    let status = 0;
    let grand = 0;

    const walk = async (full: string, shown: string, depth: number): Promise<number> => {
      let st;
      try { st = await statEntry(ctx.fs, full); }
      catch { ctx.stderr += `du: cannot access '${shown}': No such file or directory\n`; status = 1; return 0; }
      if (st.type !== 'dir') {
        const c = cost(st.size, false);
        if (depth === 0 || (all && depth <= maxDepth)) ctx.stdout += `${fmt(c)}\t${shown}${sep}`;
        return c;
      }
      let sum = cost(0, true);
      for (const e of await readdirEntries(ctx.fs, full)) {
        if (excludes.some(r => r.test(e.name))) continue;
        sum += await walk(full === '/' ? '/' + e.name : full + '/' + e.name, shown === '/' ? '/' + e.name : shown + '/' + e.name, depth + 1);
      }
      if (depth <= maxDepth) ctx.stdout += `${fmt(sum)}\t${shown}${sep}`;
      return sum;
    };

    for (const t of targets) grand += await walk(ctx.fs.resolvePath(t, ctx.cwd), t, 0);
    if (total) ctx.stdout += `${fmt(grand)}\ttotal${sep}`;
    return status;
  },
};
