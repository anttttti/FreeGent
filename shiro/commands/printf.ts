import type { Command } from './index';
import { bytesToText } from '../utils/bytes';
import { sprintf as cSprintf } from './awk';

/** One formatter for registry and shell builtin entry paths; strings retain raw bytes. */
export function formatPrintf(fmt: string, fmtArgs: string[]): {stdout:string; stderr:string; exitCode:number} {
  let stderr = '', exitCode = 0;
  const BYTE = 0xe000;   // escaped bytes are held as U+E000+byte until decoded below
  let argIdx = 0;
  let result = '';
  // The format is reused until every argument is consumed (printf "%s\n" a b c).
  do {
    const passStart = argIdx;
    let fi = 0;
    while (fi < fmt.length) {
      if (fmt[fi] === '\\') {
        // Escape sequences
        fi++;
        if (fi >= fmt.length) { result += '\\'; break; }
        switch (fmt[fi]) {
          case 'n': result += '\n'; break;
          case 't': result += '\t'; break;
          case 'r': result += '\r'; break;
          case '\\': result += '\\'; break;
          case '"': result += '"'; break;
          case "'": result += "'"; break;
          case 'a': result += '\x07'; break;
          case 'b': result += '\b'; break;
          case 'f': result += '\f'; break;
          case 'v': result += '\v'; break;
          case 'e': case 'E': result += '\x1b'; break;
          case 'x': {
            // \xHH: a byte (see BYTE below)
            const hex = /^[0-9a-fA-F]{1,2}/.exec(fmt.slice(fi + 1));
            if (!hex) { result += '\\x'; break; }
            result += String.fromCharCode(BYTE + parseInt(hex[0], 16));
            fi += hex[0].length;
            break;
          }
          case '0': case '1': case '2': case '3': case '4': case '5': case '6': case '7': {
            // \0NNN or \NNN octal: a byte
            let oct = '';
            if (fmt[fi] === '0') fi++;
            while (fi < fmt.length && /[0-7]/.test(fmt[fi]) && oct.length < 3) { oct += fmt[fi]; fi++; }
            result += String.fromCharCode(BYTE + (parseInt(oct || '0', 8) & 255));
            fi--;
            break;
          }
          default: result += '\\' + fmt[fi];
        }
        fi++;
        continue;
      }
      if (fmt[fi] === '%') {
        fi++;
        if (fi >= fmt.length) { result += '%'; break; }
        if (fmt[fi] === '%') { result += '%'; fi++; continue; }
        // %(fmt)T — date/time formatting
        if (fmt[fi] === '(') {
          const closeP = fmt.indexOf(')T', fi);
          if (closeP > fi) {
            const dateFmt = fmt.slice(fi + 1, closeP);
            const ts = argIdx < fmtArgs.length ? parseInt(fmtArgs[argIdx++]) * 1000 : Date.now();
            const d = new Date(ts === -1000 ? Date.now() : ts);
            let dateResult = dateFmt;
            dateResult = dateResult.replace(/%Y/g, String(d.getFullYear()));
            dateResult = dateResult.replace(/%m/g, String(d.getMonth() + 1).padStart(2, '0'));
            dateResult = dateResult.replace(/%d/g, String(d.getDate()).padStart(2, '0'));
            dateResult = dateResult.replace(/%H/g, String(d.getHours()).padStart(2, '0'));
            dateResult = dateResult.replace(/%M/g, String(d.getMinutes()).padStart(2, '0'));
            dateResult = dateResult.replace(/%S/g, String(d.getSeconds()).padStart(2, '0'));
            result += dateResult;
            fi = closeP + 2;
            continue;
          }
        }
        // Flags, width and precision (* takes them from the arguments)
        let flags = '';
        while (fi < fmt.length && '-+ 0#'.includes(fmt[fi])) { flags += fmt[fi]; fi++; }
        let width = '';
        if (fmt[fi] === '*') { width = String(parseInt(fmtArgs[argIdx++] ?? '0', 10) || 0); fi++; }
        else while (fi < fmt.length && /\d/.test(fmt[fi])) { width += fmt[fi]; fi++; }
        if (width.startsWith('-')) { flags += '-'; width = width.slice(1); }
        let precision: string | null = null;
        if (fi < fmt.length && fmt[fi] === '.') {
          fi++;
          precision = '';
          if (fmt[fi] === '*') { precision = String(parseInt(fmtArgs[argIdx++] ?? '0', 10) || 0); fi++; }
          else while (fi < fmt.length && /\d/.test(fmt[fi])) { precision += fmt[fi]; fi++; }
        }
        while ('hlLjzt'.includes(fmt[fi] ?? '.')) fi++;   // length modifiers are ignored (not q: %q quotes)
        const spec = fi < fmt.length ? fmt[fi] : '';
        fi++;
        const arg = argIdx < fmtArgs.length ? fmtArgs[argIdx++] : '';
        // bash number syntax: 0x hex, 0 octal, 'c or "c the character's code.
        const intArg = (): bigint => {
          const t = arg.trim();
          if (t === '') return 0n;
          if (/^['"]/.test(t)) return BigInt(t.codePointAt(1) ?? 0);
          const m = /^([-+]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9]\d*)/.exec(t);
          if (!m || m[0].length !== t.length) {
            stderr += `printf: ${arg}: invalid number\n`;
            exitCode = 1;
            if (!m) return 0n;
          }
          const body = m[2];
          const v = /^0[xX]/.test(body) ? BigInt(body) : body.length > 1 && body.startsWith('0') ? BigInt('0o' + body.slice(1)) : BigInt(body);
          return m[1] === '-' ? -v : v;
        };
        const floatArg = (): number => {
          const t = arg.trim();
          if (/^['"]/.test(t)) return t.codePointAt(1) ?? 0;
          if (t === '') return 0;
          const v = Number(t.replace(/^([-+]?)0[xX]/, '$10x'));
          if (isNaN(v)) { stderr += `printf: ${arg}: invalid number\n`; exitCode = 1; return parseFloat(t) || 0; }
          return v;
        };
        let formatted = '';
        let numeric = false;
        let sign = '';
        switch (spec) {
          case 's': formatted = precision !== null ? arg.slice(0, parseInt(precision, 10) || 0) : arg; break;
          case 'b': {
            // %b: escape sequences in the argument
            formatted = arg.replace(/\\(0[0-7]{0,3}|x[0-9a-fA-F]{1,2}|.)/g, (_m: string, e: string) => {
              if (e[0] === '0') return String.fromCharCode(BYTE + (parseInt(e.slice(1) || '0', 8) & 255));
              if (e[0] === 'x') return String.fromCharCode(BYTE + parseInt(e.slice(1), 16));
              return ({ n: '\n', t: '\t', r: '\r', '\\': '\\', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' } as any)[e] ?? '\\' + e;
            });
            if (precision !== null) formatted = formatted.slice(0, parseInt(precision, 10) || 0);
            break;
          }
          case 'q': {
            // Shell-quoted so the result reads back as the same word
            formatted = arg === '' ? "''" : /^[A-Za-z0-9_@%+=:,.\/-]+$/.test(arg) ? arg
              : /[\x00-\x1f\x7f]/.test(arg) ? "$'" + arg.replace(/[\\']/g, '\\$&').replace(/[\x00-\x1f\x7f]/g, c => ({ '\n': '\\n', '\t': '\\t', '\r': '\\r' } as any)[c] ?? '\\' + c.charCodeAt(0).toString(8).padStart(3, '0')) + "'"
              : arg.replace(/[^A-Za-z0-9_@%+=:,.\/-]/g, '\\$&');
            break;
          }
          case 'c': formatted = [...arg][0] ?? ''; break;
          case 'd': case 'i': case 'u': case 'o': case 'x': case 'X': {
            numeric = true;
            let v = intArg();
            if (spec === 'u' || spec === 'o' || spec === 'x' || spec === 'X') { if (v < 0n) v += 1n << 64n; }
            if (v < 0n) { sign = '-'; v = -v; } else if (flags.includes('+') && (spec === 'd' || spec === 'i')) sign = '+'; else if (flags.includes(' ') && (spec === 'd' || spec === 'i')) sign = ' ';
            formatted = spec === 'o' ? v.toString(8) : spec === 'x' ? v.toString(16) : spec === 'X' ? v.toString(16).toUpperCase() : v.toString();
            if (precision !== null) formatted = precision === '0' && v === 0n ? '' : formatted.padStart(parseInt(precision, 10) || 0, '0');
            if (flags.includes('#') && v !== 0n) formatted = (spec === 'o' ? '0' : spec === 'x' ? '0x' : spec === 'X' ? '0X' : '') + formatted;
            break;
          }
          case 'e': case 'E': case 'f': case 'F': case 'g': case 'G': case 'a': case 'A': {
            formatted = cSprintf(`%${flags.replace('-', '')}${precision !== null ? '.' + precision : ''}${spec === 'a' || spec === 'A' ? 'e' : spec}`, [floatArg()]);
            break;
          }
          default: formatted = '%' + flags + width + (precision !== null ? '.' + precision : '') + spec;
        }
        // Width
        const w = parseInt(width || '0', 10);
        let full = sign + formatted;
        if ([...full].length < w) {
          if (flags.includes('-')) full = full + ' '.repeat(w - [...full].length);
          else if (numeric && flags.includes('0') && precision === null) full = sign + formatted.padStart(w - sign.length, '0');
          else if (!numeric && flags.includes('0') && 'eEfFgG'.includes(spec)) full = full.startsWith('-') ? '-' + full.slice(1).padStart(w - 1, '0') : full.padStart(w, '0');
          else full = ' '.repeat(w - [...full].length) + full;
        }
        formatted = full;
        result += formatted;
        continue;
      }
      result += fmt[fi];
      fi++;
    }
    if (argIdx === passStart) break;   // no conversions: printed once
  } while (argIdx < fmtArgs.length);
  // Escaped bytes (\xHH, \NNN) are decoded as UTF-8: '\xc3\xa9' is "é"; bytes that aren't
  // UTF-8 stay bytes ('\xe9' writes the one byte E9, utils/bytes.ts).
  result = result.replace(/[\ue000-\ue0ff]+/g, run => bytesToText(Uint8Array.from(run, c => c.charCodeAt(0) - BYTE)));
  return {stdout:result, stderr, exitCode};
}

export const printf: Command = {
  name:'printf', description:'Format and print data',
  async exec(ctx) {
    let args = ctx.args;
    let variable: string | undefined;
    if (args[0] === '-v') { variable = args[1]; args = args.slice(2); }
    if (args[0] === '--') args = args.slice(1);
    if (!args.length) {ctx.stderr += 'printf: usage: printf [-v var] format [arguments]\n'; return 2;}
    if (variable !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
      ctx.stderr += `printf: \`${variable}': not a valid identifier\n`; return 2;
    }
    const result = formatPrintf(args[0],args.slice(1));
    ctx.stderr += result.stderr;
    if (variable !== undefined) ctx.env[variable] = result.stdout;
    else ctx.stdout += result.stdout;
    return result.exitCode;
  },
};
