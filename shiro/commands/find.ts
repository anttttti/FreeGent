import type { Command, CommandContext } from './index';
import { ereToJs } from '../utils/posix-regex';
import { globToRegex } from '../utils/glob-regex.js';

// GNU find: start paths, global options (-maxdepth -mindepth -depth), and an expression of tests
// (-name -iname -path -ipath -regex -iregex -type -empty -size -newer -mtime -true -false ...),
// operators (! -not, -a, -o, parentheses) and actions (-print -print0 -printf -exec ... ; / +
// -execdir -delete -prune -quit). With no action, matching entries are printed. Directories are
// read in sorted order, so output is deterministic.

type Node =
  | { k: 'and' | 'or'; l: Node; r: Node }
  | { k: 'not'; e: Node }
  | { k: 'test'; fn: (e: Entry) => boolean | Promise<boolean> }
  | { k: 'action'; fn: (e: Entry) => boolean | Promise<boolean> };

interface Entry { path: string; abs: string; name: string; depth: number; isDir: boolean; size: number; mtime: number; mode: number }

/** fnmatch(3) glob → RegExp: * ? [...] (with ! or ^), backslash escapes. `*` crosses "/" (find -path). */
const shq = (s: string) => /^[A-Za-z0-9_\/.,:=+@%-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

export const findCmd: Command = {
  name: 'find',
  description: 'Search for files in a directory hierarchy',
  async exec(ctx: CommandContext) {
    const args = ctx.args;
    let i = 0;
    const paths: string[] = [];
    while (i < args.length && !args[i].startsWith('-') && args[i] !== '!' && args[i] !== '(') paths.push(args[i++]);
    if (!paths.length) paths.push('.');

    let maxDepth = Infinity, minDepth = 0, depthFirst = false;
    let hasAction = false;
    let quit = false;
    let status = 0;
    const batches: { cmd: string[]; paths: string[] }[] = [];
    const pruned = new Set<string>();

    const err = (msg: string): never => { throw new Error(msg); };
    const next = (opt: string) => { if (i >= args.length) err(`missing argument to \`${opt}'`); return args[i++]; };
    const run = async (cmdline: string): Promise<number> => {
      const r = await ctx.shell.exec(cmdline);
      ctx.stdout += r.stdout;
      ctx.stderr += r.stderr;
      return r.exitCode;
    };

    const primary = (): Node => {
      const a = args[i++];
      switch (a) {
        case '(': { const e = orExpr(); if (args[i++] !== ')') err('invalid expression; expected )'); return e; }
        case '!': case '-not': return { k: 'not', e: primary() };
        case '-maxdepth': maxDepth = parseInt(next(a), 10); return { k: 'test', fn: () => true };
        case '-mindepth': minDepth = parseInt(next(a), 10); return { k: 'test', fn: () => true };
        case '-depth': depthFirst = true; return { k: 'test', fn: () => true };
        case '-xdev': case '-mount': case '-noleaf': case '-ignore_readdir_race': case '-follow': return { k: 'test', fn: () => true };
        case '-name': case '-iname': { const re = globToRegex(next(a), { icase: a === '-iname' }); return { k: 'test', fn: e => re.test(e.name) }; }
        case '-path': case '-wholename': case '-ipath': case '-iwholename': {
          const re = globToRegex(next(a), { icase: a.startsWith('-i') });
          return { k: 'test', fn: e => re.test(e.path) };
        }
        case '-regex': case '-iregex': { const re = new RegExp('^(?:' + ereToJs(next(a)) + ')$', a === '-iregex' ? 'i' : ''); return { k: 'test', fn: e => re.test(e.path) }; }
        case '-regextype': next(a); return { k: 'test', fn: () => true };
        case '-type': case '-xtype': {
          const types = next(a).split(',');
          return { k: 'test', fn: e => types.some(t => t === 'd' ? e.isDir : t === 'f' ? !e.isDir : false) };
        }
        case '-empty': return {
          k: 'test', fn: async e => e.isDir ? (await ctx.fs.readdir(e.abs).catch(() => ['x'])).length === 0 : e.size === 0,
        };
        case '-size': {
          const m = /^([+-]?)(\d+)([bcwkMG]?)$/.exec(next(a));
          if (!m) err(`invalid argument to -size`);
          const unit = { '': 512, b: 512, c: 1, w: 2, k: 1024, M: 1048576, G: 1073741824 }[m![3] as ''];
          const n = parseInt(m![2], 10);
          return { k: 'test', fn: e => { if (e.isDir) return false; const u = Math.ceil(e.size / unit); return m![1] === '+' ? u > n : m![1] === '-' ? u < n : u === n; } };
        }
        case '-mtime': case '-mmin': case '-atime': case '-amin': case '-ctime': case '-cmin': {
          const m = /^([+-]?)(\d+)$/.exec(next(a));
          const per = a.endsWith('min') ? 60_000 : 86_400_000;
          return { k: 'test', fn: e => { if (!m) return false; const age = Math.floor((Date.now() - e.mtime) / per); const n = parseInt(m[2], 10); return m[1] === '+' ? age > n : m[1] === '-' ? age < n : age === n; } };
        }
        case '-newer': case '-anewer': case '-cnewer': { next(a); return { k: 'test', fn: () => true }; }
        case '-perm': case '-user': case '-group': case '-uid': case '-gid': case '-links': case '-inum': next(a); return { k: 'test', fn: () => true };
        case '-readable': case '-writable': case '-nouser': case '-nogroup': return { k: 'test', fn: () => !['-nouser', '-nogroup'].includes(a) };
        // Folders are searchable; files only once chmod +x made them executable.
        case '-executable': return { k: 'test', fn: e => e.isDir || (e.mode & 0o111) !== 0 };
        case '-true': return { k: 'test', fn: () => true };
        case '-false': return { k: 'test', fn: () => false };
        case '-print': hasAction = true; return { k: 'action', fn: e => { ctx.stdout += e.path + '\n'; return true; } };
        case '-print0': hasAction = true; return { k: 'action', fn: e => { ctx.stdout += e.path + '\0'; return true; } };
        case '-printf': {
          hasAction = true;
          const fmt = next(a);
          return { k: 'action', fn: e => { ctx.stdout += printfFind(fmt, e); return true; } };
        }
        case '-fprint': case '-fprint0': case '-fprintf': case '-fls': next(a); if (a === '-fprintf') next(a); hasAction = true; return { k: 'action', fn: () => true };
        case '-ls': hasAction = true; return { k: 'action', fn: e => { ctx.stdout += e.path + '\n'; return true; } };
        case '-delete': hasAction = true; depthFirst = true; return {
          k: 'action', fn: async e => { try { if (e.isDir) await ctx.fs.rmdir(e.abs); else await ctx.fs.unlink(e.abs); return true; } catch { status = 1; return false; } },
        };
        case '-prune': return { k: 'action', fn: e => { if (e.isDir) pruned.add(e.abs); return true; } };
        case '-quit': return { k: 'action', fn: () => { quit = true; return true; } };
        case '-exec': case '-execdir': case '-ok': case '-okdir': {
          hasAction = true;
          const cmd: string[] = [];
          while (i < args.length && args[i] !== ';' && args[i] !== '+') cmd.push(args[i++]);
          if (i >= args.length) err(`missing argument to \`${a}'`);
          const term = args[i++];
          const inDir = a.endsWith('dir');
          const target = (e: Entry) => inDir ? './' + e.name : e.path;
          if (term === '+') {
            const batch = { cmd, paths: [] as string[] };
            batches.push(batch);
            return { k: 'action', fn: e => { batch.paths.push(target(e)); return true; } };
          }
          return {
            k: 'action', fn: async e => {
              const line = cmd.map(w => shq(w.split('{}').join(target(e)))).join(' ');
              const dir = inDir ? e.path.slice(0, Math.max(1, e.path.lastIndexOf('/'))) : null;
              return (await run(dir ? `cd ${shq(dir)} && ${line}` : line)) === 0;
            },
          };
        }
      }
      if (a === undefined) err('invalid expression');
      err(a.startsWith('-') ? `unknown predicate \`${a}'` : `paths must precede expression: \`${a}'`);
      return null as never;
    };
    const andExpr = (): Node => {
      let l = primary();
      while (i < args.length && args[i] !== '-o' && args[i] !== '-or' && args[i] !== ')' && args[i] !== ',') {
        if (args[i] === '-a' || args[i] === '-and') i++;
        l = { k: 'and', l, r: primary() };
      }
      return l;
    };
    const orExpr = (): Node => {
      let l = andExpr();
      while (i < args.length && (args[i] === '-o' || args[i] === '-or')) { i++; l = { k: 'or', l, r: andExpr() }; }
      return l;
    };

    let expr: Node | null = null;
    try {
      if (i < args.length) expr = orExpr();
      if (i < args.length) err(`invalid expression near \`${args[i]}'`);
    } catch (e: any) {
      ctx.stderr += `find: ${e.message}\n`;
      return 1;
    }
    const printAll = !hasAction;
    const evalNode = async (n: Node, e: Entry): Promise<boolean> => {
      switch (n.k) {
        case 'and': return (await evalNode(n.l, e)) && evalNode(n.r, e);
        case 'or': return (await evalNode(n.l, e)) || evalNode(n.r, e);
        case 'not': return !(await evalNode(n.e, e));
        default: return n.fn(e);
      }
    };
    const visit = async (e: Entry) => {
      if (e.depth < minDepth || e.depth > maxDepth) return;
      const ok = expr ? await evalNode(expr, e) : true;
      if (ok && printAll) ctx.stdout += e.path + '\n';
    };
    const walk = async (e: Entry): Promise<void> => {
      if (quit) return;
      if (!depthFirst) await visit(e);
      if (e.isDir && e.depth < maxDepth && !pruned.has(e.abs) && !quit) {
        const names = (await ctx.fs.readdir(e.abs).catch(() => [] as string[])).sort();
        for (const name of names) {
          if (quit) break;
          const abs = e.abs === '/' ? `/${name}` : `${e.abs}/${name}`;
          const st = await ctx.fs.stat(abs).catch(() => null);
          if (!st) continue;
          const path = e.path.endsWith('/') ? e.path + name : `${e.path}/${name}`;
          await walk({ path, abs, name, depth: e.depth + 1, isDir: st.isDirectory(), size: st.size ?? 0, mtime: +(st.mtime ?? Date.now()), mode: st.mode ?? 0o644 });
        }
      }
      if (depthFirst && !quit) await visit(e);
    };
    for (const p of paths) {
      const abs = ctx.fs.resolvePath(p, ctx.cwd);
      const st = await ctx.fs.stat(abs).catch(() => null);
      if (!st) { ctx.stderr += `find: ‘${p}’: No such file or directory\n`; status = 1; continue; }
      const base = p.replace(/\/+$/, '').split('/').pop() || p;
      await walk({ path: p, abs, name: base, depth: 0, isDir: st.isDirectory(), size: st.size ?? 0, mtime: +(st.mtime ?? Date.now()), mode: st.mode ?? 0o644 });
      if (quit) break;
    }
    for (const b of batches) {
      if (!b.paths.length) continue;
      const hasBraces = b.cmd.includes('{}');
      const words = hasBraces ? b.cmd.flatMap(w => w === '{}' ? b.paths : [w]) : [...b.cmd, ...b.paths];
      if ((await run(words.map(shq).join(' '))) !== 0) status = 1;
    }
    return status;
  },
};

function printfFind(fmt: string, e: Entry): string {
  let out = '';
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c === '\\' && i + 1 < fmt.length) {
      const d = fmt[++i];
      out += ({ n: '\n', t: '\t', '0': '\0', '\\': '\\', a: '\x07', r: '\r' } as any)[d] ?? '\\' + d;
      continue;
    }
    if (c === '%' && i + 1 < fmt.length) {
      const m = /^(-?\d*)([a-zA-Z%])/.exec(fmt.slice(i + 1));
      if (!m) { out += c; continue; }
      i += m[0].length;
      const slash = e.path.lastIndexOf('/');
      const v = ({
        p: e.path, f: e.name, h: slash > 0 ? e.path.slice(0, slash) : slash === 0 ? '/' : '.',
        P: e.path.split('/').slice(1).join('/'), s: String(e.size), d: String(e.depth),
        y: e.isDir ? 'd' : 'f', m: e.isDir ? '755' : '644', '%': '%',
      } as any)[m[2]] ?? '';
      const w = parseInt(m[1] || '0', 10);
      out += w < 0 ? v.padEnd(-w) : v.padStart(w);
      continue;
    }
    out += c;
  }
  return out;
}
