/**
 * Small coreutils: rev, tac, shuf, cmp
 */

import type { Command } from './index';
import { parseArgs, readInput } from './flags';

export const revCmd: Command = {
  name: 'rev',
  description: 'Reverse each line of input',
  async exec(ctx) {
    try {
      const { positional } = parseArgs(ctx.args, []);
      const { content } = await readInput(positional, ctx.stdin, ctx.fs, ctx.cwd, ctx.fs.resolvePath);
      if (!content) return 0;
      const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
      const reversed = lines.map(l => l.split('').reverse().join(''));
      ctx.stdout += reversed.join('\n') + '\n';
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `rev: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};

export const tacCmd: Command = {
  name: 'tac',
  description: 'Print file in reverse line order',
  async exec(ctx) {
    try {
      const { positional } = parseArgs(ctx.args, []);
      const { content } = await readInput(positional, ctx.stdin, ctx.fs, ctx.cwd, ctx.fs.resolvePath);
      if (!content) return 0;
      const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
      ctx.stdout += lines.reverse().join('\n') + '\n';
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `tac: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};

export const shufCmd: Command = {
  name: 'shuf',
  description: 'Shuffle lines of input',
  async exec(ctx) {
    try {
      const { values, positional, flags } = parseArgs(ctx.args, ['n', 'i']);

      let lines: string[];

      if (flags.e) {
        // -e: treat remaining args as input lines
        const eIdx = ctx.args.indexOf('-e');
        lines = ctx.args.slice(eIdx + 1);
      } else if (values.i) {
        // -i LO-HI: generate range
        const match = values.i.match(/^(\d+)-(\d+)$/);
        if (!match) {
          ctx.stderr += 'shuf: invalid input range\n';
          return 1;
        }
        const lo = parseInt(match[1], 10);
        const hi = parseInt(match[2], 10);
        lines = [];
        for (let n = lo; n <= hi; n++) lines.push(String(n));
      } else {
        const { content } = await readInput(positional, ctx.stdin, ctx.fs, ctx.cwd, ctx.fs.resolvePath);
        if (!content) return 0;
        lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
      }

      // Fisher-Yates shuffle
      for (let i = lines.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [lines[i], lines[j]] = [lines[j], lines[i]];
      }

      const count = values.n ? Math.min(parseInt(values.n, 10), lines.length) : lines.length;
      ctx.stdout += lines.slice(0, count).join('\n') + '\n';
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `shuf: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};

// GNU cmp: first difference as "A B differ: char N, line M" (-b: "byte N, line M is O C O C"),
// "cmp: EOF on A after byte N, line M" when one is a prefix of the other, -l every difference
// ("%*d %3o %3o", offsets as wide as the larger file — 19 for pipes), -s silent. -i SKIP, -n LIMIT.
export const cmpCmd: Command = {
  name: 'cmp',
  description: 'Compare two files byte by byte',
  async exec(ctx) {
    let list = false, silent = false, printBytes = false, limit = Infinity;
    let skip1 = 0, skip2 = 0;
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-l' || a === '--verbose') list = true;
      else if (a === '-s' || a === '--quiet' || a === '--silent') silent = true;
      else if (a === '-b' || a === '--print-bytes') printBytes = true;
      else if (a === '-n' || a === '--bytes') limit = parseInt(args[++i], 10);
      else if (a.startsWith('--bytes=')) limit = parseInt(a.slice(8), 10);
      else if (a === '-i' || a === '--ignore-initial') { const [x, y] = (args[++i] ?? '0').split(':'); skip1 = parseInt(x, 10); skip2 = parseInt(y ?? x, 10); }
      else if (/^-[lsb]+$/.test(a)) { if (a.includes('l')) list = true; if (a.includes('s')) silent = true; if (a.includes('b')) printBytes = true; }
      else files.push(a);
    }
    if (files.length < 2) files.push('-');
    const read = async (f: string): Promise<Uint8Array> => {
      if (f === '-') return new TextEncoder().encode(ctx.stdin);
      const c = await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd));
      return typeof c === 'string' ? new TextEncoder().encode(c) : c;
    };
    let d1: Uint8Array, d2: Uint8Array;
    try { d1 = await read(files[0]); } catch { ctx.stderr += `cmp: ${files[0]}: No such file or directory\n`; return 2; }
    try { d2 = await read(files[1]); } catch { ctx.stderr += `cmp: ${files[1]}: No such file or directory\n`; return 2; }
    d1 = d1.slice(skip1); d2 = d2.slice(skip2);
    const n = Math.min(d1.length, d2.length, limit);
    // Process substitutions are files here but pipes for bash: they get the pipe width.
    const isPipe = (f: string) => f === '-' || f.startsWith('/dev/fd/') || /(^|\/)\.procsub_/.test(f);
    const width = files.some(isPipe) ? 19 : String(Math.max(d1.length, d2.length)).length;
    const show = (b: number) => b < 32 ? '^' + String.fromCharCode(b + 64) : b === 127 ? '^?' : b >= 128 ? 'M-' + (b - 128 < 32 ? '^' + String.fromCharCode(b - 64) : String.fromCharCode(b - 128)) : String.fromCharCode(b);
    let line = 1, differ = false;
    for (let i = 0; i < n; i++) {
      if (d1[i] !== d2[i]) {
        differ = true;
        if (silent) return 1;
        if (list) { ctx.stdout += `${String(i + 1).padStart(width)} ${d1[i].toString(8).padStart(3)} ${d2[i].toString(8).padStart(3)}\n`; continue; }
        ctx.stdout += printBytes
          ? `${files[0]} ${files[1]} differ: byte ${i + 1}, line ${line} is ${d1[i].toString(8).padStart(3)} ${show(d1[i])} ${d2[i].toString(8).padStart(3)} ${show(d2[i])}\n`
          : `${files[0]} ${files[1]} differ: char ${i + 1}, line ${line}\n`;
        return 1;
      }
      if (d1[i] === 10) line++;
    }
    if (d1.length !== d2.length && n < limit) {
      if (!silent) {
        const shorter = d1.length < d2.length ? files[0] : files[1];
        ctx.stderr += n === 0 ? `cmp: EOF on ${shorter} which is empty\n` : `cmp: EOF on ${shorter} after byte ${n}, line ${line - (d1[n - 1] === 10 ? 1 : 0)}\n`;
      }
      return 1;
    }
    return differ ? 1 : 0;
  },
};

function countLines(str: string, upTo: number): number {
  let lines = 1;
  for (let i = 0; i < upTo; i++) {
    if (str[i] === '\n') lines++;
  }
  return lines;
}
