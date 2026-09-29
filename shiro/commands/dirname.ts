import type { Command } from './index';

// GNU dirname: each NAME without its last component ("." when there is no slash).
export function dirName(p: string): string {
  const t = p.replace(/\/+$/, '');
  if (t === '') return p.startsWith('/') ? '/' : '.';
  const k = t.lastIndexOf('/');
  if (k < 0) return '.';
  const d = t.slice(0, k).replace(/\/+$/, '');
  return d === '' ? '/' : d;
}

export const dirname: Command = {
  name: "dirname",
  description: "Strip last component from file name",
  async exec(ctx) {
    const zero = ctx.args.includes('-z') || ctx.args.includes('--zero');
    const names = ctx.args.filter(a => a !== '-z' && a !== '--zero' && a !== '--');
    if (!names.length) { ctx.stderr += 'dirname: missing operand\n'; return 1; }
    for (const n of names) ctx.stdout += dirName(n) + (zero ? '\0' : '\n');
    return 0;
  },
};
