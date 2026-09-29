import type { Command } from './index';

// GNU bc: arbitrary-precision decimal arithmetic on BigInt fixed-point numbers, with bc's scale
// rules (results truncated, not rounded), variables, arrays, if/while/for, define/return, print,
// strings, comments, ibase/obase, and -l (scale=20 and s c a l e j). Output as bc prints it:
// no leading zero (".5"), lines wrapped at 70 characters with a trailing backslash.

class Num {
  constructor(public v: bigint, public s: number) {}   // value = v / 10^s
  static int(n: number | bigint) { return new Num(BigInt(n), 0); }
  rescale(s: number): Num {
    if (s === this.s) return this;
    if (s > this.s) return new Num(this.v * 10n ** BigInt(s - this.s), s);
    return new Num(this.v / 10n ** BigInt(this.s - s), s);   // BigInt division truncates toward 0
  }
  isZero() { return this.v === 0n; }
  neg() { return new Num(-this.v, this.s); }
  cmp(o: Num): number { const s = Math.max(this.s, o.s); const a = this.rescale(s).v, b = o.rescale(s).v; return a < b ? -1 : a > b ? 1 : 0; }
  toNumber() { return Number(this.v) / 10 ** this.s; }
}

const add = (a: Num, b: Num) => { const s = Math.max(a.s, b.s); return new Num(a.rescale(s).v + b.rescale(s).v, s); };
const sub = (a: Num, b: Num) => add(a, b.neg());
const mul = (a: Num, b: Num, scale: number) => {
  const full = new Num(a.v * b.v, a.s + b.s);
  return full.rescale(Math.min(a.s + b.s, Math.max(scale, a.s, b.s)));
};
const div = (a: Num, b: Num, scale: number) => {
  if (b.isZero()) throw new BcError('Divide by zero');
  // (a.v/10^a.s) / (b.v/10^b.s) at `scale` digits
  const num = a.v * 10n ** BigInt(scale + b.s);
  const den = b.v * 10n ** BigInt(a.s);
  return new Num(num / den, scale);
};
const mod = (a: Num, b: Num, scale: number) => {
  if (b.isZero()) throw new BcError('Modulo by zero');
  const q = div(a, b, scale);
  return sub(a, mul(q, b, Math.max(scale + b.s, a.s)));
};
const pow = (a: Num, b: Num, scale: number): Num => {
  if (b.s > 0 && b.rescale(0).cmp(b) !== 0) { /* bc warns: non-zero scale in exponent; uses the integer part */ }
  let e = b.rescale(0).v;
  const negative = e < 0n;
  if (negative) e = -e;
  let result = Num.int(1), base = a;
  const n = e;
  while (e > 0n) {
    if (e & 1n) result = new Num(result.v * base.v, result.s + base.s);
    base = new Num(base.v * base.v, base.s * 2);
    e >>= 1n;
  }
  if (negative) return div(Num.int(1), result, scale);
  return result.rescale(Math.min(a.s * Number(n), Math.max(scale, a.s)));
};
const sqrt = (a: Num, scale: number): Num => {
  if (a.v < 0n) throw new BcError('Square root of a negative number');
  const s = Math.max(scale, a.s);
  const target = a.rescale(2 * s).v;   // sqrt(target) = sqrt(a) * 10^s
  if (target === 0n) return new Num(0n, s);
  let x = BigInt(Math.floor(Math.sqrt(Number(target)))) || 1n;
  for (;;) { const y = (x + target / x) >> 1n; if (y >= x && y - x <= 1n) { while (x * x > target) x--; while ((x + 1n) * (x + 1n) <= target) x++; break; } x = y; }
  return new Num(x, s);
};

class BcError extends Error {}

function parseNumber(text: string, ibase: number): Num {
  if (ibase === 10) {
    const [ip, fp = ''] = text.split('.');
    return new Num(BigInt((ip || '0') + fp), fp.length);
  }
  const digit = (c: string) => /\d/.test(c) ? c.charCodeAt(0) - 48 : c.charCodeAt(0) - 55;
  const [ip, fp = ''] = text.split('.');
  let v = 0n;
  for (const c of ip) v = v * BigInt(ibase) + BigInt(Math.min(digit(c), ibase - 1));
  let n = Num.int(v);
  if (fp) {
    let f = Num.int(0), place = Num.int(1);
    for (const c of fp) { place = div(place, Num.int(ibase), fp.length + 5); f = add(f, mul(place, Num.int(digit(c)), 100)); }
    n = add(n, f.rescale(fp.length));
  }
  return n;
}

function format(n: Num, obase: number): string {
  if (n.v === 0n) return '0';   // bc prints zero as "0" whatever its scale
  const neg = n.v < 0n;
  const abs = neg ? -n.v : n.v;
  let out: string;
  if (obase === 10) {
    let digits = abs.toString().padStart(n.s + 1, '0');
    const ip = digits.slice(0, digits.length - n.s), fp = digits.slice(digits.length - n.s);
    out = (ip === '0' && n.s > 0 ? '' : ip) + (n.s > 0 ? '.' + fp : '');
    if (out === '') out = '0';
    digits = '';
  } else {
    const ipv = abs / 10n ** BigInt(n.s);
    const conv = (v: bigint) => obase <= 16 ? v.toString(obase).toUpperCase() : ' ' + v.toString().padStart(String(obase - 1).length, '0');
    let ip = '';
    if (ipv === 0n) ip = '0';
    else { let x = ipv; const parts: string[] = []; while (x > 0n) { parts.unshift(conv(x % BigInt(obase))); x /= BigInt(obase); } ip = parts.join(''); }
    out = ip;
    if (n.s > 0) {
      let frac = new Num(abs - ipv * 10n ** BigInt(n.s), n.s);
      let fs = '.';
      const digitsNeeded = Math.ceil(n.s * Math.log(10) / Math.log(obase));
      for (let k = 0; k < digitsNeeded; k++) { frac = new Num(frac.v * BigInt(obase), frac.s); const d = frac.v / 10n ** BigInt(frac.s); fs += conv(d); frac = new Num(frac.v - d * 10n ** BigInt(frac.s), frac.s); }
      out += fs;
    }
    if (out.startsWith('0.')) out = out.slice(1);
  }
  if (neg && abs !== 0n) out = '-' + out;
  // Wrap at 70 characters: 69 characters then a backslash.
  const lines: string[] = [];
  while (out.length > 69) { lines.push(out.slice(0, 69) + '\\'); out = out.slice(69); }
  lines.push(out);
  return lines.join('\n');
}

// ─── Parser ──────────────────────────────────────────────────────────────────

type Tok = { t: string; v?: string };
function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '\n') { out.push({ t: 'NL' }); i++; continue; }
    if (c === '"') { const e = src.indexOf('"', i + 1); out.push({ t: 'STR', v: src.slice(i + 1, e < 0 ? src.length : e) }); i = e < 0 ? src.length : e + 1; continue; }
    const num = /^(?:[0-9A-F]+\.?[0-9A-F]*|\.[0-9A-F]+)/.exec(src.slice(i));
    if (num) { out.push({ t: 'NUM', v: num[0] }); i += num[0].length; continue; }
    const id = /^[a-z_][a-z0-9_]*/.exec(src.slice(i));
    if (id) { out.push({ t: ['if', 'else', 'while', 'for', 'break', 'continue', 'define', 'return', 'auto', 'print', 'quit', 'halt', 'length', 'scale', 'sqrt', 'read', 'limits', 'warranty'].includes(id[0]) ? id[0] : 'ID', v: id[0] }); i += id[0].length; continue; }
    const ops = ['^=', '*=', '/=', '%=', '+=', '-=', '==', '<=', '>=', '!=', '&&', '||', '++', '--'];
    const op = ops.find(o => src.startsWith(o, i));
    if (op) { out.push({ t: op }); i += 2; continue; }
    if ('+-*/%^=<>!(){}[],;'.includes(c)) { out.push({ t: c }); i++; continue; }
    throw new BcError(`illegal character: ${c}`);
  }
  out.push({ t: 'EOF' });
  return out;
}

type Node = any;
function parse(src: string): Node[] {
  const toks = lex(src);
  let p = 0;
  const at = (t: string) => toks[p].t === t;
  const eat = (t: string) => { if (!at(t)) throw new BcError(`syntax error near ${toks[p].v ?? toks[p].t}`); return toks[p++]; };
  const nls = () => { while (at('NL')) p++; };
  const expr = (): Node => assign();
  const isLv = (n: Node) => n.k === 'var' || n.k === 'idx' || n.k === 'special';
  const assign = (): Node => {
    const l = or();
    if (['=', '+=', '-=', '*=', '/=', '%=', '^='].includes(toks[p].t) && isLv(l)) { const op = toks[p++].t; return { k: 'assign', op, l, r: assign() }; }
    return l;
  };
  const or = (): Node => { let l = and(); while (at('||')) { p++; l = { k: 'or', l, r: and() }; } return l; };
  const and = (): Node => { let l = not(); while (at('&&')) { p++; l = { k: 'and', l, r: not() }; } return l; };
  const not = (): Node => { if (at('!')) { p++; return { k: 'not', e: not() }; } return rel(); };
  const rel = (): Node => {
    const l = addE();
    if (['<', '<=', '>', '>=', '==', '!='].includes(toks[p].t)) { const op = toks[p++].t; return { k: 'rel', op, l, r: addE() }; }
    return l;
  };
  const addE = (): Node => { let l = mulE(); while (at('+') || at('-')) { const op = toks[p++].t; l = { k: 'bin', op, l, r: mulE() }; } return l; };
  const mulE = (): Node => { let l = powE(); while (at('*') || at('/') || at('%')) { const op = toks[p++].t; l = { k: 'bin', op, l, r: powE() }; } return l; };
  const powE = (): Node => { const b = unary(); if (at('^')) { p++; return { k: 'bin', op: '^', l: b, r: powE() }; } return b; };
  const unary = (): Node => { if (at('-')) { p++; return { k: 'neg', e: unary() }; } return incdec(); };
  const incdec = (): Node => {
    if (at('++') || at('--')) { const op = toks[p++].t; return { k: 'pre', op, e: primary() }; }
    const e = primary();
    if (isLv(e) && (at('++') || at('--'))) { const op = toks[p++].t; return { k: 'post', op, e }; }
    return e;
  };
  const primary = (): Node => {
    const t = toks[p];
    if (t.t === 'NUM') { p++; return { k: 'num', v: t.v }; }
    if (t.t === '(') { p++; const e = expr(); eat(')'); return e; }
    if (t.t === 'scale' || t.t === 'length' || t.t === 'sqrt') {
      p++;
      if (at('(')) { p++; const e = expr(); eat(')'); return { k: 'fn', name: t.t, e }; }
      if (t.t === 'scale') return { k: 'special', name: 'scale' };
      throw new BcError(`syntax error: ${t.t}`);
    }
    if (t.t === 'read') { p++; eat('('); eat(')'); return { k: 'num', v: '0' }; }
    if (t.t === 'ID') {
      p++;
      if (['ibase', 'obase', 'last'].includes(t.v!)) return { k: 'special', name: t.v };
      if (at('(')) {
        p++;
        const args: Node[] = [];
        while (!at(')')) { args.push(expr()); if (!at(',')) break; p++; }
        eat(')');
        return { k: 'call', name: t.v, args };
      }
      if (at('[')) { p++; const i = expr(); eat(']'); return { k: 'idx', name: t.v, i }; }
      return { k: 'var', name: t.v };
    }
    throw new BcError(`syntax error near ${t.v ?? t.t}`);
  };
  const stmt = (): Node => {
    const t = toks[p].t;
    if (t === '{') { p++; const body = stmts('}'); eat('}'); return { k: 'block', body }; }
    if (t === 'if') { p++; eat('('); const c = expr(); eat(')'); nls(); const a = stmt(); const save = p; nls(); if (at('else')) { p++; nls(); return { k: 'if', c, a, b: stmt() }; } p = save; return { k: 'if', c, a }; }
    if (t === 'while') { p++; eat('('); const c = expr(); eat(')'); nls(); return { k: 'while', c, body: stmt() }; }
    if (t === 'for') {
      p++; eat('(');
      const init = at(';') ? null : expr(); eat(';');
      const c = at(';') ? null : expr(); eat(';');
      const step = at(')') ? null : expr(); eat(')'); nls();
      return { k: 'for', init, c, step, body: stmt() };
    }
    if (t === 'break' || t === 'continue') { p++; return { k: t }; }
    if (t === 'quit') { p++; return { k: 'quit' }; }
    if (t === 'halt') { p++; return { k: 'halt' }; }
    if (t === 'return') { p++; if (at('(')) { p++; if (at(')')) { p++; return { k: 'return' }; } const e = expr(); eat(')'); return { k: 'return', e }; } if (at('NL') || at(';') || at('}') || at('EOF')) return { k: 'return' }; return { k: 'return', e: expr() }; }
    if (t === 'print') {
      p++;
      const items: Node[] = [];
      for (;;) { if (at('STR')) items.push({ k: 'str', v: toks[p++].v }); else items.push(expr()); if (!at(',')) break; p++; }
      return { k: 'print', items };
    }
    if (t === 'STR') { p++; return { k: 'str', v: toks[p - 1].v }; }
    if (t === 'define') {
      p++; const name = eat('ID').v!; eat('(');
      const params: { name: string; arr: boolean }[] = [];
      while (!at(')')) { const n = eat('ID').v!; let arr = false; if (at('[')) { p++; eat(']'); arr = true; } params.push({ name: n, arr }); if (!at(',')) break; p++; }
      eat(')'); nls(); eat('{'); nls();
      const autos: string[] = [];
      if (at('auto')) { p++; while (at('ID')) { autos.push(toks[p++].v!); if (at('[')) { p++; eat(']'); } if (!at(',')) break; p++; } }
      const body = stmts('}'); eat('}');
      return { k: 'define', name, params, autos, body };
    }
    if (t === 'limits' || t === 'warranty') { p++; return { k: 'block', body: [] }; }
    return { k: 'expr', e: expr() };
  };
  const stmts = (end: string): Node[] => {
    const out: Node[] = [];
    for (;;) {
      while (at('NL') || at(';')) p++;
      if (at(end) || at('EOF')) break;
      out.push(stmt());
      if (!at('NL') && !at(';') && !at(end) && !at('EOF')) throw new BcError(`syntax error near ${toks[p].v ?? toks[p].t}`);
    }
    return out;
  };
  return stmts('EOF');
}

// ─── Interpreter ─────────────────────────────────────────────────────────────

class Quit {} class Break {} class Continue {} class Return { constructor(public v: Num) {} }

function run(prog: Node[], mathlib: boolean, out: (s: string) => void) {
  let scale = mathlib ? 20 : 0, ibase = 10, obase = 10;
  let last = Num.int(0);
  const globals = new Map<string, Num>();
  const arrays = new Map<string, Map<string, Num>>();
  const funcs = new Map<string, Node>();
  const frames: Map<string, Num | Map<string, Num>>[] = [];
  const getVar = (n: string): Num => { for (let k = frames.length - 1; k >= 0; k--) { const f = frames[k]; if (f.has(n)) { const v = f.get(n); if (v instanceof Num) return v; } } return globals.get(n) ?? Num.int(0); };
  const setVar = (n: string, v: Num) => { for (let k = frames.length - 1; k >= 0; k--) if (frames[k].has(n) && frames[k].get(n) instanceof Num) { frames[k].set(n, v); return; } globals.set(n, v); };
  const getArr = (n: string): Map<string, Num> => { for (let k = frames.length - 1; k >= 0; k--) { const v = frames[k].get(n + '[]'); if (v instanceof Map) return v; } let a = arrays.get(n); if (!a) { a = new Map(); arrays.set(n, a); } return a; };

  const lv = (n: Node): [() => Num, (v: Num) => void] => {
    if (n.k === 'var') return [() => getVar(n.name), v => setVar(n.name, v)];
    if (n.k === 'idx') { const i = ev(n.i).rescale(0).v.toString(); const a = getArr(n.name); return [() => a.get(i) ?? Num.int(0), v => { a.set(i, v); }]; }
    const name = n.name;
    return [() => name === 'scale' ? Num.int(scale) : name === 'ibase' ? Num.int(ibase) : name === 'obase' ? Num.int(obase) : last,
      v => { const x = Number(v.rescale(0).v); if (name === 'scale') scale = Math.max(0, x); else if (name === 'ibase') ibase = Math.min(16, Math.max(2, x)); else if (name === 'obase') obase = Math.max(2, x); else last = v; }];
  };
  const truth = (v: Num) => !v.isZero();
  const ev = (n: Node): Num => {
    switch (n.k) {
      case 'num': return parseNumber(n.v, ibase);
      case 'var': case 'idx': case 'special': return lv(n)[0]();
      case 'neg': return ev(n.e).neg();
      case 'not': return Num.int(truth(ev(n.e)) ? 0 : 1);
      case 'and': return Num.int(truth(ev(n.l)) && truth(ev(n.r)) ? 1 : 0);
      case 'or': return Num.int(truth(ev(n.l)) || truth(ev(n.r)) ? 1 : 0);
      case 'rel': { const c = ev(n.l).cmp(ev(n.r)); const r = { '<': c < 0, '<=': c <= 0, '>': c > 0, '>=': c >= 0, '==': c === 0, '!=': c !== 0 }[n.op as string]; return Num.int(r ? 1 : 0); }
      case 'bin': {
        const a = ev(n.l), b = ev(n.r);
        switch (n.op) { case '+': return add(a, b); case '-': return sub(a, b); case '*': return mul(a, b, scale); case '/': return div(a, b, scale); case '%': return mod(a, b, scale); default: return pow(a, b, scale); }
      }
      case 'assign': {
        const [get, set] = lv(n.l);
        let v = ev(n.r);
        if (n.op !== '=') { const a = get(); v = { '+=': add(a, v), '-=': sub(a, v), '*=': mul(a, v, scale), '/=': div(a, v, scale), '%=': mod(a, v, scale), '^=': pow(a, v, scale) }[n.op as string]!; }
        set(v);
        return v;
      }
      case 'pre': { const [get, set] = lv(n.e); const v = add(get(), Num.int(n.op === '++' ? 1 : -1)); set(v); return v; }
      case 'post': { const [get, set] = lv(n.e); const v = get(); set(add(v, Num.int(n.op === '++' ? 1 : -1))); return v; }
      case 'fn': {
        const v = ev(n.e);
        if (n.name === 'sqrt') return sqrt(v, scale);
        if (n.name === 'scale') return Num.int(v.s);
        const digits = v.v < 0n ? (-v.v).toString() : v.v.toString();
        return Num.int(v.v === 0n ? (v.s || 1) : Math.max(digits.length, v.s));
      }
      case 'call': {
        if (mathlib && ['s', 'c', 'a', 'l', 'e', 'j'].includes(n.name) && !funcs.has(n.name)) return mathFn(n.name, n.args.map(ev), scale);
        const f = funcs.get(n.name);
        if (!f) throw new BcError(`Function ${n.name} not defined.`);
        const frame = new Map<string, Num | Map<string, Num>>();
        f.params.forEach((prm: any, k: number) => {
          if (prm.arr) { const src = n.args[k]; frame.set(prm.name + '[]', new Map(getArr(src?.name ?? ''))); }
          else frame.set(prm.name, n.args[k] ? ev(n.args[k]) : Num.int(0));
        });
        for (const a of f.autos) { frame.set(a, Num.int(0)); frame.set(a + '[]', new Map()); }
        frames.push(frame);
        try { for (const s of f.body) exec(s, true); }
        catch (e) { if (e instanceof Return) return e.v; throw e; }
        finally { frames.pop(); }
        return Num.int(0);
      }
    }
    throw new BcError(`internal: ${n.k}`);
  };
  const exec = (s: Node, inFunc = false): void => {
    switch (s.k) {
      case 'block': for (const x of s.body) exec(x, inFunc); return;
      case 'expr': {
        const v = ev(s.e);
        if (s.e.k !== 'assign') { out(format(v, obase) + '\n'); last = v; }
        return;
      }
      case 'str': out(s.v.replace(/\\n/g, '\n')); return;
      case 'print':
        for (const it of s.items) out(it.k === 'str' ? it.v.replace(/\\(.)/g, (_m: string, c: string) => ({ n: '\n', t: '\t', a: '\x07', b: '\b', f: '\f', r: '\r', q: '"', '\\': '\\' } as any)[c] ?? c) : format(ev(it), obase));
        return;
      case 'if': if (truth(ev(s.c))) exec(s.a, inFunc); else if (s.b) exec(s.b, inFunc); return;
      case 'while': while (truth(ev(s.c))) { try { exec(s.body, inFunc); } catch (e) { if (e instanceof Break) break; if (e instanceof Continue) continue; throw e; } } return;
      case 'for':
        if (s.init) ev(s.init);
        while (!s.c || truth(ev(s.c))) { try { exec(s.body, inFunc); } catch (e) { if (e instanceof Break) break; if (!(e instanceof Continue)) throw e; } if (s.step) ev(s.step); }
        return;
      case 'break': throw new Break();
      case 'continue': throw new Continue();
      case 'return': throw new Return(s.e ? ev(s.e) : Num.int(0));
      case 'quit': case 'halt': throw new Quit();
      case 'define': funcs.set(s.name, s); return;
    }
  };
  // quit ends the program when it is parsed (bc); treat it as ending here.
  try { for (const s of prog) exec(s); } catch (e) { if (!(e instanceof Quit)) throw e; }
}

// -l math library: series in BigInt fixed point with guard digits, then truncated to `scale`,
// as bc's own library does.
function mathFn(name: string, args: Num[], scale: number): Num {
  const P = scale + 12;
  const ONE = 10n ** BigInt(P);
  const fx = (n: Num) => n.rescale(P).v;
  const mulF = (a: bigint, b: bigint) => a * b / ONE;
  const divF = (a: bigint, b: bigint) => a * ONE / b;
  const sqrtF = (a: bigint) => sqrt(new Num(a, P), P).rescale(P).v;
  const expF = (x: bigint): bigint => {
    let k = 0;
    while (x > ONE || x < -ONE) { x /= 2n; k++; }
    let sum = ONE, term = ONE;
    for (let n = 1n; term !== 0n; n++) { term = mulF(term, x) / n; sum += term; }
    for (; k > 0; k--) sum = mulF(sum, sum);
    return sum;
  };
  const atanhF = (x: bigint): bigint => {   // |x| small
    let sum = 0n, pow = x;
    const x2 = mulF(x, x);
    for (let n = 1n; pow !== 0n; n += 2n) { sum += pow / n; pow = mulF(pow, x2); }
    return sum;
  };
  const ln2 = () => 2n * atanhF(divF(ONE, 3n * ONE));
  const lnF = (x: bigint): bigint => {
    if (x <= 0n) throw new BcError('Runtime error: log of a non-positive number');
    let k = 0n;
    while (x >= 2n * ONE) { x /= 2n; k++; }
    while (x < ONE) { x *= 2n; k--; }
    return k * ln2() + 2n * atanhF(divF(x - ONE, x + ONE));
  };
  const atanF = (x: bigint): bigint => {
    if (x < 0n) return -atanF(-x);
    if (x > ONE) return pi() / 2n - atanF(divF(ONE, x));
    let k = 0n;
    while (x > ONE / 5n) { x = divF(x, ONE + sqrtF(ONE + mulF(x, x))); k++; }
    let sum = 0n, pow = x;
    const x2 = mulF(x, x);
    for (let n = 1n, sign = 1n; pow !== 0n; n += 2n, sign = -sign) { sum += sign * pow / n; pow = mulF(pow, x2); }
    return sum * (1n << k);
  };
  let piCache: bigint | null = null;
  const pi = () => piCache ??= 4n * (4n * atanSmall(divF(ONE, 5n * ONE)) - atanSmall(divF(ONE, 239n * ONE)));
  function atanSmall(x: bigint): bigint {
    let sum = 0n, pow = x;
    const x2 = mulF(x, x);
    for (let n = 1n, sign = 1n; pow !== 0n; n += 2n, sign = -sign) { sum += sign * pow / n; pow = mulF(pow, x2); }
    return sum;
  }
  const sinF = (x: bigint): bigint => {
    const twoPi = 2n * pi();
    x %= twoPi;
    let sum = 0n, term = x;
    const x2 = mulF(x, x);
    for (let n = 1n; term !== 0n; n += 2n) { sum += term; term = -mulF(term, x2) / ((n + 1n) * (n + 2n)); }
    return sum;
  };
  const x = args[0] ? fx(args[0]) : 0n;
  let r: bigint;
  switch (name) {
    case 's': r = sinF(x); break;
    case 'c': r = sinF(x + pi() / 2n); break;
    case 'a': r = atanF(x); break;
    case 'l': r = lnF(x); break;
    case 'e': r = expF(x); break;
    default: {
      // Bessel J_n(x) = sum (-1)^m (x/2)^(2m+n) / (m! (m+n)!)
      const n = BigInt(Math.abs(Number(args[0]?.rescale(0).v ?? 0n)));
      const xx = args[1] ? fx(args[1]) : 0n;
      const half = xx / 2n;
      let term = ONE;
      for (let k = 1n; k <= n; k++) term = mulF(term, half) / k;
      let sum = 0n;
      const h2 = mulF(half, half);
      for (let m = 1n; term !== 0n; m++) { sum += term; term = -mulF(term, h2) / (m * (m + n)); }
      r = sum;
    }
  }
  return new Num(r, P).rescale(scale);
}

export const bc: Command = {
  name: 'bc',
  description: 'Arbitrary precision calculator',
  async exec(ctx) {
    let mathlib = false;
    const files: string[] = [];
    for (const a of ctx.args) {
      if (a === '-l' || a === '--mathlib') mathlib = true;
      else if (a === '-q' || a === '--quiet' || a === '-s' || a === '-w' || a === '--standard' || a === '--warn') { /* no-op */ }
      else if (a.startsWith('-') && /^-[lqsw]+$/.test(a)) { if (a.includes('l')) mathlib = true; }
      else files.push(a);
    }
    let src = '';
    for (const f of files) {
      try { src += await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd), 'utf8') + '\n'; }
      catch { ctx.stderr += `File ${f} is unavailable.\n`; return 1; }
    }
    src += ctx.stdin;
    try {
      run(parse(src), mathlib, s => { ctx.stdout += s; });
    } catch (e: any) {
      if (e instanceof BcError) { ctx.stderr += `(standard_in) 1: ${e.message}\n`; return 1; }
      throw e;
    }
    return 0;
  },
};
