import type { Command } from './index';
import { breToJs } from '../utils/posix-regex';

// GNU expr: | & < <= = == != >= > + - * / % : (anchored BRE match), match, substr, index, length,
// + TOKEN, parentheses. Integers are arbitrary precision. Exit status: 0 when the result is
// neither null nor 0, 1 when it is, 2 for an invalid expression, 3 for other errors.

class ExprError extends Error { constructor(msg: string, public exitCode = 2) { super(msg); } }
type V = string;
const isInt = (s: V) => /^[-+]?\d+$/.test(s);
const toInt = (s: V): bigint => { if (!isInt(s)) throw new ExprError('non-integer argument'); return BigInt(s); };
const isNull = (s: V) => s === '' || (isInt(s) && BigInt(s) === 0n);

function evaluate(tokens: string[]): V {
  let p = 0;
  const peek = () => tokens[p];
  const orE = (): V => { let l = andE(); while (peek() === '|') { p++; const r = andE(); l = isNull(l) ? (isNull(r) ? '0' : r) : l; } return l; };
  const andE = (): V => { let l = cmpE(); while (peek() === '&') { p++; const r = cmpE(); l = isNull(l) || isNull(r) ? '0' : l; } return l; };
  const cmpE = (): V => {
    let l = addE();
    while (['<', '<=', '=', '==', '!=', '>=', '>'].includes(peek())) {
      const op = tokens[p++];
      const r = addE();
      const c = isInt(l) && isInt(r) ? (BigInt(l) < BigInt(r) ? -1 : BigInt(l) > BigInt(r) ? 1 : 0) : (l < r ? -1 : l > r ? 1 : 0);
      const res = op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '=' || op === '==' ? c === 0 : op === '!=' ? c !== 0 : op === '>=' ? c >= 0 : c > 0;
      l = res ? '1' : '0';
    }
    return l;
  };
  const addE = (): V => { let l = mulE(); while (peek() === '+' || peek() === '-') { const op = tokens[p++]; const r = mulE(); l = String(op === '+' ? toInt(l) + toInt(r) : toInt(l) - toInt(r)); } return l; };
  const mulE = (): V => {
    let l = matchE();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = tokens[p++];
      const r = matchE();
      const a = toInt(l), b = toInt(r);
      if (op !== '*' && b === 0n) throw new ExprError('division by zero');
      l = String(op === '*' ? a * b : op === '/' ? a / b : a % b);
    }
    return l;
  };
  const doMatch = (s: V, re: V): V => {
    const m = new RegExp('^(?:' + breToJs(re) + ')', 's').exec(s);
    if (/\\\(/.test(re)) return m ? (m[1] ?? '') : '';
    return String(m ? [...m[0]].length : 0);
  };
  const matchE = (): V => { let l = unary(); while (peek() === ':') { p++; l = doMatch(l, unary()); } return l; };
  const unary = (): V => {
    const t = tokens[p];
    if (t === undefined) throw new ExprError('syntax error: missing argument after ' + (tokens[p - 1] ?? ''));
    if (t === '+' && p + 1 < tokens.length) { p++; return tokens[p++]; }
    if (t === '(') { p++; const v = orE(); if (tokens[p++] !== ')') throw new ExprError("syntax error: expecting ')'"); return v; }
    if (t === 'length' && p + 1 < tokens.length) { p++; return String([...unary()].length); }
    if (t === 'match' && p + 2 < tokens.length) { p++; const s = unary(); return doMatch(s, unary()); }
    if (t === 'index' && p + 2 < tokens.length) {
      p++; const s = [...unary()], chars = unary();
      const k = s.findIndex(c => chars.includes(c));
      return String(k + 1);
    }
    if (t === 'substr' && p + 3 < tokens.length) {
      p++; const s = [...unary()]; const pos = toInt(unary()), len = toInt(unary());
      if (pos < 1n || len < 1n) return '';
      return s.slice(Number(pos) - 1, Number(pos) - 1 + Number(len)).join('');
    }
    p++;
    return t;
  };
  const v = orE();
  if (p < tokens.length) throw new ExprError(`syntax error: unexpected argument '${tokens[p]}'`);
  return v;
}

export const expr: Command = {
  name: "expr",
  description: "Evaluate expressions",
  async exec(ctx) {
    const args = ctx.args[0] === '--' ? ctx.args.slice(1) : ctx.args;
    if (!args.length) { ctx.stderr += 'expr: missing operand\n'; return 2; }
    try {
      const v = evaluate(args);
      ctx.stdout += v + '\n';
      return isNull(v) ? 1 : 0;
    } catch (e: any) {
      if (e instanceof ExprError) { ctx.stderr += `expr: ${e.message}\n`; return e.exitCode; }
      throw e;
    }
  },
};
