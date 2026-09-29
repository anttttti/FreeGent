import type { Command } from './index';

// GNU basename: NAME [SUFFIX], or -a NAME... / -s SUFFIX NAME... ; -z ends with NUL.
export function baseName(p: string, suffix = ''): string {
  if (p === '') return '';
  const trimmed = p.replace(/\/+$/, '');
  if (trimmed === '') return '/';
  let b = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  if (suffix && b !== suffix && b.endsWith(suffix)) b = b.slice(0, -suffix.length);
  return b;
}

export const basename: Command = {
  name: "basename",
  description: "Strip directory and suffix from filenames",
  async exec(ctx) {
    let multiple = false, suffix = '', zero = false;
    const names: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-a' || a === '--multiple') multiple = true;
      else if (a === '-s' || a === '--suffix') { suffix = args[++i] ?? ''; multiple = true; }
      else if (a.startsWith('--suffix=')) { suffix = a.slice(9); multiple = true; }
      else if (a === '-z' || a === '--zero') zero = true;
      else if (a === '--') { names.push(...args.slice(i + 1)); break; }
      else names.push(a);
    }
    if (!names.length) { ctx.stderr += 'basename: missing operand\n'; return 1; }
    if (!multiple) {
      if (names.length > 2) { ctx.stderr += `basename: extra operand '${names[2]}'\n`; return 1; }
      ctx.stdout += baseName(names[0], names[1] ?? '') + (zero ? '\0' : '\n');
      return 0;
    }
    for (const n of names) ctx.stdout += baseName(n, suffix) + (zero ? '\0' : '\n');
    return 0;
  },
};
