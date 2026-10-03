import type { Command } from './index';

// A jq interpreter: lexer -> AST -> generator-based evaluator.
// Values are plain JSON values. Every filter is a generator yielding
// [value, path] pairs; `path` is null when path tracking is off, an array
// while tracking, and undefined when the value is not a valid path expression.

type JqValue = any;
type Path = any[] | null | undefined;
type Out = [JqValue, Path];

class JqError extends Error {
  value: JqValue;
  constructor(value: JqValue) {
    super(typeof value === 'string' ? value : toJson(value, null, false, false) + ' (not a string)');
    this.name = 'JqError';
    this.value = value;
  }
}
class CompileError extends Error {}
class BreakSignal { constructor(public label: object) {} }
class HaltSignal { constructor(public code: number, public msg: string) {} }

// ───────────────────────── JSON helpers ─────────────────────────

function typeName(v: JqValue): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v === 'object' ? 'object' : typeof v;
}
const isObj = (v: JqValue) => v !== null && typeof v === 'object' && !Array.isArray(v);
const truthy = (v: JqValue) => v !== null && v !== false;
const pv = (p: Path): Path => (p === null ? null : undefined);

function quote(s: string, ascii: boolean): string {
  let r = JSON.stringify(s);
  if (ascii) r = r.replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  return r;
}

function numStr(n: number): string {
  if (Number.isNaN(n)) return 'null';
  if (n === Infinity) return '1.7976931348623157e+308';
  if (n === -Infinity) return '-1.7976931348623157e+308';
  return Object.is(n, -0) ? '-0' : String(n);
}

function toJson(v: JqValue, indent: string | null, sort: boolean, ascii: boolean, level = 0): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return numStr(v);
  if (typeof v === 'string') return quote(v, ascii);
  const nl = indent === null ? '' : '\n' + indent.repeat(level + 1);
  const end = indent === null ? '' : '\n' + indent.repeat(level);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return '[' + nl + v.map(x => toJson(x, indent, sort, ascii, level + 1)).join(',' + nl) + end + ']';
  }
  let keys = Object.keys(v);
  if (sort) keys = keys.sort(cmpStr);
  if (keys.length === 0) return '{}';
  const sep = indent === null ? ':' : ': ';
  return '{' + nl + keys.map(k => quote(k, ascii) + sep + toJson(v[k], indent, sort, ascii, level + 1)).join(',' + nl) + end + '}';
}
const compact = (v: JqValue) => toJson(v, null, false, false);

function parseJsonStream(text: string): { values: JqValue[]; error?: string } {
  const values: JqValue[] = [];
  let i = 0;
  const n = text.length;
  const ws = () => { while (i < n && /[\s\u001e]/.test(text[i])) i++; };
  const fail = (m: string): never => { throw new Error(m); };
  function value(depth: number): JqValue {
    if (depth > 10000) fail('Exceeds depth limit for parsing');
    ws();
    if (i >= n) fail('Unfinished JSON term');
    const c = text[i];
    if (c === '{') {
      i++;
      const o: Record<string, JqValue> = {};
      ws();
      if (text[i] === '}') { i++; return o; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('Object keys must be strings');
        const k = str();
        ws();
        if (text[i] !== ':') fail("Objects must consist of key:value pairs");
        i++;
        o[k] = value(depth + 1);
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return o; }
        fail(i >= n ? 'Unfinished JSON term' : 'Expected separator between values');
      }
    }
    if (c === '[') {
      i++;
      const a: JqValue[] = [];
      ws();
      if (text[i] === ']') { i++; return a; }
      for (;;) {
        a.push(value(depth + 1));
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return a; }
        fail(i >= n ? 'Unfinished JSON term' : 'Expected separator between values');
      }
    }
    if (c === '"') return str();
    const m = /^(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|true|false|null|NaN|nan|-?Infinity)/.exec(text.slice(i, i + 400));
    if (!m) fail('Invalid literal');
    i += m![0].length;
    const t = m![0];
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    if (t === 'NaN' || t === 'nan') return NaN;
    if (t.endsWith('Infinity')) return t[0] === '-' ? -Infinity : Infinity;
    return Number(t);
  }
  function str(): string {
    const s = i;
    i++;
    while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= n) fail('Unfinished string');
    i++;
    try { return JSON.parse(text.slice(s, i)); } catch { return fail('Invalid string'); }
  }
  try {
    for (;;) {
      ws();
      if (i >= n) break;
      values.push(value(0));
    }
  } catch (e: any) {
    return { values, error: e.message };
  }
  return { values };
}

// ───────────────────────── ordering & arithmetic ─────────────────────────

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const typeOrder = (v: JqValue) => v === null ? 0 : v === false ? 1 : v === true ? 2 : typeof v === 'number' ? 3 : typeof v === 'string' ? 4 : Array.isArray(v) ? 5 : 6;

function compare(a: JqValue, b: JqValue): number {
  const ta = typeOrder(a), tb = typeOrder(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  switch (ta) {
    case 3: return Number.isNaN(a) ? (Number.isNaN(b) ? -1 : -1) : Number.isNaN(b) ? 1 : a < b ? -1 : a > b ? 1 : 0;
    case 4: return cmpStr(a, b);
    case 5: {
      for (let i = 0; i < a.length && i < b.length; i++) { const c = compare(a[i], b[i]); if (c) return c; }
      return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
    }
    case 6: {
      const ka = Object.keys(a).sort(cmpStr), kb = Object.keys(b).sort(cmpStr);
      const c = compare(ka, kb);
      if (c) return c;
      for (const k of ka) { const d = compare(a[k], b[k]); if (d) return d; }
      return 0;
    }
    default: return 0;
  }
}

function deepMerge(a: any, b: any): any {
  const o = { ...a };
  for (const k of Object.keys(b)) o[k] = isObj(o[k]) && isObj(b[k]) ? deepMerge(o[k], b[k]) : b[k];
  return o;
}

function errDesc(v: JqValue): string {
  const s = compact(v);
  return `${typeName(v)} (${s.length > 11 ? s.slice(0, 10) + '...' : s})`;
}

function binop(op: string, a: JqValue, b: JqValue): JqValue {
  switch (op) {
    case '+':
      if (a === null) return b;
      if (b === null) return a;
      if (typeof a === 'number' && typeof b === 'number') return a + b;
      if (typeof a === 'string' && typeof b === 'string') return a + b;
      if (Array.isArray(a) && Array.isArray(b)) return a.concat(b);
      if (isObj(a) && isObj(b)) return { ...a, ...b };
      throw new JqError(`${errDesc(a)} and ${errDesc(b)} cannot be added`);
    case '-':
      if (typeof a === 'number' && typeof b === 'number') return a - b;
      if (Array.isArray(a) && Array.isArray(b)) return a.filter(x => !b.some(y => compare(x, y) === 0));
      throw new JqError(`${errDesc(a)} and ${errDesc(b)} cannot be subtracted`);
    case '*':
      if (typeof a === 'number' && typeof b === 'number') return a * b;
      if ((typeof a === 'string' && typeof b === 'number') || (typeof a === 'number' && typeof b === 'string')) {
        const [s, n] = typeof a === 'string' ? [a, b as number] : [b as string, a];
        return n > 0 ? s.repeat(Math.max(1, Math.ceil(n))) : null;
      }
      if (isObj(a) && isObj(b)) return deepMerge(a, b);
      throw new JqError(`${errDesc(a)} and ${errDesc(b)} cannot be multiplied`);
    case '/':
      if (typeof a === 'number' && typeof b === 'number') {
        if (b === 0) throw new JqError(`${errDesc(a)} and ${errDesc(b)} cannot be divided because the divisor is zero`);
        return a / b;
      }
      if (typeof a === 'string' && typeof b === 'string') return splitStr(a, b);
      throw new JqError(`${errDesc(a)} and ${errDesc(b)} cannot be divided`);
    case '%':
      if (typeof a === 'number' && typeof b === 'number') {
        const x = Math.trunc(a), y = Math.trunc(b);
        if (y === 0) throw new JqError(`${errDesc(a)} and ${errDesc(b)} cannot be divided because the divisor is zero`);
        return x % Math.abs(y);
      }
      throw new JqError(`${errDesc(a)} and ${errDesc(b)} cannot be divided`);
    case '==': return compare(a, b) === 0;
    case '!=': return compare(a, b) !== 0;
    case '<': return compare(a, b) < 0;
    case '<=': return compare(a, b) <= 0;
    case '>': return compare(a, b) > 0;
    case '>=': return compare(a, b) >= 0;
  }
  throw new CompileError(`unknown operator ${op}`);
}

function splitStr(s: string, sep: string): string[] {
  if (s === '') return [];
  return sep === '' ? Array.from(s) : s.split(sep);
}

// ───────────────────────── paths ─────────────────────────

function sliceBounds(len: number, from: any, to: any): [number, number] {
  if ((from !== null && from !== undefined && typeof from !== 'number') || (to !== null && to !== undefined && typeof to !== 'number')) {
    throw new JqError('Start and end indices of an array slice must be numbers');
  }
  let s = from == null ? 0 : Math.floor(from);
  let e = to == null ? len : Math.ceil(to);
  if (s < 0) s += len;
  if (e < 0) e += len;
  s = Math.min(Math.max(s, 0), len);
  e = Math.min(Math.max(e, s), len);
  return [s, e];
}

function indicesOf(v: JqValue, x: JqValue): number[] {
  const out: number[] = [];
  if (v === null) return out;
  if (typeof v === 'string') {
    if (typeof x !== 'string') throw new JqError(`Cannot determine indices of ${typeName(x)} in string`);
    if (x === '') return null as any;
    let i = v.indexOf(x);
    while (i >= 0) { out.push(i); i = v.indexOf(x, i + 1); }
    return out;
  }
  if (Array.isArray(v)) {
    if (Array.isArray(x)) {
      if (x.length === 0) return null as any;
      for (let i = 0; i + x.length <= v.length; i++) {
        if (x.every((y, j) => compare(v[i + j], y) === 0)) out.push(i);
      }
    } else {
      v.forEach((y, i) => { if (compare(y, x) === 0) out.push(i); });
    }
    return out;
  }
  throw new JqError(`Cannot determine indices in ${typeName(v)}`);
}

function get(v: JqValue, k: JqValue): JqValue {
  if (typeof k === 'string') {
    if (v === null) return null;
    if (isObj(v)) return Object.hasOwn(v, k) ? v[k] : null;
    throw new JqError(`Cannot index ${typeName(v)} with "${k}"`);
  }
  if (typeof k === 'number') {
    if (v === null) return null;
    if (Array.isArray(v)) {
      if (Number.isNaN(k)) return null;
      let i = Math.floor(k);
      if (i < 0) i += v.length;
      return i >= 0 && i < v.length ? v[i] : null;
    }
    throw new JqError(`Cannot index ${typeName(v)} with number`);
  }
  if (isObj(k)) {
    if (v === null) return null;
    if (Array.isArray(v)) { const [s, e] = sliceBounds(v.length, k.start, k.end); return v.slice(s, e); }
    if (typeof v === 'string') { const c = Array.from(v); const [s, e] = sliceBounds(c.length, k.start, k.end); return c.slice(s, e).join(''); }
    throw new JqError(`Cannot index ${typeName(v)} with object`);
  }
  if (Array.isArray(k) && Array.isArray(v)) return indicesOf(v, k);
  if (v === null && k === null) return null;
  throw new JqError(`Cannot index ${typeName(v)} with ${typeName(k)}`);
}

function getpath(v: JqValue, path: JqValue[]): JqValue {
  for (const k of path) {
    if (v === null) return null;
    v = get(v, k);
  }
  return v;
}

function setpath(v: JqValue, path: JqValue[], i: number, nv: JqValue): JqValue {
  if (i === path.length) return nv;
  const k = path[i];
  if (typeof k === 'string') {
    if (v !== null && !isObj(v)) throw new JqError(`Cannot index ${typeName(v)} with "${k}"`);
    const o: Record<string, JqValue> = v === null ? {} : { ...v };
    Object.defineProperty(o, k, {
      value: setpath(v !== null && Object.hasOwn(v, k) ? v[k] : null, path, i + 1, nv),
      enumerable: true, writable: true, configurable: true,
    });
    return o;
  }
  if (typeof k === 'number') {
    if (v !== null && !Array.isArray(v)) throw new JqError(`Cannot index ${typeName(v)} with number`);
    const a: JqValue[] = v === null ? [] : v.slice();
    let idx = Math.floor(k);
    if (idx < 0) { idx += a.length; if (idx < 0) throw new JqError('Out of bounds negative array index'); }
    const r = setpath(idx < a.length ? a[idx] : null, path, i + 1, nv);
    while (a.length < idx) a.push(null);
    a[idx] = r;
    return a;
  }
  if (isObj(k)) {
    if (v !== null && !Array.isArray(v)) throw new JqError(`Cannot update field at object index of ${typeName(v)}`);
    const a: JqValue[] = v ?? [];
    const [s, e] = sliceBounds(a.length, k.start, k.end);
    const r = setpath(a.slice(s, e), path, i + 1, nv);
    if (!Array.isArray(r)) throw new JqError('A slice of an array can only be assigned another array');
    return [...a.slice(0, s), ...r, ...a.slice(e)];
  }
  throw new JqError(`Invalid path component ${compact(k)}`);
}

function delpath(v: JqValue, path: JqValue[], i: number): JqValue {
  if (v === null) return null;
  const k = path[i];
  const last = i === path.length - 1;
  if (typeof k === 'string') {
    if (!isObj(v)) throw new JqError(`Cannot delete field at object index of ${typeName(v)}`);
    if (!Object.hasOwn(v, k)) return v;
    const o = { ...v };
    if (last) delete o[k]; else o[k] = delpath(v[k], path, i + 1);
    return o;
  }
  if (typeof k === 'number') {
    if (!Array.isArray(v)) throw new JqError(`Cannot delete field at array index of ${typeName(v)}`);
    let idx = Math.floor(k);
    if (idx < 0) idx += v.length;
    if (idx < 0 || idx >= v.length) return v;
    const a = v.slice();
    if (last) a.splice(idx, 1); else a[idx] = delpath(v[idx], path, i + 1);
    return a;
  }
  if (isObj(k)) {
    if (!Array.isArray(v)) throw new JqError(`Cannot delete field at object index of ${typeName(v)}`);
    const [s, e] = sliceBounds(v.length, k.start, k.end);
    if (last) return [...v.slice(0, s), ...v.slice(e)];
    const r = delpath(v.slice(s, e), path, i + 1);
    return [...v.slice(0, s), ...r, ...v.slice(e)];
  }
  throw new JqError(`Invalid path component ${compact(k)}`);
}

function delpaths(v: JqValue, paths: JqValue[]): JqValue {
  const sorted = paths.slice().sort((a, b) => compare(b, a));
  for (const p of sorted) {
    if (!Array.isArray(p)) throw new JqError('Path must be specified as an array');
    if (p.length === 0) return null;
    v = delpath(v, p, 0);
  }
  return v;
}

// ───────────────────────── lexer ─────────────────────────

type StrPart = string | { src: string };
type Tok =
  | { k: 'num'; v: number }
  | { k: 'str'; parts: StrPart[] }
  | { k: 'id'; v: string }
  | { k: 'field'; v: string }
  | { k: 'var'; v: string }
  | { k: 'fmt'; v: string }
  | { k: 'op'; v: string }
  | { k: 'eof' };

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*/;
const OPS3 = ['//='];
const OPS2 = ['|=', '+=', '-=', '*=', '/=', '%=', '==', '!=', '<=', '>=', '//', '..'];

function skipString(src: string, i: number): number {
  // i is just after the opening quote; returns index after the closing quote
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      if (src[i + 1] === '(') i = scanParen(src, i + 2) + 1; else i += 2;
    } else if (c === '"') return i + 1;
    else i++;
  }
  throw new CompileError('unterminated string literal');
}
function scanParen(src: string, i: number): number {
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') { if (--depth === 0) return i; }
    else if (c === '"') { i = skipString(src, i + 1); continue; }
    i++;
  }
  throw new CompileError('unterminated string interpolation');
}

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '"') {
      const parts: StrPart[] = [];
      let cur = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new CompileError('unterminated string literal');
        const d = src[i];
        if (d === '"') { i++; break; }
        if (d === '\\') {
          const e = src[i + 1];
          i += 2;
          if (e === 'n') cur += '\n';
          else if (e === 't') cur += '\t';
          else if (e === 'r') cur += '\r';
          else if (e === 'b') cur += '\b';
          else if (e === 'f') cur += '\f';
          else if (e === '/' || e === '\\' || e === '"') cur += e;
          else if (e === 'u') { cur += String.fromCharCode(parseInt(src.slice(i, i + 4), 16)); i += 4; }
          else if (e === '(') {
            const end = scanParen(src, i);
            if (cur) parts.push(cur);
            cur = '';
            parts.push({ src: src.slice(i, end) });
            i = end + 1;
          } else throw new CompileError('invalid escape in string literal');
        } else { cur += d; i++; }
      }
      if (cur || parts.length === 0) parts.push(cur);
      toks.push({ k: 'str', parts });
      continue;
    }
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest))) {
      toks.push({ k: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === '.' && (m = /^\.([A-Za-z_][A-Za-z0-9_]*)/.exec(rest))) {
      toks.push({ k: 'field', v: m[1] });
      i += m[0].length;
      continue;
    }
    if (c === '$' && (m = IDENT.exec(rest.slice(1)))) {
      toks.push({ k: 'var', v: m[0] });
      i += 1 + m[0].length;
      continue;
    }
    if (c === '@' && (m = /^@[A-Za-z0-9_]+/.exec(rest))) {
      toks.push({ k: 'fmt', v: m[0] });
      i += m[0].length;
      continue;
    }
    if ((m = IDENT.exec(rest))) {
      toks.push({ k: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    const op3 = OPS3.find(o => rest.startsWith(o));
    if (op3) { toks.push({ k: 'op', v: op3 }); i += 3; continue; }
    const op2 = OPS2.find(o => rest.startsWith(o));
    if (op2) { toks.push({ k: 'op', v: op2 }); i += 2; continue; }
    if ('.[]{}(),:;|+-*/%<>=?'.includes(c)) { toks.push({ k: 'op', v: c }); i++; continue; }
    throw new CompileError(`syntax error: unexpected character '${c}'`);
  }
  toks.push({ k: 'eof' });
  return toks;
}

// ───────────────────────── parser ─────────────────────────

type Node = any;
type Pat =
  | { k: 'var'; name: string }
  | { k: 'arr'; items: Pat[] }
  | { k: 'obj'; entries: { keyVar?: string; keyNode?: Node; val?: Pat }[] };

const ASSIGN_OPS = new Set(['=', '|=', '+=', '-=', '*=', '/=', '%=', '//=']);
const KEYWORDS = new Set(['def', 'if', 'then', 'elif', 'else', 'end', 'as', 'reduce', 'foreach', 'try', 'catch', 'label', 'import', 'include', 'and', 'or', '__loc__']);

class Parser {
  toks: Tok[];
  pos = 0;
  constructor(src: string) { this.toks = lex(src); }

  peek(o = 0): Tok { return this.toks[Math.min(this.pos + o, this.toks.length - 1)]; }
  next(): Tok { return this.toks[this.pos++]; }
  isOp(v: string, o = 0) { const t = this.peek(o); return t.k === 'op' && t.v === v; }
  isId(v: string, o = 0) { const t = this.peek(o); return t.k === 'id' && t.v === v; }
  eatOp(v: string) { if (this.isOp(v)) { this.pos++; return true; } return false; }
  expectOp(v: string) {
    if (!this.eatOp(v)) throw new CompileError(`syntax error: expected '${v}' but got ${this.describe()}`);
  }
  expectId(v: string) {
    if (!this.isId(v)) throw new CompileError(`syntax error: expected '${v}' but got ${this.describe()}`);
    this.pos++;
  }
  describe(): string {
    const t = this.peek();
    return t.k === 'eof' ? 'end of input' : `'${(t as any).v ?? t.k}'`;
  }

  parseProgram(): Node {
    if (this.peek().k === 'eof') return { t: 'id' };
    const n = this.parsePipe();
    if (this.peek().k !== 'eof') throw new CompileError(`syntax error: unexpected ${this.describe()}`);
    return n;
  }

  // Parses `def f(a; $b): body;` — returns the definition (no trailing expression).
  parseDef() {
    this.expectId('def');
    const nameTok = this.next();
    if (nameTok.k !== 'id') throw new CompileError('syntax error: bad function name');
    const params: string[] = [];
    if (this.eatOp('(')) {
      for (;;) {
        const t = this.next();
        if (t.k === 'var') params.push('$' + t.v);
        else if (t.k === 'id') params.push(t.v);
        else throw new CompileError('syntax error: bad parameter');
        if (this.eatOp(';')) continue;
        this.expectOp(')');
        break;
      }
    }
    this.expectOp(':');
    const body = this.parsePipe();
    this.expectOp(';');
    return { name: nameTok.v, params, body };
  }

  parsePipe(): Node {
    if (this.isId('def')) {
      const d = this.parseDef();
      return { t: 'def', ...d, rest: this.parsePipe() };
    }
    const l = this.parseComma();
    if (this.eatOp('|')) return { t: 'pipe', l, r: this.parsePipe() };
    return l;
  }

  parseComma(): Node {
    let l = this.parseAlt();
    while (this.eatOp(',')) l = { t: 'comma', l, r: this.parseAlt() };
    return l;
  }

  parseAlt(): Node {
    const l = this.parseAssign();
    if (this.eatOp('//')) return { t: 'alt', l, r: this.parseAlt() };
    return l;
  }

  parseAssign(): Node {
    const l = this.parseOr();
    const t = this.peek();
    if (t.k === 'op' && ASSIGN_OPS.has(t.v)) {
      this.pos++;
      return { t: 'assign', op: t.v, l, r: this.parseAlt() };
    }
    return l;
  }

  parseOr(): Node {
    let l = this.parseAnd();
    while (this.isId('or')) { this.pos++; l = { t: 'or', l, r: this.parseAnd() }; }
    return l;
  }

  parseAnd(): Node {
    let l = this.parseCmp();
    while (this.isId('and')) { this.pos++; l = { t: 'and', l, r: this.parseCmp() }; }
    return l;
  }

  parseCmp(): Node {
    const l = this.parseAdd();
    const t = this.peek();
    if (t.k === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)) {
      this.pos++;
      return { t: 'bin', op: t.v, l, r: this.parseAdd() };
    }
    return l;
  }

  parseAdd(): Node {
    let l = this.parseMul();
    for (;;) {
      const t = this.peek();
      if (t.k === 'op' && (t.v === '+' || t.v === '-')) { this.pos++; l = { t: 'bin', op: t.v, l, r: this.parseMul() }; } else return l;
    }
  }

  parseMul(): Node {
    let l = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.k === 'op' && (t.v === '*' || t.v === '/' || t.v === '%')) { this.pos++; l = { t: 'bin', op: t.v, l, r: this.parseUnary() }; } else return l;
    }
  }

  parseUnary(): Node {
    if (this.eatOp('-')) return { t: 'neg', e: this.parseUnary() };
    return this.parsePostfix(true);
  }

  parsePostfix(allowAs: boolean): Node {
    let n = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (t.k === 'field') { this.pos++; n = { t: 'index', target: n, idx: { t: 'lit', v: t.v } }; continue; }
      if (t.k === 'op' && t.v === '.') {
        const nx = this.peek(1);
        if (nx.k === 'str') { this.pos += 2; n = { t: 'index', target: n, idx: this.strNode(nx, null) }; continue; }
        if (nx.k === 'op' && nx.v === '[') { this.pos++; continue; }
        break;
      }
      if (t.k === 'op' && t.v === '[') { this.pos++; n = this.parseBracket(n); continue; }
      if (t.k === 'op' && t.v === '?') { this.pos++; n = { t: 'try', body: n, catch: null }; continue; }
      if (allowAs && t.k === 'id' && t.v === 'as') {
        this.pos++;
        const pat = this.parsePattern();
        if (this.isOp('?') && this.isOp('//', 1)) throw new CompileError('destructuring alternatives (?//) are not supported');
        this.expectOp('|');
        return { t: 'as', src: n, pat, body: this.parsePipe() };
      }
      break;
    }
    return n;
  }

  parseBracket(target: Node): Node {
    if (this.eatOp(']')) return { t: 'iter', target };
    if (this.eatOp(':')) {
      const to = this.parsePipe();
      this.expectOp(']');
      return { t: 'slice', target, from: null, to };
    }
    const idx = this.parsePipe();
    if (this.eatOp(':')) {
      const to = this.isOp(']') ? null : this.parsePipe();
      this.expectOp(']');
      return { t: 'slice', target, from: idx, to };
    }
    this.expectOp(']');
    return { t: 'index', target, idx };
  }

  parsePattern(): Pat {
    const t = this.next();
    if (t.k === 'var') return { k: 'var', name: t.v };
    if (t.k === 'op' && t.v === '[') {
      const items: Pat[] = [];
      for (;;) {
        items.push(this.parsePattern());
        if (this.eatOp(',')) continue;
        this.expectOp(']');
        break;
      }
      return { k: 'arr', items };
    }
    if (t.k === 'op' && t.v === '{') {
      const entries: { keyVar?: string; keyNode?: Node; val?: Pat }[] = [];
      for (;;) {
        const kt = this.next();
        const e: { keyVar?: string; keyNode?: Node; val?: Pat } = {};
        if (kt.k === 'var') e.keyVar = kt.v;
        else if (kt.k === 'id') e.keyNode = { t: 'lit', v: kt.v };
        else if (kt.k === 'str') e.keyNode = this.strNode(kt, null);
        else if (kt.k === 'op' && kt.v === '(') { e.keyNode = this.parsePipe(); this.expectOp(')'); }
        else throw new CompileError('syntax error: bad object pattern');
        if (this.eatOp(':')) e.val = this.parsePattern();
        else if (e.keyVar === undefined) throw new CompileError('syntax error: object pattern needs a value pattern');
        entries.push(e);
        if (this.eatOp(',')) continue;
        this.expectOp('}');
        break;
      }
      return { k: 'obj', entries };
    }
    throw new CompileError('syntax error: bad pattern');
  }

  strNode(t: Tok & { k: 'str' }, fmt: string | null): Node {
    const parts = t.parts.map(p => (typeof p === 'string' ? p : new Parser(p.src).parseProgram()));
    if (parts.length === 1 && typeof parts[0] === 'string') return { t: 'lit', v: parts[0] };
    return { t: 'str', parts, fmt };
  }

  parsePrimary(): Node {
    const t = this.next();
    switch (t.k) {
      case 'num': return { t: 'lit', v: t.v };
      case 'str': return this.strNode(t, null);
      case 'field': return { t: 'index', target: { t: 'id' }, idx: { t: 'lit', v: t.v } };
      case 'var': return { t: 'var', name: t.v };
      case 'fmt': {
        const nx = this.peek();
        if (nx.k === 'str') { this.pos++; return this.strNode(nx, t.v) ; }
        return { t: 'fmt', name: t.v };
      }
      case 'op':
        switch (t.v) {
          case '.': {
            const nx = this.peek();
            if (nx.k === 'str') { this.pos++; return { t: 'index', target: { t: 'id' }, idx: this.strNode(nx, null) }; }
            return { t: 'id' };
          }
          case '..': return { t: 'recurse' };
          case '(': { const e = this.parsePipe(); this.expectOp(')'); return e; }
          case '[': {
            if (this.eatOp(']')) return { t: 'arr', body: null };
            const body = this.parsePipe();
            this.expectOp(']');
            return { t: 'arr', body };
          }
          case '{': return this.parseObject();
          case '-': return { t: 'neg', e: this.parsePostfix(true) };
        }
        break;
      case 'id': return this.parseIdent(t.v);
    }
    this.pos--;
    throw new CompileError(`syntax error: unexpected ${this.describe()}`);
  }

  parseIdent(name: string): Node {
    switch (name) {
      case 'true': return { t: 'lit', v: true };
      case 'false': return { t: 'lit', v: false };
      case 'null': return { t: 'lit', v: null };
      case 'if': return this.parseIf();
      case 'try': {
        const body = this.parsePostfix(false);
        let c: Node = null;
        if (this.isId('catch')) { this.pos++; c = this.parsePostfix(false); }
        return { t: 'try', body, catch: c };
      }
      case 'reduce': {
        const src = this.parsePostfix(false);
        this.expectId('as');
        const pat = this.parsePattern();
        this.expectOp('(');
        const init = this.parsePipe();
        this.expectOp(';');
        const upd = this.parsePipe();
        this.expectOp(')');
        return { t: 'reduce', src, pat, init, upd };
      }
      case 'foreach': {
        const src = this.parsePostfix(false);
        this.expectId('as');
        const pat = this.parsePattern();
        this.expectOp('(');
        const init = this.parsePipe();
        this.expectOp(';');
        const upd = this.parsePipe();
        let ext: Node = null;
        if (this.eatOp(';')) ext = this.parsePipe();
        this.expectOp(')');
        return { t: 'foreach', src, pat, init, upd, ext };
      }
      case 'label': {
        const v = this.next();
        if (v.k !== 'var') throw new CompileError('syntax error: label needs a $name');
        this.expectOp('|');
        return { t: 'label', name: v.v, body: this.parsePipe() };
      }
      case 'def': {
        this.pos--;
        const d = this.parseDef();
        return { t: 'def', ...d, rest: this.parsePipe() };
      }
      case 'break': {
        const v = this.next();
        if (v.k !== 'var') throw new CompileError('syntax error: break needs a $name');
        return { t: 'break', name: v.v };
      }
    }
    if (KEYWORDS.has(name)) { this.pos--; throw new CompileError(`syntax error: unexpected '${name}'`); }
    const args: Node[] = [];
    if (this.eatOp('(')) {
      for (;;) {
        args.push(this.parsePipe());
        if (this.eatOp(';')) continue;
        this.expectOp(')');
        break;
      }
    }
    return { t: 'call', name, args };
  }

  parseIf(): Node {
    const cond = this.parsePipe();
    this.expectId('then');
    const then = this.parsePipe();
    let els: Node = null;
    if (this.isId('elif')) {
      this.pos++;
      els = this.parseIf();
      return { t: 'if', cond, then, else: els };
    }
    if (this.isId('else')) { this.pos++; els = this.parsePipe(); }
    this.expectId('end');
    return { t: 'if', cond, then, else: els };
  }

  parseObjVal(): Node {
    let n = this.parseAlt();
    while (this.eatOp('|')) n = { t: 'pipe', l: n, r: this.parseAlt() };
    return n;
  }

  parseObject(): Node {
    const entries: { key: Node; val: Node }[] = [];
    if (this.eatOp('}')) return { t: 'obj', entries };
    for (;;) {
      const kt = this.next();
      let key: Node;
      let val: Node | null = null;
      if (kt.k === 'var') {
        key = { t: 'lit', v: kt.v };
        val = { t: 'var', name: kt.v };
      } else if (kt.k === 'id' || kt.k === 'num') {
        key = { t: 'lit', v: String((kt as any).v) };
      } else if (kt.k === 'str') {
        key = this.strNode(kt, null);
      } else if (kt.k === 'fmt') {
        const s = this.next();
        if (s.k !== 'str') throw new CompileError('syntax error: format in object key needs a string');
        key = this.strNode(s, kt.v);
      } else if (kt.k === 'op' && kt.v === '(') {
        key = this.parsePipe();
        this.expectOp(')');
        if (!this.isOp(':')) throw new CompileError('syntax error: object key expression needs a value');
      } else {
        this.pos--;
        throw new CompileError(`syntax error: unexpected ${this.describe()} in object construction`);
      }
      if (this.eatOp(':')) val = this.parseObjVal();
      else if (!val) val = { t: 'index', target: { t: 'id' }, idx: key };
      entries.push({ key, val });
      if (this.eatOp(',')) continue;
      this.expectOp('}');
      break;
    }
    return { t: 'obj', entries };
  }
}

// ───────────────────────── evaluator ─────────────────────────

interface Env {
  parent: Env | null;
  kind: 'var' | 'fn' | 'closure' | 'label';
  name: string;
  arity: number;
  val?: any;       // var value / label token
  node?: Node;     // closure node or fn body
  params?: string[];
  env?: Env;       // closure env or fn definition env
}

const bindVar = (parent: Env | null, name: string, val: any): Env => ({ parent, kind: 'var', name, arity: 0, val });

function lookup(env: Env | null, kind: Env['kind'][], name: string, arity: number): Env | null {
  for (let e = env; e; e = e.parent) {
    if (e.name === name && e.arity === arity && kind.includes(e.kind)) return e;
  }
  return null;
}

interface Runtime {
  env: Record<string, string>;
  inputs: JqValue[];
  pos: number;
  stderr: string[];
  filename: string | null;
}
let RT: Runtime = { env: {}, inputs: [], pos: 0, stderr: [], filename: null };

function* ev(n: Node, v: JqValue, p: Path, env: Env | null): Generator<Out> {
  switch (n.t) {
    case 'id': yield [v, p]; return;
    case 'lit': yield [n.v, pv(p)]; return;
    case 'recurse': yield* recurseAll(v, p); return;
    case 'index': {
      for (const [t, tp] of ev(n.target, v, p, env)) {
        for (const [k] of ev(n.idx, v, null, env)) {
          if (tp === undefined) throw new JqError(`Invalid path expression with result ${compact(t).slice(0, 30)}`);
          yield [get(t, k), tp === null ? null : [...tp, k]];
        }
      }
      return;
    }
    case 'slice': {
      for (const [t, tp] of ev(n.target, v, p, env)) {
        for (const [to] of n.to ? ev(n.to, v, null, env) : [[null]]) {
          for (const [from] of n.from ? ev(n.from, v, null, env) : [[null]]) {
            if (tp === undefined) throw new JqError('Invalid path expression');
            const k = { start: from, end: to };
            yield [get(t, k), tp === null ? null : [...tp, k]];
          }
        }
      }
      return;
    }
    case 'iter': {
      for (const [t, tp] of ev(n.target, v, p, env)) {
        if (tp === undefined) throw new JqError(`Invalid path expression with result ${compact(t).slice(0, 30)}`);
        if (Array.isArray(t)) {
          for (let i = 0; i < t.length; i++) yield [t[i], tp === null ? null : [...tp, i]];
        } else if (isObj(t)) {
          for (const k of Object.keys(t)) yield [t[k], tp === null ? null : [...tp, k]];
        } else throw new JqError(`Cannot iterate over ${t === null ? 'null' : errDesc(t)}`);
      }
      return;
    }
    case 'try': {
      try {
        yield* ev(n.body, v, p, env);
      } catch (e) {
        if (!(e instanceof JqError)) throw e;
        if (n.catch) yield* ev(n.catch, e.value, pv(p), env);
      }
      return;
    }
    case 'str': {
      const parts: any[] = n.parts;
      function* gen(i: number): Generator<string> {
        if (i < 0) { yield ''; return; }
        const part = parts[i];
        if (typeof part === 'string') { for (const pre of gen(i - 1)) yield pre + part; return; }
        for (const [x] of ev(part, v, null, env)) {
          const s = n.fmt ? applyFormat(n.fmt, x) : (typeof x === 'string' ? x : compact(x));
          for (const pre of gen(i - 1)) yield pre + s;
        }
      }
      for (const s of gen(parts.length - 1)) yield [s, pv(p)];
      return;
    }
    case 'fmt': yield [applyFormat(n.name, v), pv(p)]; return;
    case 'pipe':
      for (const [a, ap] of ev(n.l, v, p, env)) yield* ev(n.r, a, ap, env);
      return;
    case 'comma':
      yield* ev(n.l, v, p, env);
      yield* ev(n.r, v, p, env);
      return;
    case 'neg':
      for (const [x] of ev(n.e, v, null, env)) {
        if (typeof x !== 'number') throw new JqError(`${errDesc(x)} cannot be negated`);
        yield [-x, pv(p)];
      }
      return;
    case 'bin':
      for (const [b] of ev(n.r, v, null, env)) {
        for (const [a] of ev(n.l, v, null, env)) yield [binop(n.op, a, b), pv(p)];
      }
      return;
    case 'and':
      for (const [a] of ev(n.l, v, null, env)) {
        if (!truthy(a)) { yield [false, pv(p)]; continue; }
        for (const [b] of ev(n.r, v, null, env)) yield [truthy(b), pv(p)];
      }
      return;
    case 'or':
      for (const [a] of ev(n.l, v, null, env)) {
        if (truthy(a)) { yield [true, pv(p)]; continue; }
        for (const [b] of ev(n.r, v, null, env)) yield [truthy(b), pv(p)];
      }
      return;
    case 'alt': {
      let any = false;
      try {
        for (const o of ev(n.l, v, p, env)) {
          if (truthy(o[0])) { any = true; yield o; }
        }
      } catch (e) {
        if (!(e instanceof JqError)) throw e;
      }
      if (!any) yield* ev(n.r, v, p, env);
      return;
    }
    case 'assign': yield* evAssign(n, v, p, env); return;
    case 'if':
      for (const [c] of ev(n.cond, v, null, env)) {
        if (truthy(c)) yield* ev(n.then, v, p, env);
        else if (n.else) yield* ev(n.else, v, p, env);
        else yield [v, p];
      }
      return;
    case 'reduce': {
      for (const [init] of ev(n.init, v, null, env)) {
        let acc = init;
        for (const [x] of ev(n.src, v, null, env)) {
          for (const e2 of bindPattern(n.pat, x, v, env)) {
            let last: JqValue = null;
            let seen = false;
            for (const [r] of ev(n.upd, acc, null, e2)) { last = r; seen = true; }
            acc = seen ? last : null;
          }
        }
        yield [acc, pv(p)];
      }
      return;
    }
    case 'foreach': {
      for (const [init] of ev(n.init, v, null, env)) {
        let acc = init;
        for (const [x] of ev(n.src, v, null, env)) {
          for (const e2 of bindPattern(n.pat, x, v, env)) {
            for (const [r] of ev(n.upd, acc, null, e2)) {
              acc = r;
              if (n.ext) { for (const [o] of ev(n.ext, r, null, e2)) yield [o, pv(p)]; } else yield [r, pv(p)];
            }
          }
        }
      }
      return;
    }
    case 'as':
      for (const [x] of ev(n.src, v, null, env)) {
        for (const e2 of bindPattern(n.pat, x, v, env)) yield* ev(n.body, v, p, e2);
      }
      return;
    case 'def': {
      const entry: Env = { parent: env, kind: 'fn', name: n.name, arity: n.params.length, node: n.body, params: n.params };
      entry.env = entry;
      yield* ev(n.rest, v, p, entry);
      return;
    }
    case 'label': {
      const token = {};
      const e2: Env = { parent: env, kind: 'label', name: n.name, arity: 0, val: token };
      try {
        yield* ev(n.body, v, p, e2);
      } catch (e) {
        if (!(e instanceof BreakSignal) || e.label !== token) throw e;
      }
      return;
    }
    case 'break': {
      const l = lookup(env, ['label'], n.name, 0);
      if (!l) throw new CompileError(`$*label-${n.name} is not defined`);
      throw new BreakSignal(l.val);
    }
    case 'var': {
      const e = lookup(env, ['var'], n.name, 0);
      if (e) { yield [e.val, pv(p)]; return; }
      if (n.name === '__loc__') { yield [{ file: '<top-level>', line: 1 }, pv(p)]; return; }
      if (n.name === 'ENV') { yield [{ ...RT.env }, pv(p)]; return; }
      throw new CompileError(`$${n.name} is not defined`);
    }
    case 'arr': {
      const out: JqValue[] = [];
      if (n.body) for (const [x] of ev(n.body, v, null, env)) out.push(x);
      yield [out, pv(p)];
      return;
    }
    case 'obj': {
      const entries: { key: Node; val: Node }[] = n.entries;
      function* gen(i: number, acc: Record<string, JqValue>): Generator<Record<string, JqValue>> {
        if (i === entries.length) { yield acc; return; }
        for (const [k] of ev(entries[i].key, v, null, env)) {
          if (typeof k !== 'string') throw new JqError(`Object keys must be strings`);
          for (const [x] of ev(entries[i].val, v, null, env)) {
            const o = { ...acc };
            Object.defineProperty(o, k, { value: x, enumerable: true, writable: true, configurable: true });
            yield* gen(i + 1, o);
          }
        }
      }
      for (const o of gen(0, {})) yield [o, pv(p)];
      return;
    }
    case 'call': yield* evCall(n, v, p, env); return;
  }
  throw new CompileError(`internal: unknown node ${n.t}`);
}

function* recurseAll(v: JqValue, p: Path): Generator<Out> {
  yield [v, p];
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) yield* recurseAll(v[i], p === null ? null : p === undefined ? undefined : [...p, i]);
  } else if (isObj(v)) {
    for (const k of Object.keys(v)) yield* recurseAll(v[k], p === null ? null : p === undefined ? undefined : [...p, k]);
  }
}

function* bindPattern(pat: Pat, val: JqValue, input: JqValue, env: Env | null): Generator<Env | null> {
  if (pat.k === 'var') { yield bindVar(env, pat.name, val); return; }
  if (pat.k === 'arr') {
    if (val !== null && !Array.isArray(val)) throw new JqError(`Cannot index ${typeName(val)} with number`);
    const pitems = pat.items;
    function* items(i: number, e: Env | null): Generator<Env | null> {
      if (i === pitems.length) { yield e; return; }
      for (const e2 of bindPattern(pitems[i], val === null ? null : (val[i] ?? null), input, e)) yield* items(i + 1, e2);
    }
    yield* items(0, env);
    return;
  }
  const pentries = pat.entries;
  function* entries(i: number, e: Env | null): Generator<Env | null> {
    if (i === pentries.length) { yield e; return; }
    const ent = pentries[i];
    if (ent.keyVar !== undefined) {
      const x = get(val, ent.keyVar);
      const e1 = bindVar(e, ent.keyVar, x);
      if (ent.val) { for (const e2 of bindPattern(ent.val, x, input, e1)) yield* entries(i + 1, e2); } else yield* entries(i + 1, e1);
      return;
    }
    for (const [k] of ev(ent.keyNode, input, null, e)) {
      if (typeof k !== 'string') throw new JqError(`Cannot index ${typeName(val)} with ${typeName(k)}`);
      const x = get(val, k);
      for (const e2 of bindPattern(ent.val!, x, input, e)) yield* entries(i + 1, e2);
    }
  }
  yield* entries(0, env);
}

function* evAssign(n: Node, v: JqValue, p: Path, env: Env | null): Generator<Out> {
  const paths: any[][] = [];
  for (const [, lp] of ev(n.l, v, [], env)) {
    if (!lp) throw new JqError('Invalid path expression');
    paths.push(lp);
  }
  if (n.op === '|=') {
    let acc = v;
    const dels: any[][] = [];
    for (const pp of paths) {
      const cur = getpath(acc, pp);
      let got = false;
      let res: JqValue = null;
      for (const [r] of ev(n.r, cur, null, env)) { res = r; got = true; break; }
      if (got) acc = setpath(acc, pp, 0, res); else dels.push(pp);
    }
    if (dels.length) acc = delpaths(acc, dels);
    yield [acc, pv(p)];
    return;
  }
  for (const [rv] of ev(n.r, v, null, env)) {
    let acc = v;
    for (const pp of paths) {
      let nv: JqValue;
      if (n.op === '=') nv = rv;
      else {
        const cur = getpath(acc, pp);
        nv = n.op === '//=' ? (truthy(cur) ? cur : rv) : binop(n.op.slice(0, -1), cur, rv);
      }
      acc = setpath(acc, pp, 0, nv);
    }
    yield [acc, pv(p)];
  }
}

function* evCall(n: Node, v: JqValue, p: Path, env: Env | null): Generator<Out> {
  const arity = n.args.length;
  const found = lookup(env, ['fn', 'closure'], n.name, arity);
  if (found) {
    if (found.kind === 'closure') { yield* ev(found.node, v, p, found.env!); return; }
    const params = found.params!;
    const defEnv = found.env!;
    // bind params (closures); `$name` params are evaluated eagerly (cartesian)
    function* bind(i: number, e: Env | null): Generator<Env | null> {
      if (i === params.length) { yield e; return; }
      const prm = params[i];
      if (prm[0] === '$') {
        const nm = prm.slice(1);
        for (const [x] of ev(n.args[i], v, null, env)) {
          const e1: Env = { parent: e, kind: 'closure', name: nm, arity: 0, node: { t: 'lit', v: x }, env: null as any };
          yield* bind(i + 1, bindVar(e1, nm, x));
        }
      } else {
        yield* bind(i + 1, { parent: e, kind: 'closure', name: prm, arity: 0, node: n.args[i], env });
      }
    }
    for (const callEnv of bind(0, defEnv)) yield* ev(found.node, v, p, callEnv);
    return;
  }
  const nat = NATIVES[`${n.name}/${arity}`];
  if (nat) { yield* nat(n.args, v, p, env); return; }
  if (arity === 0) {
    const g = lookup(env, ['var'], n.name, 0);
    if (g) { yield [g.val, pv(p)]; return; }
  }
  throw new CompileError(`${n.name}/${arity} is not defined`);
}

// ───────────────────────── natives ─────────────────────────

type Native = (args: Node[], v: JqValue, p: Path, env: Env | null) => Generator<Out>;
const NATIVES: Record<string, Native> = {};

function* cartesian(args: Node[], v: JqValue, env: Env | null): Generator<JqValue[]> {
  function* rec(i: number, acc: JqValue[]): Generator<JqValue[]> {
    if (i < 0) { yield acc.slice(); return; }
    for (const [x] of ev(args[i], v, null, env)) { acc[i] = x; yield* rec(i - 1, acc); }
  }
  yield* rec(args.length - 1, new Array(args.length));
}

function def0(name: string, f: (v: JqValue) => JqValue) {
  NATIVES[`${name}/0`] = function* (_a, v, p) { yield [f(v), pv(p)]; };
}
function defN(name: string, arity: number, f: (v: JqValue, ...a: JqValue[]) => JqValue) {
  NATIVES[`${name}/${arity}`] = function* (args, v, p, env) {
    for (const a of cartesian(args, v, env)) yield [f(v, ...a), pv(p)];
  };
}
function defG(name: string, arity: number, f: Native) { NATIVES[`${name}/${arity}`] = f; }

const sortKeyed = (v: JqValue, f: Node, env: Env | null, who: string) => {
  if (!Array.isArray(v)) throw new JqError(`Cannot index ${typeName(v)} with number`);
  const items = v.map((x, i) => ({ x, i, k: Array.from(ev(f, x, null, env), o => o[0]) }));
  items.sort((a, b) => compare(a.k, b.k) || a.i - b.i);
  void who;
  return items;
};

function mathFn(name: string, f: (x: number) => number) {
  def0(name, v => {
    if (typeof v !== 'number') throw new JqError(`${errDesc(v)} number required`);
    return f(v);
  });
}
for (const [k, f] of Object.entries({
  floor: Math.floor, ceil: Math.ceil, sqrt: Math.sqrt, fabs: Math.abs, exp: Math.exp, exp2: (x: number) => 2 ** x,
  exp10: (x: number) => 10 ** x, log: Math.log, log2: Math.log2, log10: Math.log10, sin: Math.sin, cos: Math.cos,
  tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  trunc: Math.trunc, cbrt: Math.cbrt, round: (x: number) => Math.sign(x) * Math.round(Math.abs(x)),
} as Record<string, (x: number) => number>)) mathFn(k, f);
defN('pow', 2, (_v, a, b) => a ** b);
defN('atan2', 2, (_v, a, b) => Math.atan2(a, b));
defN('fmin', 2, (_v, a, b) => Math.min(a, b));
defN('fmax', 2, (_v, a, b) => Math.max(a, b));
defN('fmod', 2, (_v, a, b) => a % b);
def0('infinite', () => Infinity);
def0('nan', () => NaN);
def0('isinfinite', v => typeof v === 'number' && !Number.isFinite(v) && !Number.isNaN(v));
def0('isnan', v => typeof v === 'number' && Number.isNaN(v));
def0('isnormal', v => typeof v === 'number' && Number.isFinite(v) && v !== 0);
def0('now', () => Date.now() / 1000);

defG('empty', 0, function* () {});
defG('error', 0, function* (_a, v) { throw new JqError(v); });
defG('error', 1, function* (a, v, _p, env) { for (const [m] of ev(a[0], v, null, env)) throw new JqError(m); });
def0('not', v => !truthy(v));
defG('select', 1, function* (a, v, p, env) { for (const [c] of ev(a[0], v, null, env)) if (truthy(c)) yield [v, p]; });
defG('path', 1, function* (a, v, p, env) {
  for (const [, xp] of ev(a[0], v, [], env)) {
    if (!xp) throw new JqError('Invalid path expression');
    yield [xp, pv(p)];
  }
});
defG('getpath', 1, function* (a, v, p, env) {
  for (const [pa] of ev(a[0], v, null, env)) {
    if (!Array.isArray(pa)) throw new JqError('Path must be specified as an array');
    let r: JqValue;
    try { r = getpath(v, pa); } catch (e) { if (p === null) throw e; r = null; }
    yield [r, p === null ? null : p === undefined ? undefined : [...p, ...pa]];
  }
});
defN('setpath', 2, (v, pa, nv) => {
  if (!Array.isArray(pa)) throw new JqError('Path must be specified as an array');
  return setpath(v, pa, 0, nv);
});
defN('delpaths', 1, (v, ps) => {
  if (!Array.isArray(ps)) throw new JqError('Paths must be specified as an array');
  return delpaths(v, ps);
});
defG('recurse', 1, function* (a, v, p, env) {
  const stack: Iterator<Out>[] = [[[v, p] as Out][Symbol.iterator]()];
  while (stack.length) {
    const r = stack[stack.length - 1].next();
    if (r.done) { stack.pop(); continue; }
    yield r.value;
    stack.push(ev(a[0], r.value[0], r.value[1], env));
  }
});
defG('recurse', 0, function* (_a, v, p) { yield* recurseAll(v, p); });
defG('recurse', 2, function* (a, v, p, env) {
  const stack: Iterator<Out>[] = [[[v, p] as Out][Symbol.iterator]()];
  while (stack.length) {
    const r = stack[stack.length - 1].next();
    if (r.done) { stack.pop(); continue; }
    let ok = false;
    for (const [c] of ev(a[1], r.value[0], null, env)) { ok = truthy(c); break; }
    if (!ok) continue;
    yield r.value;
    stack.push(ev(a[0], r.value[0], r.value[1], env));
  }
});
defG('while', 2, function* (a, v, p, env) {
  const stack: Iterator<Out>[] = [[[v, p] as Out][Symbol.iterator]()];
  while (stack.length) {
    const r = stack[stack.length - 1].next();
    if (r.done) { stack.pop(); continue; }
    let ok = false;
    for (const [c] of ev(a[0], r.value[0], null, env)) { ok = truthy(c); break; }
    if (!ok) continue;
    yield r.value;
    stack.push(ev(a[1], r.value[0], r.value[1], env));
  }
});
defG('until', 2, function* (a, v, p, env) {
  const stack: Iterator<Out>[] = [[[v, p] as Out][Symbol.iterator]()];
  while (stack.length) {
    const r = stack[stack.length - 1].next();
    if (r.done) { stack.pop(); continue; }
    let ok = false;
    for (const [c] of ev(a[0], r.value[0], null, env)) { ok = truthy(c); break; }
    if (ok) yield r.value;
    else stack.push(ev(a[1], r.value[0], r.value[1], env));
  }
});
defG('repeat', 1, function* (a, v, p, env) {
  const stack: Iterator<Out>[] = [[[v, p] as Out][Symbol.iterator]()];
  while (stack.length) {
    const r = stack[stack.length - 1].next();
    if (r.done) { stack.pop(); continue; }
    yield r.value;
    stack.push(ev(a[0], r.value[0], r.value[1], env));
  }
});
defG('range', 1, function* (a, v, p, env) {
  for (const [n] of ev(a[0], v, null, env)) {
    if (typeof n !== 'number') throw new JqError('Range bounds must be numeric');
    for (let i = 0; i < n; i++) yield [i, pv(p)];
  }
});
defG('range', 2, function* (a, v, p, env) {
  for (const [from] of ev(a[0], v, null, env)) {
    for (const [to] of ev(a[1], v, null, env)) {
      if (typeof from !== 'number' || typeof to !== 'number') throw new JqError('Range bounds must be numeric');
      for (let i = from; i < to; i++) yield [i, pv(p)];
    }
  }
});
defG('range', 3, function* (a, v, p, env) {
  for (const [from] of ev(a[0], v, null, env)) {
    for (const [to] of ev(a[1], v, null, env)) {
      for (const [by] of ev(a[2], v, null, env)) {
        if (typeof from !== 'number' || typeof to !== 'number' || typeof by !== 'number') throw new JqError('Range bounds must be numeric');
        if (by > 0) for (let i = from; i < to; i += by) yield [i, pv(p)];
        else if (by < 0) for (let i = from; i > to; i += by) yield [i, pv(p)];
        else if (from < to) for (;;) yield [from, pv(p)];
      }
    }
  }
});
defG('limit', 2, function* (a, v, p, env) {
  for (const [n] of ev(a[0], v, null, env)) {
    if (typeof n !== 'number') throw new JqError('Invalid limit');
    if (n <= 0) continue;
    let c = 0;
    for (const o of ev(a[1], v, p, env)) { yield o; if (++c >= n) break; }
  }
});
defG('first', 1, function* (a, v, p, env) { for (const o of ev(a[0], v, p, env)) { yield o; return; } });
defG('last', 1, function* (a, v, p, env) {
  let last: Out | null = null;
  for (const o of ev(a[0], v, p, env)) last = o;
  if (last) yield last;
});
defG('nth', 2, function* (a, v, p, env) {
  for (const [n] of ev(a[0], v, null, env)) {
    if (typeof n !== 'number' || n < 0) throw new JqError('Out of bounds negative array index');
    let i = 0;
    for (const o of ev(a[1], v, p, env)) { if (i++ === n) { yield o; break; } }
  }
});
defG('isempty', 1, function* (a, v, p, env) {
  for (const _ of ev(a[0], v, null, env)) { yield [false, pv(p)]; return; }
  yield [true, pv(p)];
});
defG('any', 2, function* (a, v, p, env) {
  for (const [x] of ev(a[0], v, null, env)) {
    for (const [c] of ev(a[1], x, null, env)) if (truthy(c)) { yield [true, pv(p)]; return; }
  }
  yield [false, pv(p)];
});
defG('all', 2, function* (a, v, p, env) {
  for (const [x] of ev(a[0], v, null, env)) {
    for (const [c] of ev(a[1], x, null, env)) if (!truthy(c)) { yield [false, pv(p)]; return; }
  }
  yield [true, pv(p)];
});
defG('input', 0, function* (_a, _v, p) {
  if (RT.pos >= RT.inputs.length) throw new JqError('No more inputs');
  yield [RT.inputs[RT.pos++], pv(p)];
});
defG('inputs', 0, function* (_a, _v, p) { while (RT.pos < RT.inputs.length) yield [RT.inputs[RT.pos++], pv(p)]; });
defG('debug', 0, function* (_a, v, p) { RT.stderr.push(`["DEBUG:",${compact(v)}]\n`); yield [v, p]; });
defG('debug', 1, function* (a, v, p, env) {
  for (const [m] of ev(a[0], v, null, env)) RT.stderr.push(`["DEBUG:",${compact(m)}]\n`);
  yield [v, p];
});
defG('stderr', 0, function* (_a, v, p) { RT.stderr.push(compact(v)); yield [v, p]; });
defG('input_filename', 0, function* (_a, _v, p) { yield [RT.filename, pv(p)]; });
def0('input_line_number', () => 0);
defG('halt', 0, function* () { throw new HaltSignal(0, ''); });
defG('halt_error', 1, function* (a, v, _p, env) {
  for (const [c] of ev(a[0], v, null, env)) {
    throw new HaltSignal(c, typeof v === 'string' ? v : compact(v) + '\n');
  }
});

def0('length', v => {
  if (v === null) return 0;
  if (typeof v === 'boolean') throw new JqError('boolean (' + v + ') has no length');
  if (typeof v === 'number') return Math.abs(v);
  if (typeof v === 'string') return Array.from(v).length;
  if (Array.isArray(v)) return v.length;
  return Object.keys(v).length;
});
def0('utf8bytelength', v => {
  if (typeof v !== 'string') throw new JqError(`${errDesc(v)} only strings have UTF-8 byte length`);
  return new TextEncoder().encode(v).length;
});
def0('type', typeName);
def0('keys', v => {
  if (Array.isArray(v)) return v.map((_, i) => i);
  if (isObj(v)) return Object.keys(v).sort(cmpStr);
  throw new JqError(`${errDesc(v)} has no keys`);
});
def0('keys_unsorted', v => {
  if (Array.isArray(v)) return v.map((_, i) => i);
  if (isObj(v)) return Object.keys(v);
  throw new JqError(`${errDesc(v)} has no keys`);
});
defN('has', 1, (v, k) => {
  if (isObj(v) && typeof k === 'string') return Object.hasOwn(v, k);
  if (Array.isArray(v) && typeof k === 'number') return k >= 0 && k < v.length;
  throw new JqError(`Cannot check whether ${typeName(v)} has a ${typeof k === 'string' ? 'string' : typeName(k)} key`);
});
function contains(a: JqValue, b: JqValue): boolean {
  if (isObj(a) && isObj(b)) return Object.keys(b).every(k => Object.hasOwn(a, k) && contains(a[k], b[k]));
  if (Array.isArray(a) && Array.isArray(b)) return b.every(y => a.some(x => contains(x, y)));
  if (typeof a === 'string' && typeof b === 'string') return a.includes(b);
  if (typeName(a) === typeName(b)) return compare(a, b) === 0;
  throw new JqError(`${errDesc(a)} and ${errDesc(b)} cannot have their containment checked`);
}
defN('contains', 1, (v, b) => contains(v, b));
def0('add', v => {
  const items = Array.isArray(v) ? v : isObj(v) ? Object.values(v) : null;
  if (!items) throw new JqError(`Cannot iterate over ${errDesc(v)}`);
  return items.reduce((acc, x) => binop('+', acc, x), null);
});
def0('reverse', v => {
  if (v === null) return [];
  if (typeof v === 'string') return Array.from(v).reverse().join('');
  if (Array.isArray(v)) return v.slice().reverse();
  throw new JqError(`Cannot reverse ${errDesc(v)}`);
});
def0('sort', v => {
  if (!Array.isArray(v)) throw new JqError(`${errDesc(v)} cannot be sorted, as it is not an array`);
  return v.slice().sort(compare);
});
def0('unique', v => {
  if (!Array.isArray(v)) throw new JqError(`${errDesc(v)} cannot be sorted, as it is not an array`);
  const s = v.slice().sort(compare);
  return s.filter((x, i) => i === 0 || compare(s[i - 1], x) !== 0);
});
def0('min', v => (Array.isArray(v) ? (v.length ? v.reduce((m, x) => (compare(x, m) < 0 ? x : m)) : null) : (() => { throw new JqError(`Cannot index ${typeName(v)} with number`); })()));
def0('max', v => (Array.isArray(v) ? (v.length ? v.reduce((m, x) => (compare(x, m) >= 0 ? x : m)) : null) : (() => { throw new JqError(`Cannot index ${typeName(v)} with number`); })()));
defG('sort_by', 1, function* (a, v, p, env) { yield [sortKeyed(v, a[0], env, 'sort_by').map(i => i.x), pv(p)]; });
defG('group_by', 1, function* (a, v, p, env) {
  const out: JqValue[][] = [];
  let prev: JqValue = undefined;
  for (const it of sortKeyed(v, a[0], env, 'group_by')) {
    if (out.length && compare(prev, it.k) === 0) out[out.length - 1].push(it.x);
    else { out.push([it.x]); prev = it.k; }
  }
  yield [out, pv(p)];
});
defG('unique_by', 1, function* (a, v, p, env) {
  const out: JqValue[] = [];
  let prev: JqValue = undefined;
  let first = true;
  for (const it of sortKeyed(v, a[0], env, 'unique_by')) {
    if (first || compare(prev, it.k) !== 0) { out.push(it.x); prev = it.k; first = false; }
  }
  yield [out, pv(p)];
});
defG('min_by', 1, function* (a, v, p, env) {
  const items = sortKeyed(v, a[0], env, 'min_by');
  yield [items.length ? items[0].x : null, pv(p)];
});
defG('max_by', 1, function* (a, v, p, env) {
  const items = sortKeyed(v, a[0], env, 'max_by');
  if (!items.length) { yield [null, pv(p)]; return; }
  let best = items[0];
  for (const it of items) if (compare(it.k, best.k) >= 0) best = it;
  yield [best.x, pv(p)];
});
function flatten(a: JqValue[], depth: number): JqValue[] {
  return a.reduce((acc: JqValue[], x) => (Array.isArray(x) && depth > 0 ? acc.concat(flatten(x, depth - 1)) : (acc.push(x), acc)), []);
}
def0('flatten', v => { if (!Array.isArray(v)) throw new JqError(`Cannot iterate over ${errDesc(v)}`); return flatten(v, 1e9); });
defN('flatten', 1, (v, d) => {
  if (typeof d !== 'number' || d < 0) throw new JqError('flatten depth must not be negative');
  if (!Array.isArray(v)) throw new JqError(`Cannot iterate over ${errDesc(v)}`);
  return flatten(v, d);
});
def0('to_entries', v => {
  if (!isObj(v)) throw new JqError(`${errDesc(v)} has no keys`);
  return Object.keys(v).map(k => ({ key: k, value: v[k] }));
});
def0('from_entries', v => {
  if (!Array.isArray(v)) throw new JqError(`Cannot iterate over ${errDesc(v)}`);
  const o: Record<string, JqValue> = {};
  for (const e of v) {
    let k: JqValue = null;
    let val: JqValue = null;
    if (isObj(e)) {
      for (const kn of ['key', 'k', 'name', 'Name', 'Key', 'K']) if (e[kn] !== undefined && e[kn] !== null && e[kn] !== false) { k = e[kn]; break; }
      if (k === null) for (const kn of ['key', 'k', 'name', 'Name', 'Key', 'K']) if (e[kn] !== undefined) { k = e[kn]; break; }
      for (const vn of ['value', 'v', 'Value', 'V']) if (e[vn] !== undefined) { val = e[vn]; break; }
    } else throw new JqError(`Cannot index ${typeName(e)} with "key"`);
    const ks = typeof k === 'string' ? k : k === null ? 'null' : typeof k === 'number' || typeof k === 'boolean' ? String(k) : (() => { throw new JqError(`Cannot use ${errDesc(k)} as object key`); })();
    Object.defineProperty(o, ks, { value: val, enumerable: true, writable: true, configurable: true });
  }
  return o;
});
defN('indices', 1, (v, x) => indicesOf(v, x));
defN('bsearch', 1, (v, x) => {
  let lo = 0, hi = v.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = compare(v[mid], x);
    if (c === 0) return mid;
    if (c < 0) lo = mid + 1; else hi = mid - 1;
  }
  return -1 - lo;
});

def0('tostring', v => (typeof v === 'string' ? v : compact(v)));
def0('tojson', v => compact(v));
def0('fromjson', v => {
  if (typeof v !== 'string') throw new JqError(`${errDesc(v)} cannot be parsed as JSON`);
  const r = parseJsonStream(v);
  if (r.error || r.values.length !== 1) throw new JqError(`${r.error ?? 'Expected JSON value'} (while parsing '${v}')`);
  return r.values[0];
});
def0('tonumber', v => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t !== '' && /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$|^-?nan$/i.test(t) || /^-?Infinity$/.test(t)) return Number(t);
    throw new JqError(`Cannot be parsed as a number`);
  }
  throw new JqError(`${errDesc(v)} cannot be parsed as a number`);
});
def0('ascii_downcase', v => {
  if (typeof v !== 'string') throw new JqError('ascii_downcase input must be a string');
  return v.replace(/[A-Z]/g, c => c.toLowerCase());
});
def0('ascii_upcase', v => {
  if (typeof v !== 'string') throw new JqError('ascii_upcase input must be a string');
  return v.replace(/[a-z]/g, c => c.toUpperCase());
});
def0('explode', v => {
  if (typeof v !== 'string') throw new JqError(`${errDesc(v)} cannot be exploded`);
  return Array.from(v, c => c.codePointAt(0)!);
});
def0('implode', v => {
  if (!Array.isArray(v)) throw new JqError(`${errDesc(v)} cannot be imploded`);
  return v.map(c => String.fromCodePoint(c)).join('');
});
defN('ltrimstr', 1, (v, s) => (typeof v === 'string' && typeof s === 'string' && v.startsWith(s) ? v.slice(s.length) : v));
defN('rtrimstr', 1, (v, s) => (typeof v === 'string' && typeof s === 'string' && s !== '' && v.endsWith(s) ? v.slice(0, -s.length) : v));
defN('startswith', 1, (v, s) => {
  if (typeof v !== 'string' || typeof s !== 'string') throw new JqError('startswith() requires string inputs');
  return v.startsWith(s);
});
defN('endswith', 1, (v, s) => {
  if (typeof v !== 'string' || typeof s !== 'string') throw new JqError('endswith() requires string inputs');
  return v.endsWith(s);
});
for (const [nm, f] of [['trim', (s: string) => s.trim()], ['ltrim', (s: string) => s.trimStart()], ['rtrim', (s: string) => s.trimEnd()]] as const) {
  def0(nm, v => { if (typeof v !== 'string') throw new JqError(`${errDesc(v)} cannot be trimmed`); return f(v); });
}
defN('split', 1, (v, s) => {
  if (typeof v !== 'string' || typeof s !== 'string') throw new JqError('split input and separator must be strings');
  return splitStr(v, s);
});
defN('join', 1, (v, sep) => {
  if (!Array.isArray(v)) throw new JqError(`Cannot iterate over ${errDesc(v)}`);
  if (v.length === 0) return '';
  if (typeof sep !== 'string') throw new JqError(`${errDesc(sep)} and ${errDesc(v[0])} cannot be added`);
  return v.map(x => {
    if (x === null) return '';
    if (typeof x === 'string') return x;
    if (typeof x === 'number' || typeof x === 'boolean') return compact(x);
    throw new JqError(`${errDesc(sep)} and ${errDesc(x)} cannot be added`);
  }).join(sep);
});

// regex
const POSIX: Record<string, string> = {
  alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z', space: '\\s', punct: '!-\\/:-@\\[-`{-~',
  xdigit: '0-9a-fA-F', word: '\\w', blank: ' \\t', cntrl: '\\x00-\\x1f\\x7f', print: '\\x20-\\x7e', graph: '\\x21-\\x7e',
};
function groupNames(src: string): (string | null)[] {
  const names: (string | null)[] = [];
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '(') {
      if (src[i + 1] !== '?') names.push(null);
      else {
        const m = /^\(\?<([A-Za-z_][A-Za-z0-9_]*)>/.exec(src.slice(i));
        if (m) names.push(m[1]);
      }
    }
  }
  return names;
}
function buildRegex(re: JqValue, flags: JqValue, forceGlobal = false): { rx: RegExp; names: (string | null)[]; global: boolean } {
  if (typeof re !== 'string') throw new JqError(`${errDesc(re)} cannot be matched, as it is not a string`);
  if (flags !== null && typeof flags !== 'string') throw new JqError(`${errDesc(flags)} is not a string`);
  let src = re.replace(/\[:(\w+):\]/g, (m, n) => POSIX[n] ?? m).replace(/\\h/g, '[0-9a-fA-F]');
  let js = 'd';
  let global = forceGlobal;
  let extended = false;
  let skipEmpty = false;
  for (const f of flags ?? '') {
    if (f === 'g') global = true;
    else if (f === 'i') js += 'i';
    else if (f === 'x') extended = true;
    else if (f === 's' || f === 'p') js += 's';
    else if (f === 'n') skipEmpty = true;
    else if (f === 'l') { /* longest match: no JS equivalent */ }
    else throw new JqError(`${flags} is not a valid modifier string`);
  }
  if (extended) src = src.replace(/\\#/g, '\u0000').replace(/#.*$/gm, '').replace(/\s+/g, '').replace(/\u0000/g, '\\#');
  let rx: RegExp;
  try { rx = new RegExp(src, js + 'g'); } catch (e: any) { throw new JqError(`${re} (at offset 0) is not a valid regex: ${e.message}`); }
  const names = groupNames(src);
  (rx as any).skipEmpty = skipEmpty;
  return { rx, names, global };
}
function matchObjs(s: string, re: JqValue, flags: JqValue): any[] {
  if (typeof s !== 'string') throw new JqError(`${errDesc(s)} cannot be matched, as it is not a string`);
  if (Array.isArray(re)) { flags = re[1] ?? null; re = re[0]; }
  const { rx, names, global } = buildRegex(re, flags);
  const out: any[] = [];
  for (const m of s.matchAll(rx)) {
    if ((rx as any).skipEmpty && m[0] === '') continue;
    const idx = (m as any).indices;
    out.push({
      offset: m.index, length: m[0].length, string: m[0],
      captures: m.slice(1).map((c, i) => c === undefined
        ? { offset: -1, length: 0, string: null, name: names[i] ?? null }
        : { offset: idx[i + 1][0], length: c.length, string: c, name: names[i] ?? null }),
    });
    if (!global) break;
  }
  return out;
}
function* matchGen(a: Node[], v: JqValue, p: Path, env: Env | null, mode: 'match' | 'test'): Generator<Out> {
  for (const [re, fl] of cartesian(a.length > 1 ? a : [a[0], { t: 'lit', v: null }], v, env)) {
    const ms = matchObjs(v, re, fl);
    if (mode === 'test') yield [ms.length > 0, pv(p)];
    else for (const m of ms) yield [m, pv(p)];
  }
}
defG('match', 2, (a, v, p, env) => matchGen(a, v, p, env, 'match'));
defG('test', 2, (a, v, p, env) => matchGen(a, v, p, env, 'test'));
defG('split', 2, function* (a, v, p, env) {
  for (const [re, fl] of cartesian(a, v, env)) {
    const ms = matchObjs(v, re, fl === null ? 'g' : fl + 'g');
    const parts: string[] = [];
    let last = 0;
    for (const m of ms) { parts.push(v.slice(last, m.offset)); last = m.offset + m.length; }
    parts.push(v.slice(last));
    yield [parts, pv(p)];
  }
});
defG('sub', 3, function* (a, v, p, env) {
  for (const [re, fl] of cartesian([a[0], a[2]], v, env)) {
    const ms = matchObjs(v, re, fl);
    function* rec(i: number, prefix: string, last: number): Generator<string> {
      if (i === ms.length) { yield prefix + v.slice(last); return; }
      const m = ms[i];
      const cap: Record<string, JqValue> = {};
      for (const c of m.captures) if (c.name !== null) cap[c.name] = c.string;
      for (const [r] of ev(a[1], cap, null, env)) {
        if (typeof r !== 'string') throw new JqError(`${errDesc(cap)} and ${errDesc(r)} cannot be added`);
        yield* rec(i + 1, prefix + v.slice(last, m.offset) + r, m.offset + m.length);
      }
    }
    for (const s of rec(0, '', 0)) yield [s, pv(p)];
  }
});

// formats
function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function applyFormat(name: string, v: JqValue): string {
  const str = (x: JqValue) => (typeof x === 'string' ? x : compact(x));
  switch (name) {
    case '@text': return str(v);
    case '@json': return compact(v);
    case '@html': return str(v).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]!));
    case '@uri': return Array.from(new TextEncoder().encode(str(v))).map(b => (/[A-Za-z0-9\-_.~]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : '%' + b.toString(16).toUpperCase().padStart(2, '0'))).join('');
    case '@csv':
    case '@tsv': {
      if (!Array.isArray(v)) throw new JqError(`${errDesc(v)} cannot be ${name.slice(1)}-formatted, only an array can be`);
      return v.map(x => {
        if (x === null) return '';
        if (typeof x === 'boolean') return String(x);
        if (typeof x === 'number') return numStr(x);
        if (typeof x === 'string') {
          return name === '@csv' ? '"' + x.replace(/"/g, '""') + '"'
            : x.replace(/[\\\t\n\r]/g, c => ({ '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' }[c]!));
        }
        throw new JqError(`${errDesc(x)} is not valid in a csv row`);
      }).join(name === '@csv' ? ',' : '\t');
    }
    case '@sh': {
      const one = (x: JqValue) => {
        if (typeof x === 'string') return "'" + x.replace(/'/g, "'\\''") + "'";
        if (Array.isArray(x) || isObj(x)) throw new JqError(`${errDesc(x)} can not be escaped for shell`);
        return compact(x);
      };
      return Array.isArray(v) ? v.map(one).join(' ') : one(v);
    }
    case '@base64': return b64(str(v));
    case '@base64d': {
      try {
        const bin = atob(str(v).replace(/=+$/, ''));
        return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
      } catch { throw new JqError(`${errDesc(v)} is not valid base64 data`); }
    }
  }
  throw new CompileError(`${name.slice(1)} is not a valid format`);
}

// dates
function gmtime(secs: number): JqValue[] {
  const d = new Date(Math.floor(secs) * 1000);
  const yday = Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5);
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds() + (secs - Math.floor(secs)), d.getUTCDay(), yday];
}
function mktime(bt: JqValue): number {
  if (!Array.isArray(bt) || bt.length < 6 || bt.some((x: any) => typeof x !== 'number')) throw new JqError('mktime requires array of 6 numbers');
  return Math.floor(Date.UTC(bt[0], bt[1], bt[2], bt[3], bt[4], Math.floor(bt[5])) / 1000);
}
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function strftime(v: JqValue, fmt: JqValue): string {
  if (typeof fmt !== 'string') throw new JqError('strftime/1 requires a string format');
  const bt = typeof v === 'number' ? gmtime(v) : v;
  if (!Array.isArray(bt)) throw new JqError('strftime/1 requires parsed datetime inputs');
  const [Y, M, D, h, mi, sRaw, wd, yd] = bt;
  const s = Math.floor(sRaw);
  const z = (n: number, w = 2) => String(n).padStart(w, '0');
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return fmt.replace(/%([A-Za-z%])/g, (_m, c) => {
    switch (c) {
      case 'Y': return String(Y);
      case 'y': return z(Y % 100);
      case 'm': return z(M + 1);
      case 'd': return z(D);
      case 'e': return String(D).padStart(2, ' ');
      case 'H': return z(h);
      case 'I': return z(h12);
      case 'M': return z(mi);
      case 'S': return z(s);
      case 'Z': return 'UTC';
      case 'z': return '+0000';
      case 'a': return DAYS[wd].slice(0, 3);
      case 'A': return DAYS[wd];
      case 'b': case 'h': return MONTHS[M].slice(0, 3);
      case 'B': return MONTHS[M];
      case 'j': return z(yd + 1, 3);
      case 'p': return h < 12 ? 'AM' : 'PM';
      case 's': return String(mktime(bt));
      case 'T': return `${z(h)}:${z(mi)}:${z(s)}`;
      case 'D': return `${z(M + 1)}/${z(D)}/${z(Y % 100)}`;
      case 'F': return `${Y}-${z(M + 1)}-${z(D)}`;
      case 'u': return String(wd === 0 ? 7 : wd);
      case 'w': return String(wd);
      case '%': return '%';
    }
    return '%' + c;
  });
}
def0('gmtime', v => { if (typeof v !== 'number') throw new JqError('gmtime() requires a number'); return gmtime(v); });
def0('localtime', v => { if (typeof v !== 'number') throw new JqError('localtime() requires a number'); return gmtime(v); });
def0('mktime', mktime);
defN('strftime', 1, strftime);
defN('strflocaltime', 1, strftime);
def0('fromdateiso8601', v => {
  const m = typeof v === 'string' ? /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)Z$/.exec(v) : null;
  if (!m) throw new JqError(`date "${v}" does not match format "%Y-%m-%dT%H:%M:%SZ"`);
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000);
});

// ───────────────────────── prelude (jq-defined builtins) ─────────────────────────

const PRELUDE = `
def map(f): [.[] | f];
def values: select(. != null);
def nulls: select(. == null);
def booleans: select(type == "boolean");
def numbers: select(type == "number");
def strings: select(type == "string");
def arrays: select(type == "array");
def objects: select(type == "object");
def iterables: select(type == "array" or type == "object");
def scalars: select(type != "array" and type != "object");
def finites: select(isinfinite or isnan | not);
def normals: select(isnormal);
def map_values(f): .[] |= f;
def recurse_down: recurse;
def with_entries(f): to_entries | map(f) | from_entries;
def paths: path(..) | select(length > 0);
def paths(node_filter): . as $dot | paths | select(. as $p | $dot | getpath($p) | node_filter);
def leaf_paths: paths(scalars);
def del(f): delpaths([path(f)]);
def add(f): reduce f as $x (null; . + $x);
def any: any(.[]; .);
def all: all(.[]; .);
def any(f): any(.[]; f);
def all(f): all(.[]; f);
def in(xs): . as $x | xs | has($x);
def inside(xs): . as $x | xs | contains($x);
def combinations: if length == 0 then [] else .[0][] as $x | (.[1:] | combinations) as $w | [$x] + $w end;
def combinations(n): . as $dot | [range(n)] | map($dot) | combinations;
def walk(f): def w: if type == "object" then map_values(w) elif type == "array" then map(w) else . end | f; w;
def first: .[0];
def last: .[-1];
def nth($n): .[$n];
def index($i): indices($i) | .[0];
def rindex($i): indices($i) | .[-1:][0];
def transpose: if . == [] then [] else . as $in | (map(length) | max) as $max | [range(0; $max) as $j | [range(0; $in | length) as $i | $in[$i][$j]]] end;
def tostream: path(def r: (.[]? | r), .; r) as $p | getpath($p) | reduce path(.[]?) as $q ([$p, .]; [$p + $q]);
def fromstream(f): {x: null, e: false} as $init | foreach f as $i ($init; if .e then $init else . end | if $i | length == 2 then setpath(["e"]; $i[0] | length == 0) | setpath(["x"] + $i[0]; $i[1]) else setpath(["e"]; $i[0] | length == 1) end; if .e then .x else empty end);
def truncate_stream(stream): . as $n | null | stream | . as $input | if (.[0] | length) > $n then setpath([0]; .[0][$n:]) else empty end;
def match(re): match(re; null);
def test(re): test(re; null);
def capture(re; mods): match(re; mods) | [.captures | .[] | select(.name != null) | {key: .name, value: .string}] | from_entries;
def capture(re): capture(re; null);
def scan(re; $flags): match(re; "g" + $flags) | if (.captures | length) > 0 then [.captures | .[] | .string] else .string end;
def scan(re): scan(re; null);
def splits($re; flags): split($re; flags) | .[];
def splits($re): splits($re; null);
def sub(re; str): sub(re; str; "");
def gsub(re; str): sub(re; str; "g");
def gsub(re; str; flags): sub(re; str; flags + "g");
def ascii: [.] | implode;
def pick(pathexps): . as $top | reduce path(pathexps) as $p (null; setpath($p; $top | getpath($p)));
def IN(s): any(s == .; .);
def IN(src; s): any(src == s; .);
def INDEX(stream; idx_expr): reduce stream as $row ({}; .[$row | idx_expr | tostring] |= $row);
def INDEX(idx_expr): INDEX(.[]; idx_expr);
def env: $ENV;
def halt_error: halt_error(5);
def todate: strftime("%Y-%m-%dT%H:%M:%SZ");
def fromdate: fromdateiso8601;
def todateiso8601: todate;
def date: todate;
def dateadd(u; n): . + n;
def datesub(u; n): . - n;
def abs: if type == "number" and . < 0 then -. else . end;
def toarray: if type == "array" then . else [.] end;
def trimstr($s): ltrimstr($s) | rtrimstr($s);
def have_literal_numbers: true;
def have_decnum: false;
def get_search_list: [];
`;

let preludeEnv: Env | null | undefined;
function getPrelude(): Env | null {
  if (preludeEnv !== undefined) return preludeEnv;
  // The prelude is a chain of defs ending in `.`; walk it to build the env.
  let env: Env | null = null;
  let node: Node = new Parser(PRELUDE + ' .').parseProgram();
  while (node.t === 'def') {
    const entry: Env = { parent: env, kind: 'fn', name: node.name, arity: node.params.length, node: node.body, params: node.params };
    entry.env = entry;
    env = entry;
    node = node.rest;
  }
  preludeEnv = env;
  return env;
}

// ───────────────────────── public helpers ─────────────────────────

function runFilter(ast: Node, input: JqValue, env: Env | null): JqValue[] {
  const out: JqValue[] = [];
  for (const [r] of ev(ast, input, null, env)) out.push(r);
  return out;
}

export function evaluateJq(data: any, expr: string, raw = false): string {
  const ast = new Parser(expr).parseProgram();
  const saved = RT;
  RT = { env: {}, inputs: [], pos: 0, stderr: [], filename: null };
  try {
    return runFilter(ast, data, getPrelude())
      .map(r => (raw && typeof r === 'string' ? r : toJson(r, '  ', false, false)))
      .map(s => s + '\n')
      .join('');
  } finally {
    RT = saved;
  }
}

// ───────────────────────── command ─────────────────────────

const USAGE = 'Usage:\tjq [OPTIONS] FILTER [FILES...]\n\tjq [OPTIONS] --args FILTER [STRINGS...]\n';

export const jqCmd: Command = {
  name: 'jq',
  description: 'JSON processor',
  async exec(ctx) {
    let raw = false, join = false, compactOut = false, slurp = false, nullInput = false, rawInput = false;
    let exitStatus = false, sortKeys = false, ascii = false, tab = false, indentN = 2;
    let filterExpr: string | null = null;
    let fromFile: string | null = null;
    const files: string[] = [];
    const named: Record<string, JqValue> = {};
    const positional: JqValue[] = [];
    let restMode: 'files' | 'args' | 'jsonargs' = 'files';
    const fail = (msg: string, code = 2): number => { ctx.stderr = `jq: ${msg}\n${msg.startsWith('error') ? '' : USAGE}`; return code; };

    const readText = async (path: string): Promise<string> => {
      const data = await ctx.fs.readFile(ctx.fs.resolvePath(path, ctx.cwd));
      return typeof data === 'string' ? data : new TextDecoder().decode(data);
    };
    const bad = (path: string, e: any) => `error: Could not open ${path}: ${e?.code === 'ENOENT' || /no such|not found|ENOENT/i.test(e?.message ?? '') ? 'No such file or directory' : (e?.message ?? e)}`;

    const a = ctx.args;
    let noMoreOpts = false;
    for (let i = 0; i < a.length; i++) {
      const arg = a[i];
      const needs = (n: number) => { if (i + n >= a.length) throw new Error(`${arg} takes ${n} parameter${n > 1 ? 's' : ''} (e.g. ${arg} ${n > 1 ? 'varname value' : 'value'})`); };
      try {
        if (noMoreOpts || !arg.startsWith('-') || arg === '-') {
          if (filterExpr === null && fromFile === null) filterExpr = arg;
          else if (restMode === 'args') positional.push(arg);
          else if (restMode === 'jsonargs') {
            try { positional.push(JSON.parse(arg)); } catch { return fail(`Invalid JSON text passed to --jsonargs`); }
          } else files.push(arg);
          continue;
        }
        if (arg === '--') { noMoreOpts = true; continue; }
        if (arg.startsWith('--')) {
          switch (arg) {
            case '--raw-output': raw = true; break;
            case '--join-output': raw = true; join = true; break;
            case '--compact-output': compactOut = true; break;
            case '--slurp': slurp = true; break;
            case '--null-input': nullInput = true; break;
            case '--raw-input': rawInput = true; break;
            case '--exit-status': exitStatus = true; break;
            case '--sort-keys': sortKeys = true; break;
            case '--ascii-output': ascii = true; break;
            case '--tab': tab = true; break;
            case '--color-output': case '--monochrome-output': case '--unbuffered': case '--seq': case '--stream-errors': break;
            case '--indent': needs(1); indentN = Math.max(0, Math.min(7, parseInt(a[++i], 10) || 0)); break;
            case '--from-file': needs(1); fromFile = a[++i]; break;
            case '--arg': needs(2); named[a[i + 1]] = a[i + 2]; i += 2; break;
            case '--argjson': {
              needs(2);
              const r = parseJsonStream(a[i + 2]);
              if (r.error || r.values.length !== 1) return fail(`Invalid JSON text passed to --argjson`);
              named[a[i + 1]] = r.values[0];
              i += 2;
              break;
            }
            case '--slurpfile': case '--rawfile': {
              needs(2);
              const name = a[i + 1], path = a[i + 2];
              i += 2;
              let text: string;
              try { text = await readText(path); } catch (e) { return fail(`${bad(path, e)}`); }
              if (arg === '--rawfile') named[name] = text;
              else {
                const r = parseJsonStream(text);
                if (r.error) return fail(`Bad JSON in --slurpfile ${name} ${path}: ${r.error}`);
                named[name] = r.values;
              }
              break;
            }
            case '--args': restMode = 'args'; break;
            case '--jsonargs': restMode = 'jsonargs'; break;
            case '--help': ctx.stdout = USAGE; return 0;
            default: return fail(`Unknown option: ${arg}`);
          }
          continue;
        }
        // combined short flags, e.g. -rc, -nr, -f file
        for (let j = 1; j < arg.length; j++) {
          switch (arg[j]) {
            case 'r': raw = true; break;
            case 'j': raw = true; join = true; break;
            case 'c': compactOut = true; break;
            case 's': slurp = true; break;
            case 'n': nullInput = true; break;
            case 'R': rawInput = true; break;
            case 'e': exitStatus = true; break;
            case 'S': sortKeys = true; break;
            case 'a': ascii = true; break;
            case 'C': case 'M': break;
            case 'f': needs(1); fromFile = a[++i]; break;
            case 'h': ctx.stdout = USAGE; return 0;
            default: return fail(`Unknown option: ${arg}`);
          }
        }
      } catch (e: any) { return fail(e.message); }
    }

    if (fromFile !== null) {
      // with -f, the first positional (if any) was taken as the filter: it is really an input file
      if (filterExpr !== null) { files.unshift(filterExpr); filterExpr = null; }
      try { filterExpr = await readText(fromFile); } catch (e) { return fail(bad(fromFile, e)); }
    }
    if (filterExpr === null) return fail('no filter given', 2);

    // compile
    let ast: Node;
    let env: Env | null;
    try {
      ast = new Parser(filterExpr).parseProgram();
      env = getPrelude();
      for (const [k, val] of Object.entries(named)) env = bindVar(env, k, val);
      env = bindVar(env, 'ARGS', { positional, named });
      env = bindVar(env, '__prog_args', []);
    } catch (e: any) {
      if (e instanceof CompileError) {
        ctx.stderr = `jq: error: ${e.message} at <top-level>, line 1:\n${filterExpr}\njq: 1 compile error\n`;
        return 3;
      }
      throw e;
    }

    // read input
    let inputText = '';
    let exit = 0;
    let errs = '';
    if (files.length > 0) {
      const parts: string[] = [];
      for (const f of files) {
        try { parts.push(await readText(f)); } catch (e) { errs += `jq: ${bad(f, e)}\n`; exit = 2; }
      }
      inputText = parts.join('');
      RT.filename = files[files.length - 1];
    } else inputText = ctx.stdin ?? '';

    let inputs: JqValue[];
    let parseError: string | undefined;
    if (rawInput) {
      if (slurp) inputs = [inputText];
      else {
        const lines = inputText.split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        inputs = lines;
      }
    } else {
      const r = parseJsonStream(inputText);
      inputs = r.values;
      parseError = r.error;
      if (slurp) inputs = [inputs];
    }

    RT = { env: { ...ctx.env }, inputs: [], pos: 0, stderr: [], filename: files.length ? files[files.length - 1] : null };
    const queue = nullInput ? inputs : inputs;
    RT.inputs = nullInput ? queue : queue.slice(1);
    const todo: JqValue[] = nullInput ? [null] : queue.slice(0, 1);

    const indent = compactOut ? null : tab ? '\t' : ' '.repeat(indentN);
    let out = '';
    let last: { has: boolean; v: JqValue } = { has: false, v: null };
    try {
      let first = true;
      for (;;) {
        let input: JqValue;
        if (first) { if (!todo.length) break; input = todo[0]; first = false; } else {
          if (nullInput || RT.pos >= RT.inputs.length) break;
          input = RT.inputs[RT.pos++];
        }
        try {
          for (const [r] of ev(ast, input, null, env)) {
            last = { has: true, v: r };
            out += raw && typeof r === 'string' ? r : toJson(r, indent, sortKeys, ascii);
            if (!join) out += '\n';
          }
        } catch (e: any) {
          if (e instanceof JqError) {
            errs += `jq: error (at <stdin>:0): ${e.message}\n`;
            exit = 5;
          } else if (e instanceof BreakSignal) {
            errs += 'jq: error (at <stdin>:0): break\n';
            exit = 5;
          } else throw e;
        }
        if (nullInput) break;
      }
    } catch (e: any) {
      if (e instanceof CompileError) {
        ctx.stdout = '';
        ctx.stderr = `jq: error: ${e.message} at <top-level>, line 1:\n${filterExpr}\njq: 1 compile error\n`;
        return 3;
      }
      if (e instanceof HaltSignal) {
        ctx.stdout = out;
        ctx.stderr = RT.stderr.join('') + errs + e.msg;
        return e.code;
      }
      if (e instanceof RangeError) {
        ctx.stdout = out;
        ctx.stderr = errs + 'jq: error: stack overflow (filter recursion too deep)\n';
        return 5;
      }
      throw e;
    }

    if (parseError) { errs += `jq: error (at <stdin>:0): ${parseError}\n`; exit = 2; }
    ctx.stdout = out;
    ctx.stderr = RT.stderr.join('') + errs;
    if (exit) return exit;
    if (exitStatus) {
      if (!last.has) return 4;
      return truthy(last.v) ? 0 : 1;
    }
    return 0;
  },
};
