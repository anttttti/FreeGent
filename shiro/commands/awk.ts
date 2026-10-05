import type { Command, CommandContext } from './index';
import { ereToJs } from '../utils/posix-regex';

// POSIX awk (with the common mawk/gawk extensions): lexer, parser and an evaluator following awk's
// value rules — numbers, strings and "strnums" (input that looks numeric compares as a number).
// Supports patterns and ranges, BEGIN/END, functions, arrays (incl. SUBSEP keys), getline in
// all forms, print/printf with > >> | redirection, and the POSIX built-ins.

// ─── Values ──────────────────────────────────────────────────────────────────

class StrNum { constructor(public s: string, public n: number) {} }
type Val = number | string | StrNum;
const UNINIT = new StrNum('', 0);

const NUMERIC_RE = /^[ \t\n]*[-+]?(?:\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)[ \t\n]*$/;
/** An input-derived value: a strnum when it looks numeric. */
const input = (s: string): Val => NUMERIC_RE.test(s) ? new StrNum(s, parseFloat(s)) : s;

function strtod(s: string): number {
  const m = /^[ \t\n]*[-+]?(?:\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)/.exec(s);
  return m ? parseFloat(m[0]) : 0;
}
const num = (v: Val): number => typeof v === 'number' ? v : v instanceof StrNum ? v.n : strtod(v);

// Numbers print as integers only within 32 bits, as mawk (Ubuntu's awk) does; larger ones use
// OFMT/CONVFMT ("2^31" prints as 2.14748e+09).
const MAX_INT = 2147483647;
function numToStr(n: number, fmt: string): string {
  if (Number.isInteger(n) && n >= -MAX_INT && n <= MAX_INT) return String(n);
  if (!isFinite(n)) return isNaN(n) ? 'nan' : n > 0 ? 'inf' : '-inf';
  return sprintf(fmt, [n]);
}

// ─── printf ──────────────────────────────────────────────────────────────────

function fmtExp(n: number, prec: number, upper: boolean): string {
  let s = n.toExponential(prec);
  s = s.replace(/e([+-])(\d)$/, 'e$10$2');
  return upper ? s.toUpperCase() : s;
}
function fmtG(n: number, prec: number, alt: boolean, upper: boolean): string {
  if (n === 0) return alt ? (0).toFixed(Math.max(prec - 1, 0)) : '0';
  const p = prec === 0 ? 1 : prec;
  const exp = parseInt(n.toExponential(p - 1).split('e')[1], 10);
  let s: string;
  if (exp < -4 || exp >= p) {
    s = fmtExp(n, p - 1, upper);
    if (!alt) s = s.replace(/\.?0+(e)/i, '$1');
  } else {
    s = n.toFixed(Math.max(p - 1 - exp, 0));
    if (!alt && s.includes('.')) s = s.replace(/\.?0+$/, '');
  }
  return s;
}

export class MissingArgs extends Error { constructor(public partial: string) { super('not enough arguments passed to printf'); } }

export function sprintf(fmt: string, args: Val[], toStr: (v: Val) => string = v => typeof v === 'number' ? numToStr(v, '%.6g') : v instanceof StrNum ? v.s : v, strictArgs = false): string {
  let out = '';
  let ai = 0;
  const next = (): Val => {
    if (ai < args.length) return args[ai++];
    if (strictArgs) throw new MissingArgs(out);
    return UNINIT;
  };
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c !== '%') { out += c; continue; }
    const m = /^%([-+ #0]*)(\*|\d+)?(?:\.(\*|\d*))?([a-zA-Z%])/.exec(fmt.slice(i));
    if (!m) { out += c; continue; }
    i += m[0].length - 1;
    const flags = m[1];
    let width = m[2] === '*' ? num(next()) : m[2] ? parseInt(m[2], 10) : 0;
    let left = flags.includes('-');
    if (width < 0) { left = true; width = -width; }
    const precRaw = m[3] === '*' ? String(num(next())) : m[3];
    const prec = precRaw === undefined ? undefined : precRaw === '' ? 0 : parseInt(precRaw, 10);
    const conv = m[4];
    if (conv === '%') { out += '%'; continue; }
    let body = '';
    let numeric = false;
    let sign = '';
    switch (conv) {
      case 'c': {
        // A number prints the character with that code; a string its first character.
        const v = next();
        body = typeof v === 'number' ? String.fromCharCode(v) : v instanceof StrNum && v !== UNINIT ? String.fromCharCode(v.n) : toStr(v).slice(0, 1);
        break;
      }
      case 's': { body = toStr(next()); if (prec !== undefined) body = body.slice(0, prec); break; }
      case 'd': case 'i': case 'o': case 'x': case 'X': case 'u': {
        numeric = true;
        let n = Math.trunc(num(next()));
        if (conv === 'd' || conv === 'i') n = Math.max(-MAX_INT - 1, Math.min(MAX_INT, n));   // mawk: C int
        if (n < 0 && conv !== 'd' && conv !== 'i') n = n >>> 0;
        if (n < 0) { sign = '-'; n = -n; } else if (flags.includes('+')) sign = '+'; else if (flags.includes(' ')) sign = ' ';
        body = conv === 'o' ? n.toString(8) : conv === 'x' ? n.toString(16) : conv === 'X' ? n.toString(16).toUpperCase() : String(n);
        if (prec !== undefined) body = prec === 0 && n === 0 ? '' : body.padStart(prec, '0');
        if (flags.includes('#') && n !== 0) body = (conv === 'o' ? '0' : conv === 'x' ? '0x' : conv === 'X' ? '0X' : '') + body;
        break;
      }
      case 'e': case 'E': case 'f': case 'F': case 'g': case 'G': {
        numeric = true;
        let n = num(next());
        if (n < 0 || Object.is(n, -0)) { sign = '-'; n = -n; } else if (flags.includes('+')) sign = '+'; else if (flags.includes(' ')) sign = ' ';
        const p = prec ?? 6;
        if (!isFinite(n)) body = isNaN(n) ? 'nan' : 'inf';
        else if (conv === 'f' || conv === 'F') body = n.toFixed(p);
        else if (conv === 'e' || conv === 'E') body = fmtExp(n, p, conv === 'E');
        else body = fmtG(n, p, flags.includes('#'), conv === 'G');
        break;
      }
      default: out += m[0]; continue;
    }
    const zero = numeric && flags.includes('0') && !left && !(prec !== undefined && 'diouxX'.includes(conv));
    let full = sign + body;
    if (full.length < width) {
      full = left ? full.padEnd(width) : zero ? sign + body.padStart(width - sign.length, '0') : full.padStart(width);
    }
    out += full;
  }
  return out;
}

// ─── Lexer ───────────────────────────────────────────────────────────────────

type Tok = { t: string; v?: any; line: number };
const KEYWORDS = new Set(['BEGIN', 'END', 'function', 'func', 'if', 'else', 'while', 'for', 'do', 'break', 'continue',
  'next', 'nextfile', 'exit', 'return', 'delete', 'in', 'getline', 'print', 'printf']);
const BUILTINS = new Set(['length', 'substr', 'index', 'split', 'sub', 'gsub', 'match', 'sprintf', 'sin', 'cos', 'atan2',
  'exp', 'log', 'sqrt', 'int', 'rand', 'srand', 'tolower', 'toupper', 'system', 'close', 'fflush']);

class AwkError extends Error {}

function unescapeStr(s: string): string {
  return s.replace(/\\(?:([0-7]{1,3})|x([0-9a-fA-F]{1,2})|(.))/gs, (_m, oct, hex, c) => {
    if (oct) return String.fromCharCode(parseInt(oct, 8));
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    return ({ n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', '/': '/', a: '\x07', b: '\b', f: '\f', v: '\v' } as any)[c] ?? '\\' + c;
  });
}

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0, line = 1;
  const push = (t: string, v?: any) => toks.push({ t, v, line });
  const operandEnd = () => {
    const p = toks[toks.length - 1];
    return !!p && (['NUMBER', 'STRING', 'ERE', 'NAME', 'FUNC_NAME', 'BUILTIN', ')', ']', '$', 'INCR', 'DECR'].includes(p.t));
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && src[i + 1] === '\n') { i += 2; line++; continue; }
    if (c === '\\' && src[i + 1] === '\r' && src[i + 2] === '\n') { i += 3; line++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '\n') { push('NEWLINE'); i++; line++; continue; }
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\' && j + 1 < src.length) { s += src[j] + src[j + 1]; j += 2; } else s += src[j++]; }
      push('STRING', unescapeStr(s)); i = j + 1; continue;
    }
    if (c === '/' && !operandEnd()) {
      let j = i + 1, s = '', inBr = false;
      while (j < src.length && (src[j] !== '/' || inBr) && src[j] !== '\n') {
        if (src[j] === '\\' && j + 1 < src.length) { s += src[j + 1] === '/' ? '/' : src[j] + src[j + 1]; j += 2; continue; }
        if (src[j] === '[') inBr = true; else if (src[j] === ']' && inBr) inBr = false;
        s += src[j++];
      }
      push('ERE', s); i = j + 1; continue;
    }
    const numM = /^(?:\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)/.exec(src.slice(i));
    if (numM) { push('NUMBER', parseFloat(numM[0])); i += numM[0].length; continue; }
    const idM = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (idM) {
      const w = idM[0];
      i += w.length;
      if (KEYWORDS.has(w)) push(w === 'func' ? 'function' : w);
      else if (BUILTINS.has(w)) push('BUILTIN', w);
      else if (src[i] === '(') push('FUNC_NAME', w);
      else push('NAME', w);
      continue;
    }
    const ops = ['**=', '^=', '+=', '-=', '*=', '/=', '%=', '==', '<=', '>=', '!=', '++', '--', '&&', '||', '>>', '!~', '**'];
    const op = ops.find(o => src.startsWith(o, i));
    if (op) {
      i += op.length;
      if (op === '++') push('INCR'); else if (op === '--') push('DECR');
      else if (op === '**') push('^'); else if (op === '**=') push('^='); else push(op);
      continue;
    }
    if ('{}()[];,+-*/%^!><|?:~$='.includes(c)) { push(c); i++; continue; }
    throw new AwkError(`syntax error at source line ${line}: unexpected character '${c}'`);
  }
  push('EOF');
  return toks;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

type Node = any;

function parse(src: string) {
  const toks = lex(src);
  let p = 0;
  const peek = (k = 0) => toks[p + k];
  const at = (t: string) => toks[p].t === t;
  const eat = (t: string) => { if (!at(t)) throw new AwkError(`syntax error at source line ${toks[p].line}: expected '${t}' near '${toks[p].v ?? toks[p].t}'`); return toks[p++]; };
  const opt = (t: string) => at(t) ? toks[p++] : null;
  const nl = () => { while (at('NEWLINE')) p++; };
  const term = () => { while (at('NEWLINE') || at(';')) p++; };

  const program: { begin: Node[]; end: Node[]; rules: Node[]; funcs: Map<string, Node> } = { begin: [], end: [], rules: [], funcs: new Map() };

  // Expressions, lowest precedence first. noIn: inside for(...;...;...) init; noGt: in print args.
  const expr = (noGt = false, noIn = false): Node => ternary(noGt, noIn);
  const ternary = (noGt: boolean, noIn: boolean): Node => {
    const c = orExpr(noGt, noIn);
    if (opt('?')) { nl(); const a = ternary(noGt, noIn); nl(); eat(':'); nl(); const b = ternary(noGt, noIn); return { k: '?:', c, a, b }; }
    if (['=', '+=', '-=', '*=', '/=', '%=', '^='].includes(peek().t) && isLvalue(c)) {
      const op = toks[p++].t; nl();
      return { k: 'assign', op, target: c, value: ternary(noGt, noIn) };
    }
    return c;
  };
  const isLvalue = (n: Node) => n.k === 'var' || n.k === 'index' || n.k === 'field';
  const orExpr = (noGt: boolean, noIn: boolean): Node => {
    let l = andExpr(noGt, noIn);
    while (at('||')) { p++; nl(); l = { k: '||', l, r: andExpr(noGt, noIn) }; }
    return l;
  };
  const andExpr = (noGt: boolean, noIn: boolean): Node => {
    let l = inExpr(noGt, noIn);
    while (at('&&')) { p++; nl(); l = { k: '&&', l, r: inExpr(noGt, noIn) }; }
    return l;
  };
  const inExpr = (noGt: boolean, noIn: boolean): Node => {
    let l = matchExpr(noGt, noIn);
    while (!noIn && at('in')) { p++; l = { k: 'in', keys: [l], arr: eat('NAME').v }; }
    return l;
  };
  const matchExpr = (noGt: boolean, noIn: boolean): Node => {
    let l = cmpExpr(noGt, noIn);
    while (at('~') || at('!~')) { const op = toks[p++].t; l = { k: op, l, r: cmpExpr(noGt, noIn) }; }
    return l;
  };
  const cmpExpr = (noGt: boolean, noIn: boolean): Node => {
    const l = concatExpr(noIn);
    const t = peek().t;
    if (['<', '<=', '!=', '==', '>=', '>'].includes(t) && !(noGt && t === '>')) {
      p++;
      return { k: 'cmp', op: t, l, r: concatExpr(noIn) };
    }
    return l;
  };
  const startsOperand = (t: string) => ['NUMBER', 'STRING', 'ERE', 'NAME', 'FUNC_NAME', 'BUILTIN', '$', '!', '(', 'INCR', 'DECR', '-', '+'].includes(t);
  const concatExpr = (noIn: boolean): Node => {
    let l = additive();
    for (;;) {
      if (at('|') && peek(1).t === 'getline') {
        p += 2;
        const v = at('NAME') || at('$') ? lvalueSimple() : undefined;
        l = { k: 'getline', src: 'cmd', cmd: l, target: v };
        continue;
      }
      const t = peek().t;
      if (t === 'in' && noIn) break;
      if (!startsOperand(t) || t === '-' || t === '+') break;
      l = { k: 'concat', l, r: additive() };
    }
    return l;
  };
  const additive = (): Node => {
    let l = multiplicative();
    while (at('+') || at('-')) { const op = toks[p++].t; l = { k: 'bin', op, l, r: multiplicative() }; }
    return l;
  };
  const multiplicative = (): Node => {
    let l = unary();
    while (at('*') || at('/') || at('%')) { const op = toks[p++].t; l = { k: 'bin', op, l, r: unary() }; }
    return l;
  };
  const unary = (): Node => {
    if (at('!')) { p++; return { k: 'not', e: unary() }; }
    if (at('-')) { p++; return { k: 'neg', e: unary() }; }
    if (at('+')) { p++; return { k: 'pos', e: unary() }; }
    return power();
  };
  const power = (): Node => {
    const base = postfix();
    if (at('^')) { p++; return { k: 'bin', op: '^', l: base, r: unaryForPower() }; }
    return base;
  };
  const unaryForPower = (): Node => {
    if (at('-')) { p++; return { k: 'neg', e: unaryForPower() }; }
    if (at('+')) { p++; return { k: 'pos', e: unaryForPower() }; }
    if (at('!')) { p++; return { k: 'not', e: unaryForPower() }; }
    return power();
  };
  const postfix = (): Node => {
    if (at('INCR') || at('DECR')) { const op = toks[p++].t; return { k: 'preinc', op, target: lvalueSimple() }; }
    const e = primary();
    if (isLvalue(e) && (at('INCR') || at('DECR'))) { const op = toks[p++].t; return { k: 'postinc', op, target: e }; }
    return e;
  };
  const lvalueSimple = (): Node => {
    if (at('$')) { p++; return { k: 'field', e: fieldOperand() }; }
    const name = eat('NAME').v;
    if (at('[')) { p++; const keys = exprList(); eat(']'); return { k: 'index', arr: name, keys }; }
    return { k: 'var', name };
  };
  const fieldOperand = (): Node => {
    if (at('INCR') || at('DECR')) { const op = toks[p++].t; return { k: 'preinc', op, target: lvalueSimple() }; }
    if (at('-')) { p++; return { k: 'neg', e: fieldOperand() }; }
    return primary();
  };
  const exprList = (): Node[] => { const l = [expr()]; while (opt(',')) { nl(); l.push(expr()); } return l; };
  const primary = (): Node => {
    const t = toks[p];
    switch (t.t) {
      case 'NUMBER': p++; return { k: 'num', v: t.v };
      case 'STRING': p++; return { k: 'str', v: t.v };
      case 'ERE': p++; return { k: 'regex', src: t.v };
      case '$': p++; return { k: 'field', e: fieldOperand() };
      case '(': {
        p++;
        const first = expr();
        if (at(',')) {
          const list = [first];
          while (opt(',')) { nl(); list.push(expr()); }
          eat(')');
          if (at('in')) { p++; return { k: 'in', keys: list, arr: eat('NAME').v }; }
          return { k: 'group', list };
        }
        eat(')');
        return { k: 'paren', e: first };
      }
      case 'getline': {
        p++;
        const target = at('NAME') || at('$') ? lvalueSimple() : undefined;
        if (at('<')) { p++; return { k: 'getline', src: 'file', file: concatPrimary(), target }; }
        return { k: 'getline', src: 'main', target };
      }
      case 'FUNC_NAME': {
        p++; eat('(');
        const args = at(')') ? [] : exprList();
        eat(')');
        return { k: 'call', name: t.v, args };
      }
      case 'BUILTIN': {
        p++;
        if (at('(')) {
          p++;
          const args = at(')') ? [] : exprList();
          eat(')');
          return { k: 'builtin', name: t.v, args };
        }
        if (t.v === 'length') return { k: 'builtin', name: 'length', args: [] };
        throw new AwkError(`syntax error at source line ${t.line}: ${t.v} needs arguments`);
      }
      case 'NAME': {
        p++;
        if (at('[')) { p++; const keys = exprList(); eat(']'); return { k: 'index', arr: t.v, keys }; }
        return { k: 'var', name: t.v };
      }
      case '-': p++; return { k: 'neg', e: primary() };
      case '!': p++; return { k: 'not', e: primary() };
    }
    throw new AwkError(`syntax error at source line ${t.line} near '${t.v ?? t.t}'`);
  };
  // After "getline <": a primary with no concatenation (as in awk's grammar).
  const concatPrimary = (): Node => primary();

  // Statements
  const simpleStatement = (): Node => {
    const t = peek().t;
    if (t === 'print' || t === 'printf') {
      p++;
      let args: Node[] = [];
      if (at('(')) {
        // print (a, b) > f — a parenthesised list, if a terminator or redirection follows it.
        let depth = 0, q = p;
        for (; q < toks.length; q++) { if (toks[q].t === '(') depth++; else if (toks[q].t === ')' && --depth === 0) break; }
        const after = toks[q + 1]?.t;
        if (['NEWLINE', ';', '}', '>', '>>', '|', 'EOF'].includes(after)) {
          p++;
          args = at(')') ? [] : [expr(), ...(() => { const r: Node[] = []; while (opt(',')) { nl(); r.push(expr()); } return r; })()];
          eat(')');
        }
      }
      if (!args.length && !['NEWLINE', ';', '}', '>', '>>', '|', 'EOF'].includes(peek().t)) {
        args = [expr(true)];
        while (opt(',')) { nl(); args.push(expr(true)); }
      }
      let redir: Node | undefined;
      if (at('>') || at('>>') || at('|')) { const op = toks[p++].t; redir = { op, target: concatExpr(false) }; }
      return { k: t, args, redir };
    }
    if (t === 'delete') {
      p++;
      const name = eat('NAME').v;
      if (at('[')) { p++; const keys = exprList(); eat(']'); return { k: 'delete', arr: name, keys }; }
      return { k: 'delete', arr: name };
    }
    if (t === 'next') { p++; return { k: 'next' }; }
    if (t === 'nextfile') { p++; return { k: 'nextfile' }; }
    if (t === 'exit') { p++; return { k: 'exit', e: ['NEWLINE', ';', '}', 'EOF'].includes(peek().t) ? undefined : expr() }; }
    if (t === 'return') { p++; return { k: 'return', e: ['NEWLINE', ';', '}', 'EOF'].includes(peek().t) ? undefined : expr() }; }
    if (t === 'break') { p++; return { k: 'break' }; }
    if (t === 'continue') { p++; return { k: 'continue' }; }
    return { k: 'expr', e: expr() };
  };
  const statement = (): Node => {
    const t = peek().t;
    if (t === '{') { p++; const body = statements(); eat('}'); return { k: 'block', body }; }
    if (t === 'if') {
      p++; eat('('); const c = expr(); eat(')'); nl();
      const a = statement();
      const save = p;
      term();
      if (at('else')) { p++; nl(); return { k: 'if', c, a, b: statement() }; }
      p = save;
      return { k: 'if', c, a };
    }
    if (t === 'while') {
      p++; eat('('); const c = expr(); eat(')');
      if (at(';')) { p++; return { k: 'while', c, body: { k: 'block', body: [] } }; }
      nl(); return { k: 'while', c, body: statement() };
    }
    if (t === 'do') {
      p++; nl(); const body = statement(); term(); eat('while'); eat('('); const c = expr(); eat(')');
      return { k: 'do', c, body };
    }
    if (t === 'for') {
      p++; eat('(');
      if (at('NAME') && peek(1).t === 'in' && peek(2).t === 'NAME' && peek(3).t === ')') {
        const v = toks[p].v; p += 2; const arr = toks[p].v; p += 2; nl();
        return { k: 'forin', v, arr, body: statement() };
      }
      const init = at(';') ? undefined : simpleStatement(); eat(';'); nl();
      const c = at(';') ? undefined : expr(); eat(';'); nl();
      const step = at(')') ? undefined : simpleStatement(); eat(')');
      if (at(';')) { p++; return { k: 'for', init, c, step, body: { k: 'block', body: [] } }; }
      nl();
      return { k: 'for', init, c, step, body: statement() };
    }
    if (t === ';') { p++; return { k: 'block', body: [] }; }
    const s = simpleStatement();
    if (!at('}') && !at('EOF')) { if (!at(';') && !at('NEWLINE')) throw new AwkError(`syntax error at source line ${peek().line} near '${peek().v ?? peek().t}'`); }
    return s;
  };
  const statements = (): Node[] => {
    const out: Node[] = [];
    term();
    while (!at('}') && !at('EOF')) { out.push(statement()); term(); }
    return out;
  };
  const action = (): Node[] => { eat('{'); const body = statements(); eat('}'); return body; };

  term();
  while (!at('EOF')) {
    if (at('BEGIN')) { p++; nl(); program.begin.push(...action()); }
    else if (at('END')) { p++; nl(); program.end.push(...action()); }
    else if (at('function')) {
      p++;
      const name = at('FUNC_NAME') || at('NAME') ? toks[p++].v : eat('NAME').v;
      eat('(');
      const params: string[] = [];
      while (!at(')')) { params.push(eat('NAME').v); if (!opt(',')) break; nl(); }
      eat(')'); nl();
      program.funcs.set(name, { params, body: action() });
    } else {
      let pattern: Node | undefined, pattern2: Node | undefined;
      if (!at('{')) {
        pattern = expr();
        if (opt(',')) { nl(); pattern2 = expr(); }
      }
      const body = at('{') ? action() : undefined;
      program.rules.push({ pattern, pattern2, body, inRange: false });
    }
    term();
  }
  return program;
}

// ─── Interpreter ─────────────────────────────────────────────────────────────

class NextSignal {}
class NextFileSignal {}
class ExitSignal { constructor(public code: number) {} }
class ReturnSignal { constructor(public v: Val) {} }
class BreakSignal {}
class ContinueSignal {}

interface Stream { lines: string[]; pos: number }

async function runAwk(ctx: CommandContext, src: string, operands: string[], assigns: [string, string][]): Promise<number> {
  const prog = parse(src);
  const vars = new Map<string, Val>();
  const arrays = new Map<string, Map<string, Val>>();
  const env = new Map<string, Val>(Object.entries(ctx.env || {}).map(([k, v]) => [k, input(String(v))]));
  arrays.set('ENVIRON', env);
  const argv = new Map<string, Val>([['0', 'awk'], ...operands.map((o, k) => [String(k + 1), input(o)] as [string, Val])]);
  arrays.set('ARGV', argv);
  const setVar = (k: string, v: Val) => vars.set(k, v);
  for (const [k, v] of [['FS', ' '], ['OFS', ' '], ['ORS', '\n'], ['RS', '\n'], ['SUBSEP', '\x1c'], ['CONVFMT', '%.6g'], ['OFMT', '%.6g'], ['FILENAME', '']] as [string, string][]) setVar(k, v);
  for (const k of ['NR', 'FNR', 'NF', 'RSTART', 'RLENGTH']) setVar(k, 0);
  setVar('ARGC', operands.length + 1);
  setVar('RLENGTH', -1);

  const getVar = (k: string): Val => vars.has(k) ? vars.get(k)! : UNINIT;
  const str = (v: Val): string => typeof v === 'number' ? numToStr(v, String(getVar('CONVFMT') instanceof StrNum ? (getVar('CONVFMT') as StrNum).s : getVar('CONVFMT'))) : v instanceof StrNum ? v.s : v;
  const outStr = (v: Val): string => typeof v === 'number' ? numToStr(v, str(getVar('OFMT'))) : str(v);
  const bool = (v: Val): boolean => typeof v === 'number' ? v !== 0 : v instanceof StrNum ? (v === UNINIT ? false : v.n !== 0) : v !== '';
  const isNumeric = (v: Val) => typeof v === 'number' || v instanceof StrNum;

  // Fields
  let record = '';
  let fields: string[] = [];
  const splitRecord = (s: string, fsVal: string): string[] => {
    if (s === '') return [];
    if (fsVal === ' ') return s.split(/[ \t\n]+/).filter(Boolean);
    if (fsVal.length === 1 && fsVal !== '\\') return s.split(fsVal);
    if (fsVal === '') return [...s];
    return s.split(new RegExp(ereToJs(fsVal)));
  };
  const setRecord = (s: string) => { record = s; fields = splitRecord(s, str(getVar('FS'))); vars.set('NF', fields.length); };
  const rebuild = () => { record = fields.join(str(getVar('OFS'))); };
  const getField = (i: number): Val => {
    if (i < 0) throw new AwkError(`trying to access out of range field ${i}`);
    if (i === 0) return input(record);
    return i <= fields.length ? input(fields[i - 1]) : UNINIT;
  };
  const setField = (i: number, v: string) => {
    if (i === 0) { setRecord(v); return; }
    while (fields.length < i) fields.push('');
    fields[i - 1] = v;
    vars.set('NF', fields.length);
    rebuild();
  };

  // Regex cache
  const reCache = new Map<string, RegExp>();
  const toRegex = (src: string, flags = ''): RegExp => {
    const key = flags + '\0' + src;
    let r = reCache.get(key);
    if (!r) { r = new RegExp(ereToJs(src), flags); reCache.set(key, r); }
    return r;
  };
  const regexOf = async (n: Node, scope: Scope): Promise<RegExp> => n.k === 'regex' ? toRegex(n.src) : toRegex(str(await ev(n, scope)));

  // Input: main records from operands (files, var=value assignments) or stdin.
  const splitRecords = (text: string): string[] => {
    const rs = str(getVar('RS'));
    if (text === '') return [];
    if (rs === '\n') { const l = text.split('\n'); if (text.endsWith('\n')) l.pop(); return l; }
    if (rs === '') return text.replace(/^\n+/, '').split(/\n\n+/).map(r => r.replace(/\n+$/, '')).filter(r => r !== '');
    const parts = rs.length === 1 ? text.split(rs) : text.split(toRegex(rs));
    if (parts[parts.length - 1] === '' || parts[parts.length - 1] === '\n') parts.pop();
    return parts;
  };
  const readText = async (f: string): Promise<string | null> => {
    if (f === '-' || f === '/dev/stdin') return ctx.stdin;
    try { return await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd), 'utf8') as string; } catch { return null; }
  };
  let opIndex = 0;
  let mainStream: Stream | null = null;
  let usedStdin = false;
  let status = 0;
  const nextMainRecord = async (): Promise<string | null> => {
    for (;;) {
      if (mainStream && mainStream.pos < mainStream.lines.length) return mainStream.lines[mainStream.pos++];
      // Next operand
      const argc = num(getVar('ARGC'));
      let opened = false;
      while (opIndex + 1 < argc) {
        opIndex++;
        const a = str(argv.get(String(opIndex)) ?? '');
        if (a === '') continue;
        const asg = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(a);
        if (asg) { setVar(asg[1], input(unescapeStr(asg[2]))); continue; }
        const text = await readText(a);
        if (text === null) { ctx.stderr += `awk: cannot open ${a} (No such file or directory)\n`; status = 2; continue; }
        setVar('FILENAME', a);
        vars.set('FNR', 0);
        mainStream = { lines: splitRecords(text), pos: 0 };
        opened = true;
        break;
      }
      if (!opened) {
        const hasFile = [...Array(Math.max(0, num(getVar('ARGC')) - 1)).keys()].some(k => { const a = str(argv.get(String(k + 1)) ?? ''); return a !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(a); });
        if (!hasFile && !usedStdin) {
          usedStdin = true;
          mainStream = { lines: splitRecords(ctx.stdin), pos: 0 };
          continue;
        }
        return null;
      }
    }
  };

  // Output: stdout, files (> >>), and pipes (| cmd, run when closed or at the end).
  const files = new Map<string, { mode: string; text: string }>();
  const pipesOut = new Map<string, string>();
  const readStreams = new Map<string, Stream>();
  const write = async (text: string, redir: Node | undefined, scope: Scope) => {
    if (!redir) { ctx.stdout += text; return; }
    const target = str(await ev(redir.target, scope));
    if (redir.op === '|') { pipesOut.set(target, (pipesOut.get(target) ?? '') + text); return; }
    if (target === '/dev/stdout' || target === '-') { ctx.stdout += text; return; }
    if (target === '/dev/stderr') { ctx.stderr += text; return; }
    const f = files.get(target);
    if (f) f.text += text; else files.set(target, { mode: redir.op, text });
  };
  const closeFile = async (name: string): Promise<number> => {
    let rc = -1;
    if (pipesOut.has(name)) {
      // Pipe: run the command with the collected text as stdin.
      const out = await runPipe(name, pipesOut.get(name)!);
      ctx.stdout += out;
      pipesOut.delete(name);
      rc = 0;
    }
    const f = files.get(name);
    if (f) {
      const path = ctx.fs.resolvePath(name, ctx.cwd);
      const prev = f.mode === '>>' ? await readText(name) ?? '' : '';
      await ctx.fs.writeFile(path, prev + f.text);
      files.delete(name);
      rc = 0;
    }
    if (readStreams.delete(name)) rc = 0;
    return rc;
  };
  const runPipe = async (cmd: string, stdinText: string): Promise<string> => {
    const sh = ctx.shell.fork();
    sh.env['__PIPE_STDIN'] = stdinText;
    const r = await sh.exec(cmd);
    ctx.stderr += r.stderr;
    return r.stdout;
  };

  type Scope = Map<string, Val | Map<string, Val>> | null;
  const lookupArray = (name: string, scope: Scope): Map<string, Val> => {
    if (scope && scope.has(name)) {
      const v = scope.get(name);
      if (v instanceof Map) return v;
      const m = new Map<string, Val>();
      scope.set(name, m);
      return m;
    }
    let a = arrays.get(name);
    if (!a) { a = new Map(); arrays.set(name, a); }
    return a;
  };
  const keyOf = async (keys: Node[], scope: Scope) => {
    const parts: string[] = [];
    for (const k of keys) parts.push(str(await ev(k, scope)));
    return parts.join(str(getVar('SUBSEP')));
  };
  const getLv = async (n: Node, scope: Scope): Promise<Val> => ev(n, scope);
  const assign = async (n: Node, v: Val, scope: Scope): Promise<Val> => {
    if (n.k === 'var') {
      if (scope && scope.has(n.name)) scope.set(n.name, v);
      else {
        vars.set(n.name, v);
        if (n.name === 'NF') {
          const nf = Math.trunc(num(v));
          fields = fields.slice(0, nf);
          while (fields.length < nf) fields.push('');
          vars.set('NF', nf);
          rebuild();
        }
      }
    } else if (n.k === 'index') lookupArray(n.arr, scope).set(await keyOf(n.keys, scope), v);
    else if (n.k === 'field') setField(Math.trunc(num(await ev(n.e, scope))), str(v));
    return v;
  };
  const compare = (a: Val, b: Val, op: string): boolean => {
    let c: number;
    if (isNumeric(a) && isNumeric(b)) { const x = num(a), y = num(b); c = x < y ? -1 : x > y ? 1 : 0; }
    else { const x = str(a), y = str(b); c = x < y ? -1 : x > y ? 1 : 0; }
    switch (op) { case '<': return c < 0; case '<=': return c <= 0; case '>': return c > 0; case '>=': return c >= 0; case '==': return c === 0; default: return c !== 0; }
  };

  let seed = 0, prevSeed = 0;
  let rng = mulberry(0);

  const ev = async (n: Node, scope: Scope): Promise<Val> => {
    switch (n.k) {
      case 'num': return n.v;
      case 'str': return n.v;
      case 'regex': { const r = toRegex(n.src); return r.test(record) ? 1 : 0; }
      case 'paren': return ev(n.e, scope);
      case 'group': { let v: Val = ''; for (const e of n.list) v = await ev(e, scope); return v; }
      case 'var': {
        if (scope && scope.has(n.name)) { const v = scope.get(n.name)!; return v instanceof Map ? UNINIT : v; }
        if (n.name === 'NF') return vars.get('NF') ?? 0;
        return getVar(n.name);
      }
      case 'index': { const a = lookupArray(n.arr, scope); const k = await keyOf(n.keys, scope); if (!a.has(k)) a.set(k, UNINIT); return a.get(k)!; }
      case 'field': return getField(Math.trunc(num(await ev(n.e, scope))));
      case 'in': { const k = await keyOf(n.keys, scope); return lookupArray(n.arr, scope).has(k) ? 1 : 0; }
      case 'concat': return str(await ev(n.l, scope)) + str(await ev(n.r, scope));
      case 'bin': {
        const a = num(await ev(n.l, scope)), b = num(await ev(n.r, scope));
        switch (n.op) {
          case '+': return a + b; case '-': return a - b; case '*': return a * b;
          case '/': if (b === 0) throw new AwkError('division by zero'); return a / b;
          case '%': if (b === 0) throw new AwkError('division by zero in %'); return a % b;
          case '^': return Math.pow(a, b);
        }
        return 0;
      }
      case 'neg': return -num(await ev(n.e, scope));
      case 'pos': return num(await ev(n.e, scope));
      case 'not': return bool(await ev(n.e, scope)) ? 0 : 1;
      case '&&': return bool(await ev(n.l, scope)) && bool(await ev(n.r, scope)) ? 1 : 0;
      case '||': return bool(await ev(n.l, scope)) || bool(await ev(n.r, scope)) ? 1 : 0;
      case '?:': return bool(await ev(n.c, scope)) ? ev(n.a, scope) : ev(n.b, scope);
      case 'cmp': return compare(await ev(n.l, scope), await ev(n.r, scope), n.op) ? 1 : 0;
      case '~': case '!~': {
        const s = str(await ev(n.l, scope));
        const r = await regexOf(n.r, scope);
        return (r.test(s) === (n.k === '~')) ? 1 : 0;
      }
      case 'assign': {
        if (n.op === '=') { const v = await ev(n.value, scope); return assign(n.target, v instanceof StrNum && v !== UNINIT ? v : v === UNINIT ? '' : v, scope); }
        const cur = num(await getLv(n.target, scope)), r = num(await ev(n.value, scope));
        let v: number;
        switch (n.op) {
          case '+=': v = cur + r; break; case '-=': v = cur - r; break; case '*=': v = cur * r; break;
          case '/=': if (r === 0) throw new AwkError('division by zero in /='); v = cur / r; break;
          case '%=': if (r === 0) throw new AwkError('division by zero in %='); v = cur % r; break;
          default: v = Math.pow(cur, r);
        }
        return assign(n.target, v, scope);
      }
      case 'preinc': { const v = num(await getLv(n.target, scope)) + (n.op === 'INCR' ? 1 : -1); await assign(n.target, v, scope); return v; }
      case 'postinc': { const v = num(await getLv(n.target, scope)); await assign(n.target, v + (n.op === 'INCR' ? 1 : -1), scope); return v; }
      case 'getline': return getline(n, scope);
      case 'call': return callFunc(n, scope);
      case 'builtin': return builtin(n, scope);
    }
    throw new AwkError(`internal: unknown node ${n.k}`);
  };

  const getline = async (n: Node, scope: Scope): Promise<Val> => {
    let line: string | null;
    if (n.src === 'main') {
      line = await nextMainRecord();
      if (line === null) return 0;
      vars.set('NR', num(getVar('NR')) + 1);
      vars.set('FNR', num(getVar('FNR')) + 1);
      if (n.target) await assign(n.target, input(line), scope); else setRecord(line);
      return 1;
    }
    const name = str(await ev(n.src === 'file' ? n.file : n.cmd, scope));
    let st = readStreams.get(name);
    if (!st) {
      let text: string | null;
      if (n.src === 'file') text = await readText(name);
      else { const r = await ctx.shell.fork().exec(name); ctx.stderr += r.stderr; text = r.stdout; }
      if (text === null) return -1;
      st = { lines: splitRecords(text), pos: 0 };
      readStreams.set(name, st);
    }
    if (st.pos >= st.lines.length) return 0;
    line = st.lines[st.pos++];
    if (n.target) await assign(n.target, input(line), scope);
    else { setRecord(line); if (n.src === 'cmd') vars.set('NR', num(getVar('NR')) + 1); }
    return 1;
  };

  const callFunc = async (n: Node, scope: Scope): Promise<Val> => {
    const f = prog.funcs.get(n.name);
    if (!f) throw new AwkError(`calling undefined function ${n.name}`);
    const local: Map<string, Val | Map<string, Val>> = new Map();
    for (let k = 0; k < f.params.length; k++) {
      const argNode = n.args[k];
      if (!argNode) { local.set(f.params[k], UNINIT); continue; }
      // Arrays are passed by reference: a bare name that is (or becomes) an array.
      if (argNode.k === 'var') {
        const nm = argNode.name;
        const isArr = (scope && scope.get(nm) instanceof Map) || arrays.has(nm);
        if (isArr) { local.set(f.params[k], lookupArray(nm, scope)); continue; }
        if (!(scope && scope.has(nm)) && !vars.has(nm)) {
          // Unknown name: bind lazily — an array if the callee uses it as one.
          const m = lookupArray(nm, scope);
          local.set(f.params[k], m);
          arrays.delete(nm);
          continue;
        }
      }
      local.set(f.params[k], await ev(argNode, scope));
    }
    try { await execBlock(f.body, local); }
    catch (e) { if (e instanceof ReturnSignal) return e.v; throw e; }
    return UNINIT;
  };

  const builtin = async (n: Node, scope: Scope): Promise<Val> => {
    const a = n.args as Node[];
    const arg = (k: number) => ev(a[k], scope);
    switch (n.name) {
      case 'length': {
        if (!a.length) return [...record].length;
        if (a[0].k === 'var') {
          const nm = a[0].name;
          const sv = scope?.get(nm);
          if (sv instanceof Map) return sv.size;
          if (!(scope && scope.has(nm)) && arrays.has(nm)) return arrays.get(nm)!.size;
        }
        return [...str(await arg(0))].length;
      }
      case 'substr': {
        // mawk: start and length truncate; a start below 1 keeps (length - start) characters
        // from the first one (substr("hello", 0, 2) is "he", substr("hello", -1, 3) is "hell").
        const chars = [...str(await arg(0))];
        let m = Math.trunc(num(await arg(1)));
        let len = a.length > 2 ? Math.trunc(num(await arg(2))) : Infinity;
        if (isNaN(m)) m = 1;
        if (m < 1) { len -= m; m = 1; }
        return len <= 0 ? '' : chars.slice(m - 1, len === Infinity ? undefined : m - 1 + len).join('');
      }
      case 'index': { const s = str(await arg(0)), t = str(await arg(1)); return s.indexOf(t) + 1; }
      case 'split': {
        const s = str(await arg(0));
        const arr = lookupArray(a[1].name, scope);
        arr.clear();
        let parts: string[];
        if (a.length > 2) {
          const sepNode = a[2];
          if (sepNode.k === 'regex') parts = s === '' ? [] : s.split(toRegex(sepNode.src));
          else parts = splitRecord(s, str(await ev(sepNode, scope)));
        } else parts = splitRecord(s, str(getVar('FS')));
        parts.forEach((v, k) => arr.set(String(k + 1), input(v)));
        return parts.length;
      }
      case 'sub': case 'gsub': {
        const r = await regexOf(a[0], scope);
        const repl = str(await arg(1));
        const target = a[2] ?? { k: 'field', e: { k: 'num', v: 0 } };
        const s = str(await ev(target, scope));
        const re = new RegExp(r.source, r.flags + 'g');
        let count = 0, out = '', last = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(s)) !== null) {
          count++;
          out += s.slice(last, m.index) + repl.replace(/\\\\|\\&|&/g, t => t === '&' ? m![0] : t === '\\&' ? '&' : '\\');
          last = m.index + m[0].length;
          if (m[0] === '') { if (m.index < s.length) out += s[m.index]; last = m.index + 1; re.lastIndex = m.index + 1; }
          if (n.name === 'sub') break;
        }
        if (count) await assign(target, out + s.slice(last), scope);
        return count;
      }
      case 'match': {
        const s = str(await arg(0));
        const r = await regexOf(a[1], scope);
        const m = new RegExp(r.source, r.flags.replace('g', '')).exec(s);
        vars.set('RSTART', m ? [...s.slice(0, m.index)].length + 1 : 0);
        vars.set('RLENGTH', m ? [...m[0]].length : -1);
        return m ? [...s.slice(0, m.index)].length + 1 : 0;
      }
      case 'sprintf': { const vals: Val[] = []; for (let k = 1; k < a.length; k++) vals.push(await arg(k)); return sprintf(str(await arg(0)), vals, str); }
      case 'sin': return Math.sin(num(await arg(0)));
      case 'cos': return Math.cos(num(await arg(0)));
      case 'atan2': return Math.atan2(num(await arg(0)), num(await arg(1)));
      case 'exp': return Math.exp(num(await arg(0)));
      case 'log': return Math.log(num(await arg(0)));
      case 'sqrt': return Math.sqrt(num(await arg(0)));
      case 'int': return Math.trunc(num(await arg(0)));
      case 'rand': return rng();
      case 'srand': { prevSeed = seed; seed = a.length ? num(await arg(0)) : Math.floor(Date.now() / 1000); rng = mulberry(seed); return prevSeed; }
      case 'tolower': return str(await arg(0)).toLowerCase();
      case 'toupper': return str(await arg(0)).toUpperCase();
      case 'system': {
        await flushAll();
        const r = await ctx.shell.fork().exec(str(await arg(0)));
        ctx.stdout += r.stdout; ctx.stderr += r.stderr;
        return r.exitCode;
      }
      case 'close': return closeFile(str(await arg(0)));
      case 'fflush': return 0;
    }
    throw new AwkError(`unknown function ${n.name}`);
  };

  const exec = async (s: Node, scope: Scope): Promise<void> => {
    switch (s.k) {
      case 'block': return execBlock(s.body, scope);
      case 'expr': await ev(s.e, scope); return;
      case 'print': {
        const ofs = str(getVar('OFS')), ors = str(getVar('ORS'));
        let text: string;
        if (!s.args.length) text = record;
        else { const parts: string[] = []; for (const a of s.args) parts.push(outStr(await ev(a, scope))); text = parts.join(ofs); }
        await write(text + ors, s.redir, scope);
        return;
      }
      case 'printf': {
        if (!s.args.length) throw new AwkError('printf: no format');
        const vals: Val[] = [];
        for (let k = 1; k < s.args.length; k++) vals.push(await ev(s.args[k], scope));
        let text: string;
        try { text = sprintf(str(await ev(s.args[0], scope)), vals, outStr, true); }
        catch (e) {
          if (!(e instanceof MissingArgs)) throw e;
          await write(e.partial, s.redir, scope);
          throw new AwkError('run time error: not enough arguments passed to printf');
        }
        await write(text, s.redir, scope);
        return;
      }
      case 'if': if (bool(await ev(s.c, scope))) await exec(s.a, scope); else if (s.b) await exec(s.b, scope); return;
      case 'while':
        while (bool(await ev(s.c, scope))) {
          try { await exec(s.body, scope); } catch (e) { if (e instanceof BreakSignal) break; if (e instanceof ContinueSignal) continue; throw e; }
        }
        return;
      case 'do':
        do {
          try { await exec(s.body, scope); } catch (e) { if (e instanceof BreakSignal) break; if (e instanceof ContinueSignal) continue; throw e; }
        } while (bool(await ev(s.c, scope)));
        return;
      case 'for':
        if (s.init) await exec(s.init, scope);
        while (!s.c || bool(await ev(s.c, scope))) {
          try { await exec(s.body, scope); } catch (e) { if (e instanceof BreakSignal) break; if (!(e instanceof ContinueSignal)) throw e; }
          if (s.step) await exec(s.step, scope);
        }
        return;
      case 'forin': {
        const arr = lookupArray(s.arr, scope);
        for (const k of [...arr.keys()]) {
          if (!arr.has(k)) continue;
          await assign({ k: 'var', name: s.v }, input(k), scope);
          try { await exec(s.body, scope); } catch (e) { if (e instanceof BreakSignal) break; if (e instanceof ContinueSignal) continue; throw e; }
        }
        return;
      }
      case 'delete': {
        const arr = lookupArray(s.arr, scope);
        if (s.keys) arr.delete(await keyOf(s.keys, scope)); else arr.clear();
        return;
      }
      case 'next': throw new NextSignal();
      case 'nextfile': throw new NextFileSignal();
      case 'exit': throw new ExitSignal(s.e ? Math.trunc(num(await ev(s.e, scope))) : status);
      case 'return': throw new ReturnSignal(s.e ? await ev(s.e, scope) : UNINIT);
      case 'break': throw new BreakSignal();
      case 'continue': throw new ContinueSignal();
    }
  };
  const execBlock = async (body: Node[], scope: Scope) => { for (const s of body) await exec(s, scope); };

  const flushAll = async () => {
    for (const name of [...pipesOut.keys()]) await closeFile(name);
    for (const name of [...files.keys()]) await closeFile(name);
  };

  let exitCode: number | null = null;
  // Command-line -v assignments happen before BEGIN.
  for (const [k, v] of assigns) setVar(k, input(unescapeStr(v)));
  try {
    try { await execBlock(prog.begin, null); }
    catch (e) { if (e instanceof ExitSignal) exitCode = e.code; else if (!(e instanceof NextSignal)) throw e; }
    if (exitCode === null && (prog.rules.length || prog.end.length)) {
      for (;;) {
        const line = await nextMainRecord();
        if (line === null) break;
        vars.set('NR', num(getVar('NR')) + 1);
        vars.set('FNR', num(getVar('FNR')) + 1);
        setRecord(line);
        try {
          for (const rule of prog.rules) {
            let hit: boolean;
            if (!rule.pattern) hit = true;
            else if (rule.pattern2) {
              if (!rule.inRange) {
                hit = bool(await ev(rule.pattern, null));
                if (hit) rule.inRange = !bool(await ev(rule.pattern2, null));
              } else {
                hit = true;
                if (bool(await ev(rule.pattern2, null))) rule.inRange = false;
              }
            } else hit = bool(await ev(rule.pattern, null));
            if (!hit) continue;
            if (rule.body) await execBlock(rule.body, null);
            else await write(record + str(getVar('ORS')), undefined, null);
          }
        } catch (e) {
          if (e instanceof NextSignal) continue;
          if (e instanceof NextFileSignal) { if (mainStream) mainStream.pos = mainStream.lines.length; continue; }
          if (e instanceof ExitSignal) { exitCode = e.code; break; }
          throw e;
        }
      }
    }
    try { await execBlock(prog.end, null); }
    catch (e) { if (e instanceof ExitSignal) exitCode = e.code; else if (!(e instanceof NextSignal)) throw e; }
  } finally {
    await flushAll();
  }
  return exitCode ?? status;
}

function mulberry(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const awk: Command = {
  name: 'awk',
  description: 'Pattern scanning and processing language',
  async exec(ctx) {
    const args = ctx.args;
    let program: string | null = null;
    const assigns: [string, string][] = [];
    let fs: string | null = null;
    let i = 0;
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { i++; break; }
      if (a === '-F' || a === '--field-separator') { fs = args[++i]; continue; }
      if (a.startsWith('-F')) { fs = a.slice(2); continue; }
      if (a === '-v' || a === '--assign') { const s = args[++i] ?? ''; const eq = s.indexOf('='); if (eq > 0) assigns.push([s.slice(0, eq), s.slice(eq + 1)]); continue; }
      if (a.startsWith('-v')) { const s = a.slice(2); const eq = s.indexOf('='); if (eq > 0) assigns.push([s.slice(0, eq), s.slice(eq + 1)]); continue; }
      if (a === '-f' || a === '--file') {
        try { program = (program ?? '') + await ctx.fs.readFile(ctx.fs.resolvePath(args[++i], ctx.cwd), 'utf8') + '\n'; }
        catch { ctx.stderr += `awk: couldn't open file ${args[i]}\n`; return 2; }
        continue;
      }
      if (a.startsWith('-') && a.length > 1 && program === null) {
        if (a === '--version' || a === '-W') { ctx.stdout += 'awk (FreeGent)\n'; return 0; }
        ctx.stderr += `awk: not an option: ${a}\n`;
        return 2;
      }
      break;
    }
    if (program === null) {
      if (i >= args.length) { ctx.stderr += 'usage: awk [-F value] [-v var=value] [--] \'program text\' [file ...]\n'; return 2; }
      program = args[i++];
    }
    if (fs !== null) assigns.unshift(['FS', fs === 't' ? '\t' : fs]);
    try {
      return await runAwk(ctx, program, args.slice(i), assigns);
    } catch (e: any) {
      if (e instanceof AwkError) { ctx.stderr += `awk: ${e.message}\n`; return 2; }
      throw e;
    }
  },
};
