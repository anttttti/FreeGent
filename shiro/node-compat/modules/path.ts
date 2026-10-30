import type { CommandContext } from '../../commands/index';
import { basename, dirname, extname } from '../../utils/posix-path';

export function createPathModule(ctx: CommandContext): any {
  const pathMod: any = {
    join: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
    resolve: (...parts: string[]) => {
      let p = parts.reduce((a, b) => b.startsWith('/') ? b : a + '/' + b);
      return ctx.fs.resolvePath(p, ctx.cwd);
    },
    dirname, basename, extname,   // Node's (codex R191/R192)
    isAbsolute: (p: string) => p.startsWith('/'),
    normalize: (p: string) => ctx.fs.resolvePath(p, '/'),
    relative: (from: string, to: string) => {
      const f = from.split('/').filter(Boolean);
      const t = to.split('/').filter(Boolean);
      let i = 0; while (i < f.length && i < t.length && f[i] === t[i]) i++;
      return [...Array(f.length - i).fill('..'), ...t.slice(i)].join('/') || '.';
    },
    sep: '/',
    delimiter: ':',
    parse: (p: string) => {
      let end = p.length; while (end > 1 && p[end - 1] === '/') end--;
      const slash = p.lastIndexOf('/', end - 1);
      const base = basename(p), ext = extname(p);
      return { root: p.startsWith('/') ? '/' : '', dir: slash > 0 ? p.slice(0, slash) : slash === 0 ? '/' : '', base, ext, name: ext ? base.slice(0, -ext.length) : base };
    },
    format: (obj: any) => (obj.dir ? obj.dir + '/' : '') + (obj.base || obj.name + (obj.ext || '')),
    toNamespacedPath: (p: string) => p,
  };
  pathMod.posix = pathMod;
  pathMod.win32 = pathMod;
  pathMod.default = pathMod;
  return pathMod;
}
