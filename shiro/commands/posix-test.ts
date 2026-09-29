
import type { Command, CommandContext } from './index';

// test / [: POSIX rules for up to four arguments, then a full grammar (! -a -o parentheses,
// -a binding tighter than -o). String tests -z -n = != < >, integer tests -eq -ne -lt -le -gt
// -ge ("integer expression expected" otherwise, exit 2), file tests -e -f -d -s -r -w -x -L -h
// -nt -ot -ef, -v VAR. `[` needs its closing `]`.
class TestError extends Error {}

const UNARY = new Set(['-z', '-n', '-e', '-f', '-d', '-s', '-r', '-w', '-x', '-L', '-h', '-S', '-p', '-b', '-c', '-g', '-u', '-k', '-O', '-G', '-N', '-t', '-v', '-a']);
const BINARY = new Set(['=', '==', '!=', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot', '-ef']);

function toInt(s: string): bigint {
  if (!/^\s*[-+]?\d+\s*$/.test(s)) throw new TestError(`${s}: integer expression expected`);
  return BigInt(s.trim());
}

async function unary(ctx: CommandContext, op: string, v: string): Promise<boolean> {
  if (op === '-z') return v === '';
  if (op === '-n') return v !== '';
  if (op === '-t') return false;
  if (op === '-v') return v in (ctx.env ?? {});
  let st: any;
  try { st = await ctx.fs.stat(ctx.fs.resolvePath(v, ctx.cwd)); } catch { return false; }
  switch (op) {
    case '-f': return !st.isDirectory();
    case '-d': return st.isDirectory();
    case '-s': return !st.isDirectory() && (st.size ?? 0) > 0;
    case '-L': case '-h': return typeof st.isSymbolicLink === 'function' && st.isSymbolicLink();
    case '-S': case '-p': case '-b': case '-c': case '-g': case '-u': case '-k': return false;
    default: return true;   // -e -a -r -w -x -O -G -N
  }
}

async function binary(ctx: CommandContext, l: string, op: string, r: string): Promise<boolean> {
  switch (op) {
    case '=': case '==': return l === r;
    case '!=': return l !== r;
    case '<': return l < r;
    case '>': return l > r;
    case '-eq': return toInt(l) === toInt(r);
    case '-ne': return toInt(l) !== toInt(r);
    case '-lt': return toInt(l) < toInt(r);
    case '-le': return toInt(l) <= toInt(r);
    case '-gt': return toInt(l) > toInt(r);
    case '-ge': return toInt(l) >= toInt(r);
    case '-nt': case '-ot': {
      const m = async (f: string) => { try { return +(await ctx.fs.stat(ctx.fs.resolvePath(f, ctx.cwd))).mtime; } catch { return null; } };
      const a = await m(l), b = await m(r);
      if (a === null || b === null) return op === '-nt' ? a !== null : b !== null;
      return op === '-nt' ? a > b : a < b;
    }
    case '-ef': return ctx.fs.resolvePath(l, ctx.cwd) === ctx.fs.resolvePath(r, ctx.cwd);
  }
  throw new TestError(`${op}: binary operator expected`);
}

async function evaluate(ctx: CommandContext, a: string[]): Promise<boolean> {
  // POSIX: decided by the argument count first.
  switch (a.length) {
    case 0: return false;
    case 1: return a[0] !== '';
    case 2:
      if (a[0] === '!') return a[1] === '';
      if (UNARY.has(a[0])) return unary(ctx, a[0], a[1]);
      throw new TestError(`${a[0]}: unary operator expected`);
    case 3:
      if (BINARY.has(a[1])) return binary(ctx, a[0], a[1], a[2]);
      if (a[1] === '-a') return a[0] !== '' && a[2] !== '';
      if (a[1] === '-o') return a[0] !== '' || a[2] !== '';
      if (a[0] === '!') return !(await evaluate(ctx, a.slice(1)));
      if (a[0] === '(' && a[2] === ')') return a[1] !== '';
      throw new TestError(`${a[1]}: binary operator expected`);
    case 4:
      if (a[0] === '!') return !(await evaluate(ctx, a.slice(1)));
      if (a[0] === '(' && a[3] === ')') return evaluate(ctx, a.slice(1, 3));
  }
  // Full grammar
  let p = 0;
  const orE = async (): Promise<boolean> => { let v = await andE(); while (a[p] === '-o') { p++; const r = await andE(); v = v || r; } return v; };
  const andE = async (): Promise<boolean> => { let v = await notE(); while (a[p] === '-a') { p++; const r = await notE(); v = v && r; } return v; };
  const notE = async (): Promise<boolean> => {
    if (a[p] === '!') { p++; return !(await notE()); }
    if (a[p] === '(') { p++; const v = await orE(); if (a[p++] !== ')') throw new TestError("missing ')'"); return v; }
    if (UNARY.has(a[p]) && p + 1 < a.length && !(BINARY.has(a[p + 1]) && p + 2 < a.length)) { const op = a[p++]; return unary(ctx, op, a[p++]); }
    if (p + 2 < a.length + 0 && BINARY.has(a[p + 1])) { const l = a[p]; const op = a[p + 1]; const r = a[p + 2]; p += 3; return binary(ctx, l, op, r); }
    if (p >= a.length) throw new TestError('argument expected');
    return a[p++] !== '';
  };
  const v = await orE();
  if (p < a.length) throw new TestError(`${a[p]}: unexpected operator`);
  return v;
}

export const test: Command = {
  name: "test",
  description: "Evaluate conditional expression",
  async exec(ctx) {
    try {
      return (await evaluate(ctx, ctx.args)) ? 0 : 1;
    } catch (e: unknown) {
      ctx.stderr += `test: ${e instanceof Error ? e.message : e}\n`;
      return 2;
    }
  },
};

/** `[ … ]`: the same, with the closing `]` required. */
export const bracket: Command = {
  name: '[',
  description: 'Evaluate conditional expression',
  async exec(ctx) {
    if (ctx.args[ctx.args.length - 1] !== ']') { ctx.stderr += "[: missing `]'\n"; return 2; }
    try {
      return (await evaluate(ctx, ctx.args.slice(0, -1))) ? 0 : 1;
    } catch (e: unknown) {
      ctx.stderr += `[: ${e instanceof Error ? e.message : e}\n`;
      return 2;
    }
  },
};
