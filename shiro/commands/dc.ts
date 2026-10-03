/**
 * dc — reverse-polish desk calculator (GNU dc semantics).
 *
 * Arbitrary precision decimals (value = v / 10^s) with dc's scale rules, input and output bases,
 * registers with their own stacks, arrays, strings and macros (with tail-call elimination, as GNU dc
 * does), conditionals, q / Q, `?`, and GNU's 70-column wrapping of long numbers.
 */
import type { Command } from './index';

interface Num { v: bigint; s: number }
type Val = Num | string;

const TEN = 10n;
const pow10 = (n: number) => TEN ** BigInt(n);
const isNum = (x: Val): x is Num => typeof x !== 'string';

class DcError extends Error {}
class Quit { constructor(public levels: number) {} }

function rescale(n: Num, s: number): Num {          // truncate or extend to scale s
  if (s === n.s) return n;
  return s > n.s ? { v: n.v * pow10(s - n.s), s } : { v: n.v / pow10(n.s - s), s };   // BigInt division truncates toward zero
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  if (x === 0n) x = 1n;
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y === x || y === x + 1n && y * y > n) break;
    if (y === x - 1n && x * x <= n) break;
    x = y;
  }
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}

const DIGITS = '0123456789ABCDEF';

export const dcCmd: Command = {
  name: 'dc',
  description: 'Reverse-polish desk calculator',
  async exec(ctx) {
    const a = ctx.args;
    const programs: string[] = [];
    let haveProgram = false;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x === '-e' || x === '--expression') { programs.push(a[++i] ?? ''); haveProgram = true; }
      else if (x.startsWith('--expression=')) { programs.push(x.slice(13)); haveProgram = true; }
      else if (x === '-f' || x === '--file') {
        haveProgram = true;
        try { programs.push(await ctx.fs.readFile(ctx.fs.resolvePath(a[++i], ctx.cwd), 'utf8') as string); }
        catch { ctx.stderr += `dc: File ${a[i]} is unavailable.\n`; return 1; }
      } else if (x === '-V' || x === '--version') { ctx.stdout += 'dc (GNU bc 1.07.1) 1.4.1\n'; return 0; }
      else if (x === '-h' || x === '--help') { ctx.stdout += 'Usage: dc [OPTION] [file ...]\n'; return 0; }
      else if (x === '-') { programs.push(ctx.stdin); haveProgram = true; }
      else if (x.startsWith('-') && x.length > 1) { ctx.stderr += `dc: invalid option -- '${x.replace(/^-+/, '')}'\n`; return 1; }
      else {
        haveProgram = true;
        try { programs.push(await ctx.fs.readFile(ctx.fs.resolvePath(x, ctx.cwd), 'utf8') as string); }
        catch { ctx.stderr += `dc: File ${x} is unavailable.\n`; return 1; }
      }
    }
    if (!haveProgram) programs.push(ctx.stdin);

    // `?` reads a line of the input that follows the program
    let stdinRest = haveProgram ? ctx.stdin : '';

    let stack: Val[] = [];
    let scale = 0, ibase = 10, obase = 10;
    const regs = new Map<number, Val[]>();
    const arrays = new Map<number, Map<number, Val>>();
    let out = '';
    const err = (m: string) => { ctx.stderr += `dc: ${m}\n`; };

    const fmtNum = (n: Num): string => {
      let neg = n.v < 0n;
      let abs = neg ? -n.v : n.v;
      const wrap = (s: string) => { let r = ''; while (s.length > 69) { r += s.slice(0, 69) + '\\\n'; s = s.slice(69); } return r + s; };
      if (obase === 10) {
        const intPart = abs / pow10(n.s);
        const frac = n.s > 0 ? (abs % pow10(n.s)).toString().padStart(n.s, '0') : '';
        const body = (intPart === 0n && n.s > 0 ? '' : intPart.toString()) + (n.s > 0 ? '.' + frac : '');
        return wrap((neg ? '-' : '') + (body === '' ? '0' : body));
      }
      const intPart = abs / pow10(n.s);
      let fracV = abs % pow10(n.s);
      const base = BigInt(obase);
      const digit = (d: bigint) => (obase <= 16 ? DIGITS[Number(d)] : ' ' + d.toString().padStart(String(obase - 1).length, '0'));
      let ip = '';
      if (intPart === 0n) ip = n.s > 0 ? '' : digit(0n);
      else { let t = intPart; while (t > 0n) { ip = digit(t % base) + ip; t /= base; } }
      let fp = '';
      if (n.s > 0) {
        const count = Math.ceil(n.s * Math.log(10) / Math.log(obase));
        const unit = pow10(n.s);
        for (let k = 0; k < count; k++) { fracV *= base; fp += digit(fracV / unit); fracV %= unit; }
        fp = '.' + fp;
      }
      const body = ip + fp;
      return wrap((neg ? '-' : '') + (body === '' ? '0' : body));
    };

    const parseNumber = (text: string): Num => {
      let neg = false;
      let t = text;
      if (t.startsWith('_')) { neg = true; t = t.slice(1); }
      const [ip, fp = ''] = t.split('.');
      const digitVal = (c: string) => { const d = parseInt(c, 36); return d >= ibase ? ibase - 1 : d; };   // dc clamps digits above ibase
      let v = 0n;
      const base = BigInt(ibase);
      for (const c of ip) v = v * base + BigInt(digitVal(c));
      if (ibase === 10) {
        let f = 0n;
        for (const c of fp) f = f * 10n + BigInt(digitVal(c));
        const s = fp.length;
        const num = { v: v * pow10(s) + f, s };
        return neg ? { v: -num.v, s } : num;
      }
      // fractional digits in another base: exact rational truncated to as many decimal places as digits given
      let f = 0n;
      for (const c of fp) f = f * base + BigInt(digitVal(c));
      const s = fp.length;
      const frac = s > 0 ? (f * pow10(s)) / (base ** BigInt(s)) : 0n;
      const num = { v: v * pow10(s) + frac, s };
      return neg ? { v: -num.v, s } : num;
    };

    const pop = (): Val => { if (stack.length === 0) throw new DcError('stack empty'); return stack.pop()!; };
    const popNum = (): Num => { const x = pop(); if (!isNum(x)) throw new DcError('non-numeric value'); return x; };
    const toInt = (n: Num): number => Number(n.v / pow10(n.s));

    const divide = (x: Num, y: Num): Num => {
      if (y.v === 0n) throw new DcError('divide by zero');
      const q = (x.v * pow10(y.s + scale)) / (y.v * pow10(x.s));
      return { v: q, s: scale };
    };
    const mul = (x: Num, y: Num): Num => {
      const full = { v: x.v * y.v, s: x.s + y.s };
      return rescale(full, Math.min(full.s, Math.max(scale, x.s, y.s)));
    };
    const sub = (x: Num, y: Num): Num => { const s = Math.max(x.s, y.s); return { v: rescale(x, s).v - rescale(y, s).v, s }; };
    const add = (x: Num, y: Num): Num => { const s = Math.max(x.s, y.s); return { v: rescale(x, s).v + rescale(y, s).v, s }; };
    const mod = (x: Num, y: Num): Num => {
      if (y.v === 0n) throw new DcError('remainder by zero');
      const q = divide(x, y);
      const rs = Math.max(scale + y.s, x.s);
      const prod = { v: q.v * y.v, s: q.s + y.s };
      return sub(rescale(x, rs), rescale(prod, rs));
    };
    const power = (x: Num, y: Num): Num => {
      const e = toInt(y);
      if (e >= 0) {
        const full = { v: x.v ** BigInt(e), s: x.s * e };
        return rescale(full, Math.min(full.s, Math.max(scale, x.s)));
      }
      const pos = { v: x.v ** BigInt(-e), s: x.s * -e };
      if (pos.v === 0n) throw new DcError('divide by zero');
      return divide({ v: 1n, s: 0 }, pos);
    };

    const cmpNum = (x: Num, y: Num) => { const s = Math.max(x.s, y.s); const p = rescale(x, s).v, q = rescale(y, s).v; return p < q ? -1 : p > q ? 1 : 0; };

    const regStack = (r: number) => { let s = regs.get(r); if (!s) regs.set(r, s = []); return s; };
    const nameOf = (c: number) => `'${String.fromCharCode(c)}' (0${c.toString(8)})`;

    // ── the interpreter: frames of code, with tail-call elimination for macros
    interface Frame { code: string; pos: number }
    let quitAll = false;

    const run = (program: string): void => {
      const frames: Frame[] = [{ code: program, pos: 0 }];
      const call = (code: string) => {
        const top = frames[frames.length - 1];
        // a macro called as the last thing in its frame replaces that frame (GNU dc does the same)
        if (top.pos >= top.code.length && frames.length > 1) frames.pop();
        frames.push({ code, pos: 0 });
      };
      const quit = (levels: number) => {
        for (let k = 0; k < levels && frames.length; k++) frames.pop();
        if (frames.length === 0) quitAll = true;
      };
      while (frames.length && !quitAll) {
        const f = frames[frames.length - 1];
        if (f.pos >= f.code.length) {
          frames.pop();
          if (frames.length === 0) break;
          continue;
        }
        const c = f.code[f.pos++];
        try {
          switch (c) {
            case ' ': case '\t': case '\n': case '\r': break;
            case '#': while (f.pos < f.code.length && f.code[f.pos] !== '\n') f.pos++; break;
            case '_': case '.': case '0': case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9':
            case 'A': case 'B': case 'C': case 'D': case 'E': case 'F': {
              let j = f.pos - 1;
              if (c === '_') j++;
              let dot = c === '.';
              while (j < f.code.length) {
                const ch = f.code[j];
                if (ch === '.' && !dot) { dot = true; j++; continue; }
                if (/[0-9A-F]/.test(ch)) { j++; continue; }
                break;
              }
              stack.push(parseNumber(f.code.slice(f.pos - 1, j)));
              f.pos = j;
              break;
            }
            case '[': {
              let depth = 1, j = f.pos, s = '';
              while (j < f.code.length) {
                const ch = f.code[j];
                if (ch === '\\' && (f.code[j + 1] === '[' || f.code[j + 1] === ']' || f.code[j + 1] === '\\')) { s += f.code[j + 1]; j += 2; continue; }
                if (ch === '[') depth++;
                else if (ch === ']' && --depth === 0) break;
                s += ch; j++;
              }
              if (depth !== 0) { f.pos = f.code.length; throw new DcError('unexpected EOF'); }
              stack.push(s);
              f.pos = j + 1;
              break;
            }
            case '+': { const y = popNum(), x = popNum(); stack.push(add(x, y)); break; }
            case '-': { const y = popNum(), x = popNum(); stack.push(sub(x, y)); break; }
            case '*': { const y = popNum(), x = popNum(); stack.push(mul(x, y)); break; }
            case '/': { const y = popNum(), x = popNum(); stack.push(divide(x, y)); break; }
            case '%': { const y = popNum(), x = popNum(); stack.push(mod(x, y)); break; }
            case '~': { const y = popNum(), x = popNum(); stack.push(divide(x, y), mod(x, y)); break; }
            case '^': { const y = popNum(), x = popNum(); stack.push(power(x, y)); break; }
            case '|': {
              const m = popNum(), e = popNum(), b = popNum();
              if (m.v === 0n) throw new DcError('remainder by zero');
              let base = rescale(b, 0).v, exp = rescale(e, 0).v;
              const mv = rescale(m, 0).v;
              let r = 1n; base %= mv;
              while (exp > 0n) { if (exp & 1n) r = (r * base) % mv; base = (base * base) % mv; exp >>= 1n; }
              stack.push({ v: r, s: 0 });
              break;
            }
            case 'v': {
              const x = popNum();
              if (x.v < 0n) throw new DcError('square root of negative number');
              const rs = Math.max(scale, x.s);
              stack.push({ v: isqrt(x.v * pow10(2 * rs - x.s)), s: rs });
              break;
            }
            case 'p': { const x = stack[stack.length - 1]; if (x === undefined) throw new DcError('stack empty'); out += (isNum(x) ? fmtNum(x) : x) + '\n'; break; }
            case 'n': { const x = pop(); out += isNum(x) ? fmtNum(x) : x; break; }
            case 'P': {
              const x = pop();
              if (isNum(x)) { let v = x.v < 0n ? -x.v : x.v; v /= pow10(x.s); const bytes: number[] = []; while (v > 0n) { bytes.unshift(Number(v & 255n)); v >>= 8n; } out += String.fromCharCode(...bytes); }
              else out += x;
              break;
            }
            case 'f': for (let k = stack.length - 1; k >= 0; k--) { const x = stack[k]; out += (isNum(x) ? fmtNum(x) : x) + '\n'; } break;
            case 'c': stack = []; break;
            case 'd': { const x = stack[stack.length - 1]; if (x === undefined) throw new DcError('stack empty'); stack.push(x); break; }
            case 'r': { const y = pop(), x = pop(); stack.push(y, x); break; }
            case 'R': pop(); break;
            case 'z': stack.push({ v: BigInt(stack.length), s: 0 }); break;
            case 'Z': { const x = pop(); stack.push({ v: BigInt(isNum(x) ? (x.v < 0n ? -x.v : x.v).toString().length : x.length), s: 0 }); break; }
            case 'X': { const x = pop(); stack.push({ v: BigInt(isNum(x) ? x.s : 0), s: 0 }); break; }
            case 'a': {
              const x = pop();
              stack.push(isNum(x) ? String.fromCharCode(Number(((x.v / pow10(x.s)) % 256n + 256n) % 256n)) : x.slice(0, 1));
              break;
            }
            case 'k': { const x = popNum(); const n = toInt(x); if (n < 0) throw new DcError('scale must be a nonnegative number'); scale = n; break; }
            case 'K': stack.push({ v: BigInt(scale), s: 0 }); break;
            case 'i': { const n = toInt(popNum()); if (n < 2 || n > 16) throw new DcError('input base must be a number between 2 and 16'); ibase = n; break; }
            case 'I': stack.push({ v: BigInt(ibase), s: 0 }); break;
            case 'o': { const n = toInt(popNum()); if (n < 2) throw new DcError('output base must be a number greater than 1'); obase = n; break; }
            case 'O': stack.push({ v: BigInt(obase), s: 0 }); break;
            case 's': { const r = f.code.charCodeAt(f.pos++); const s = regStack(r); const x = pop(); if (s.length) s[s.length - 1] = x; else s.push(x); break; }
            case 'l': { const r = f.code.charCodeAt(f.pos++); const s = regs.get(r); if (!s || s.length === 0) throw new DcError(`register ${nameOf(r)} is empty`); stack.push(s[s.length - 1]); break; }
            case 'S': { const r = f.code.charCodeAt(f.pos++); regStack(r).push(pop()); break; }
            case 'L': { const r = f.code.charCodeAt(f.pos++); const s = regs.get(r); if (!s || s.length === 0) throw new DcError(`stack register ${nameOf(r)} is empty`); stack.push(s.pop()!); break; }
            case ':': { const r = f.code.charCodeAt(f.pos++); const idx = toInt(popNum()); const x = pop(); if (idx < 0) throw new DcError('array index must be a nonnegative integer'); let m = arrays.get(r); if (!m) arrays.set(r, m = new Map()); m.set(idx, x); break; }
            case ';': { const r = f.code.charCodeAt(f.pos++); const idx = toInt(popNum()); if (idx < 0) throw new DcError('array index must be a nonnegative integer'); stack.push(arrays.get(r)?.get(idx) ?? { v: 0n, s: 0 }); break; }
            case 'x': { const x = pop(); if (typeof x === 'string') call(x); else stack.push(x); break; }
            case 'q': quit(2); break;
            case 'Q': { const n = toInt(popNum()); if (n < 1) throw new DcError('Q command requires a number >= 1'); quit(n); break; }
            case '?': {
              const nl = stdinRest.indexOf('\n');
              const line = nl < 0 ? stdinRest : stdinRest.slice(0, nl);
              stdinRest = nl < 0 ? '' : stdinRest.slice(nl + 1);
              call(line);
              break;
            }
            case '<': case '>': case '=': case '!': {
              let op = c;
              let negate = false;
              if (c === '!') {
                const n = f.code[f.pos];
                if (n === '<' || n === '>' || n === '=') { op = n; negate = true; f.pos++; }
                else { while (f.pos < f.code.length && f.code[f.pos] !== '\n') f.pos++; break; }    // !command: no shell here
              }
              const r = f.code.charCodeAt(f.pos++);
              const y = popNum(), x = popNum();
              const k = cmpNum(y, x);                           // y was the top of the stack
              let hit = op === '<' ? k < 0 : op === '>' ? k > 0 : k === 0;
              if (negate) hit = !hit;
              if (hit) {
                const s = regs.get(r);
                if (!s || s.length === 0) throw new DcError(`register ${nameOf(r)} is empty`);
                const m = s[s.length - 1];
                if (typeof m === 'string') call(m);
              }
              break;
            }
            default:
              throw new DcError(`${nameOf(c.charCodeAt(0))} unimplemented`);
          }
        } catch (e) {
          if (e instanceof DcError) err(e.message);
          else throw e;
        }
      }
    };

    try { for (const p of programs) { run(p); if (quitAll) break; } }
    catch (e: any) { if (!(e instanceof Quit)) { ctx.stderr += `dc: ${e?.message ?? e}\n`; ctx.stdout += out; return 1; } }
    ctx.stdout += out;
    return 0;
  },
};
