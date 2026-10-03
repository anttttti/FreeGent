/**
 * pkg-config - reads real .pc files from PKG_CONFIG_PATH, PKG_CONFIG_LIBDIR
 * and the default directories. Packages that have no .pc file do not exist.
 */
import type { Command, CommandContext } from './index';

const DEFAULT_DIRS = ['/usr/local/lib/pkgconfig', '/usr/local/share/pkgconfig', '/usr/lib/pkgconfig', '/usr/share/pkgconfig'];

interface Pc { name: string; description: string; version: string; vars: Record<string, string>; fields: Record<string, string>; }

function expand(s: string, vars: Record<string, string>, depth = 0): string {
  return s.replace(/\$\{([^}]+)\}/g, (_, k) => (depth < 20 && k in vars ? expand(vars[k], vars, depth + 1) : ''));
}

function parsePc(id: string, text: string, prefixOverride?: string): Pc {
  const vars: Record<string, string> = {};
  const fields: Record<string, string> = {};
  for (const raw of text.replace(/\\\n/g, ' ').split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z0-9_.]+)\s*([:=])\s*(.*)$/.exec(line);
    if (!m) continue;
    if (m[2] === '=') vars[m[1]] = m[1] === 'prefix' && prefixOverride ? prefixOverride : m[3];
    else fields[m[1]] = m[3];
  }
  const ex = (k: string) => expand(fields[k] ?? '', vars);
  for (const k of Object.keys(fields)) fields[k] = ex(k);
  for (const k of Object.keys(vars)) vars[k] = expand(vars[k], vars);
  return { name: fields.Name ?? id, description: fields.Description ?? '', version: fields.Version ?? '', vars, fields };
}

/** Version comparison in the style of rpmvercmp. */
export function compareVersions(a: string, b: string): number {
  const ta = a.match(/[0-9]+|[A-Za-z]+/g) ?? [], tb = b.match(/[0-9]+|[A-Za-z]+/g) ?? [];
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const x = ta[i], y = tb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d/.test(x), ny = /^\d/.test(y);
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d < 0 ? -1 : 1; }
    else if (nx !== ny) return nx ? 1 : -1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function splitReqs(s: string): { name: string; op?: string; ver?: string }[] {
  const out: { name: string; op?: string; ver?: string }[] = [];
  const toks = s.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    if (/^(<=|>=|=|<|>|!=)$/.test(toks[i + 1] ?? '') && toks[i + 2] !== undefined) {
      out.push({ name: toks[i], op: toks[i + 1], ver: toks[i + 2] }); i += 2;
    } else out.push({ name: toks[i] });
  }
  return out;
}

function satisfies(have: string, op?: string, want?: string): boolean {
  if (!op || want === undefined) return true;
  const c = compareVersions(have, want);
  return op === '=' ? c === 0 : op === '!=' ? c !== 0 : op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0;
}

export const pkgConfig: Command = {
  name: "pkg-config",
  description: "Return metainformation about installed libraries",
  async exec(ctx: CommandContext) {
    let cflags = false, libs = false, libsOnlyL = false, libsOnlyOther = false, cflagsOnlyI = false, cflagsOnlyOther = false;
    let modversion = false, exists = false, listAll = false, printErrors = true, shortErrors = false, staticMode = false;
    let printProvides = false, printRequires = false, printRequiresPrivate = false;
    let atLeast: string | null = null, exact: string | null = null, maxV: string | null = null;
    const vars: string[] = [], defines: Record<string, string> = {};
    let variable: string | null = null, wantVersion = false;
    const pkgArgs: string[] = [];
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      const val = () => a.includes('=') ? a.slice(a.indexOf('=') + 1) : ctx.args[++i] ?? '';
      if (a === '--cflags') cflags = true;
      else if (a === '--cflags-only-I') { cflags = true; cflagsOnlyI = true; }
      else if (a === '--cflags-only-other') { cflags = true; cflagsOnlyOther = true; }
      else if (a === '--libs') libs = true;
      else if (a === '--libs-only-l') { libs = true; libsOnlyL = true; }
      else if (a === '--libs-only-L') { libs = true; libsOnlyOther = false; vars.push('L'); }
      else if (a === '--libs-only-other') { libs = true; libsOnlyOther = true; }
      else if (a === '--modversion') modversion = true;
      else if (a === '--version') wantVersion = true;
      else if (a === '--exists') exists = true;
      else if (a === '--list-all') listAll = true;
      else if (a === '--print-errors') printErrors = true;
      else if (a === '--silence-errors') printErrors = false;
      else if (a === '--short-errors') shortErrors = true;
      else if (a === '--static') staticMode = true;
      else if (a === '--print-provides') printProvides = true;
      else if (a === '--print-requires') printRequires = true;
      else if (a === '--print-requires-private') printRequiresPrivate = true;
      else if (a.startsWith('--atleast-version')) atLeast = val();
      else if (a.startsWith('--exact-version')) exact = val();
      else if (a.startsWith('--max-version')) maxV = val();
      else if (a.startsWith('--variable')) variable = val();
      else if (a.startsWith('--define-variable')) { const kv = val(); const e = kv.indexOf('='); if (e > 0) defines[kv.slice(0, e)] = kv.slice(e + 1); }
      else if (a === '--debug' || a === '--env-only' || a === '--keep-system-cflags' || a === '--keep-system-libs' || a === '--msvc-syntax') { /* accepted */ }
      else if (a.startsWith('-') && a.length > 1) { ctx.stderr += `pkg-config: Unknown option ${a}\n`; return 2; }
      else pkgArgs.push(a);
    }
    if (wantVersion) { ctx.stdout += '0.29.2\n'; return 0; }

    const dirs: string[] = [];
    const libdir = ctx.env.PKG_CONFIG_LIBDIR;
    for (const d of (ctx.env.PKG_CONFIG_PATH ?? '').split(':').filter(Boolean)) dirs.push(d);
    if (libdir) dirs.push(...libdir.split(':').filter(Boolean)); else dirs.push(...DEFAULT_DIRS);
    const abs = (d: string) => ctx.fs.resolvePath(d, ctx.cwd);

    const cache = new Map<string, Pc | null>();
    const load = async (name: string): Promise<Pc | null> => {
      if (cache.has(name)) return cache.get(name)!;
      let pc: Pc | null = null;
      const direct = name.endsWith('.pc') ? ctx.fs.resolvePath(name, ctx.cwd) : null;
      const cands = direct && await ctx.fs.exists(direct) ? [direct] : dirs.map(d => `${abs(d)}/${name}.pc`);
      for (const f of cands) {
        if (await ctx.fs.exists(f).catch(() => false)) {
          try {
            const text = await ctx.fs.readFile(f, 'utf8') as string;
            pc = parsePc(name.replace(/\.pc$/, ''), text, defines.prefix);
            for (const [k, v] of Object.entries(defines)) pc.vars[k] = v;
            break;
          } catch { /* unreadable */ }
        }
      }
      cache.set(name, pc);
      return pc;
    };

    if (listAll) {
      const seen = new Map<string, Pc>();
      for (const d of dirs) {
        let names: string[] = [];
        try { names = await ctx.fs.readdir(abs(d)); } catch { continue; }
        for (const n of names.filter(n => n.endsWith('.pc')).sort()) {
          const id = n.slice(0, -3);
          if (!seen.has(id)) { const pc = await load(id); if (pc) seen.set(id, pc); }
        }
      }
      const w = Math.max(0, ...[...seen.keys()].map(k => k.length));
      for (const [id, pc] of [...seen].sort((a, b) => a[0].localeCompare(b[0]))) ctx.stdout += `${id.padEnd(w)} ${pc.name} - ${pc.description}\n`;
      return 0;
    }

    if (pkgArgs.length === 0) { ctx.stderr += 'Must specify package names on the command line\n'; return 1; }
    const reqs = splitReqs(pkgArgs.join(' '));
    const err = (m: string) => { if (printErrors) ctx.stderr += shortErrors ? m.split('\n')[0] + '\n' : m + '\n'; };

    // Resolve packages (with requirements) in dependency order.
    const order: Pc[] = [];
    const visiting = new Set<string>();
    let failed = false;
    const visit = async (r: { name: string; op?: string; ver?: string }, top: boolean, priv: boolean): Promise<void> => {
      const pc = await load(r.name);
      if (!pc) {
        failed = true;
        err(`Package ${r.name} was not found in the pkg-config search path.\nPerhaps you should add the directory containing \`${r.name}.pc'\nto the PKG_CONFIG_PATH environment variable\nNo package '${r.name}' found`);
        return;
      }
      if (!satisfies(pc.version, r.op, r.ver)) {
        failed = true;
        err(`Package '${r.name}' has version '${pc.version}', required version is '${r.op} ${r.ver}'`);
        return;
      }
      if (visiting.has(r.name)) return;
      visiting.add(r.name);
      order.push(pc);
      const deps = splitReqs(pc.fields.Requires ?? '').concat(staticMode || priv ? splitReqs(pc.fields['Requires.private'] ?? '') : []);
      for (const d of deps) await visit(d, false, priv);
    };
    for (const r of reqs) await visit(r, true, false);
    if (failed) return 1;

    if (atLeast !== null || exact !== null || maxV !== null) {
      const pc = order[0];
      const v = pc.version;
      if (atLeast !== null && compareVersions(v, atLeast) < 0) return 1;
      if (exact !== null && compareVersions(v, exact) !== 0) return 1;
      if (maxV !== null && compareVersions(v, maxV) > 0) return 1;
      return 0;
    }
    if (exists && !cflags && !libs && !modversion && variable === null) return 0;

    const top = order.slice(0, reqs.length);
    if (modversion) { for (const p of top) ctx.stdout += p.version + '\n'; return 0; }
    if (variable !== null) {
      ctx.stdout += top.map(p => p.vars[variable!] ?? '').join(' ') + '\n';
      return 0;
    }
    if (printProvides) { for (const p of top) ctx.stdout += `${p.name} = ${p.version}\n`; return 0; }
    if (printRequires || printRequiresPrivate) {
      for (const p of top) for (const d of splitReqs(p.fields[printRequires ? 'Requires' : 'Requires.private'] ?? '')) ctx.stdout += `${d.name}${d.op ? ` ${d.op} ${d.ver}` : ''}\n`;
      return 0;
    }

    const dedupe = (tokens: string[], keepLast: boolean) => {
      const seen = new Set<string>(); const out: string[] = [];
      const list = keepLast ? [...tokens].reverse() : tokens;
      for (const t of list) if (!seen.has(t)) { seen.add(t); out.push(t); }
      return keepLast ? out.reverse() : out;
    };
    const SYSTEM_I = new Set(['-I/usr/include']);
    const SYSTEM_L = new Set(['-L/usr/lib', '-L/usr/lib64', '-L/lib']);
    const parts: string[] = [];
    if (cflags) {
      let t: string[] = [];
      for (const p of order) t.push(...(p.fields.Cflags ?? '').split(/\s+/).filter(Boolean));
      t = dedupe(t, false).filter(x => !SYSTEM_I.has(x));
      if (cflagsOnlyI) t = t.filter(x => x.startsWith('-I'));
      if (cflagsOnlyOther) t = t.filter(x => !x.startsWith('-I'));
      t = [...t.filter(x => !x.startsWith('-I')), ...t.filter(x => x.startsWith('-I'))];
      parts.push(...t);
    }
    if (libs) {
      let t: string[] = [];
      for (const p of order) {
        t.push(...(p.fields.Libs ?? '').split(/\s+/).filter(Boolean));
        if (staticMode) t.push(...(p.fields['Libs.private'] ?? '').split(/\s+/).filter(Boolean));
      }
      t = dedupe(t, true).filter(x => !SYSTEM_L.has(x));
      const onlyL = vars.includes('L');
      if (onlyL) t = t.filter(x => x.startsWith('-L'));
      else if (libsOnlyL) t = t.filter(x => x.startsWith('-l'));
      else if (libsOnlyOther) t = t.filter(x => !x.startsWith('-l') && !x.startsWith('-L'));
      parts.push(...t);
    }
    if (cflags || libs) ctx.stdout += parts.join(' ') + '\n';
    else if (!exists) { ctx.stderr += 'Must specify package names on the command line\n'; return 1; }
    return 0;
  },
};
