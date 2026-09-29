import type { Command } from './index';
import { sprintf } from './awk';

// GNU numfmt: --from/--to none|si|iec|iec-i|auto, --round (default from-zero), --format (printf
// %f with width/precision, text around it), --padding, --suffix, --field, -d, --header,
// --invalid. Scaled output has one decimal below 10 ("9.6M") and none from 10 up; values read
// with a --from unit become integers.
const UNITS = 'KMGTPEZY';

export const numfmtCmd: Command = {
  name: 'numfmt',
  description: 'Convert numbers to/from human-readable strings',
  async exec(ctx) {
    let from = 'none', to = 'none', round = 'from-zero', format: string | null = null, padding = 0;
    let suffix = '', field = 1, delim: string | null = null, header = 0, invalid = 'abort';
    const nums: string[] = [];
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      const [k, v] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
      const val = () => v ?? ctx.args[++i];
      if (k === '--from') from = val();
      else if (k === '--to') to = val();
      else if (k === '--round') round = val();
      else if (k === '--format') format = val();
      else if (k === '--padding') padding = parseInt(val(), 10);
      else if (k === '--suffix') suffix = val();
      else if (k === '--field') field = parseInt(val(), 10);
      else if (k === '-d' || k === '--delimiter') delim = val();
      else if (k.startsWith('-d') && k.length > 2) delim = k.slice(2);
      else if (k === '--header') header = v ? parseInt(v, 10) : 1;
      else if (k === '--invalid') invalid = val();
      else if (k === '--grouping' || k === '-z' || k === '--zero-terminated' || k === '--debug') { /* C locale: no grouping */ }
      else nums.push(a);
    }
    const doRound = (x: number) => {
      switch (round) {
        case 'up': return Math.ceil(x);
        case 'down': return Math.floor(x);
        case 'towards-zero': return Math.trunc(x);
        case 'nearest': return Math.sign(x) * Math.round(Math.abs(x));
        default: return Math.sign(x) * Math.ceil(Math.abs(x));
      }
    };
    const roundTo = (x: number, dp: number) => doRound(x * 10 ** dp) / 10 ** dp;
    const parse = (s: string): number => {
      const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+))([A-Za-z]{0,2})\s*$/.exec(s);
      if (!m) throw new Error(`invalid number: '${s}'`);
      const n = parseFloat(m[1]);
      const sfx = m[2];
      if (!sfx) return n;
      const u = UNITS.indexOf(sfx[0]);
      const withI = sfx.length === 2 && sfx[1] === 'i';
      if (u < 0 || (sfx.length === 2 && !withI) || from === 'none' || (from === 'si' && withI) || (from === 'iec' && withI) || (from === 'iec-i' && !withI)) {
        throw new Error(from === 'none' ? `invalid suffix in input: '${s}'` : `invalid suffix in input: '${s}'`);
      }
      const base = from === 'si' || (from === 'auto' && !withI) ? 1000 : 1024;
      return doRound(n * base ** (u + 1));
    };
    const render = (x: number): string => {
      let out: string;
      if (to === 'none') {
        out = format ? '' : Number.isInteger(x) ? String(x) : String(x);
      } else {
        const base = to === 'si' ? 1000 : 1024;
        let p = 0, v = Math.abs(x);
        while (v >= base && p < UNITS.length) { v /= base; p++; }
        if (p === 0) out = String(doRound(x));
        else {
          let r = v < 10 ? roundTo(v, 1) : doRound(v);
          if (r >= base && p < UNITS.length) { r = roundTo(r / base, 1); p++; }
          const s = r < 10 ? r.toFixed(1) : String(r);
          out = (x < 0 ? '-' : '') + s + UNITS[p - 1] + (to === 'iec-i' ? 'i' : '');
        }
      }
      if (format) {
        const m = /^(.*?)%('?)(-?)(0?)(\d*)(?:\.(\d+))?f(.*)$/.exec(format);
        if (!m) throw new Error(`invalid format '${format}'`);
        const [, pre, , left, zero, width, prec, post] = m;
        const body = to === 'none' ? (prec !== undefined ? sprintf(`%.${prec}f`, [roundTo(x, parseInt(prec, 10))]) : String(x)) : out;
        const w = parseInt(width || '0', 10);
        const padded = body.length >= w ? body : left ? body.padEnd(w) : zero ? body.padStart(w, '0') : body.padStart(w);
        out = pre + padded + post;
      }
      out += suffix;
      if (padding) out = padding > 0 ? out.padStart(padding) : out.padEnd(-padding);
      return out;
    };
    const convertLine = (line: string): string => {
      const parts = delim === null ? line.split(/(\s+)/) : line.split(delim);
      const idx = delim === null ? (() => { let n = 0; for (let k = 0; k < parts.length; k++) { if (/^\s+$/.test(parts[k]) || parts[k] === '') continue; n++; if (n === field) return k; } return -1; })() : field - 1;
      if (idx < 0 || idx >= parts.length) return line;
      parts[idx] = render(parse(parts[idx]));
      return delim === null ? parts.join('') : parts.join(delim);
    };
    let rc = 0;
    const lines = nums.length ? nums : ctx.stdin.split('\n').filter((l, k, arr) => k < arr.length - 1 || l !== '');
    lines.forEach((l, k) => {
      if (!nums.length && k < header) { ctx.stdout += l + '\n'; return; }
      try { ctx.stdout += convertLine(l) + '\n'; }
      catch (e: any) {
        ctx.stderr += `numfmt: ${e.message}\n`;
        rc = 2;
        if (invalid === 'warn' || invalid === 'ignore') ctx.stdout += l + '\n';
      }
    });
    return rc;
  },
};
