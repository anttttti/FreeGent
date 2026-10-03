/**
 * Small coreutils: rev, tac, shuf, cmp
 */

import type { Command } from './index';
import { parseArgs, readInput } from './flags';
import { bytesToText, textToBytes } from '../utils/bytes';

export const revCmd: Command = {
  name: 'rev',
  description: 'Reverse each line of input',
  async exec(ctx) {
    try {
      const { positional } = parseArgs(ctx.args, []);
      const { content } = await readInput(positional, ctx.stdin, ctx.fs, ctx.cwd, ctx.fs.resolvePath);
      if (!content) return 0;
      const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
      const reversed = lines.map(l => Array.from(l).reverse().join(''));
      ctx.stdout += reversed.join('\n') + '\n';
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `rev: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};

// GNU tac: the file is cut into records that each end with the separator (default newline; -b: begin
// with it; -r: the separator is a regex); the last record may lack it. Records are written in reverse
// order, unchanged, and each file is reversed on its own.
function tacRecords(text: string, sep: string, before: boolean, regex: boolean): string[] {
  const re = regex ? new RegExp(sep, 'g') : null;
  const seps: { start: number; end: number }[] = [];
  if (re) {
    for (const m of text.matchAll(re)) { if (m[0].length) seps.push({ start: m.index!, end: m.index! + m[0].length }); }
  } else if (sep.length) {
    for (let i = text.indexOf(sep); i >= 0; i = text.indexOf(sep, i + sep.length)) seps.push({ start: i, end: i + sep.length });
  }
  const records: string[] = [];
  if (before) {
    let start = 0;
    for (const m of seps) { if (m.start > start) records.push(text.slice(start, m.start)); start = m.start; }
    if (start < text.length) records.push(text.slice(start));
  } else {
    let start = 0;
    for (const m of seps) { records.push(text.slice(start, m.end)); start = m.end; }
    if (start < text.length) records.push(text.slice(start));
  }
  return records;
}

export const tacCmd: Command = {
  name: 'tac',
  description: 'Print file in reverse line order',
  async exec(ctx) {
    let sep = '\n', before = false, regex = false;
    const files: string[] = [];
    const a = ctx.args;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x === '--') { files.push(...a.slice(i + 1)); break; }
      if (x === '-b' || x === '--before') before = true;
      else if (x === '-r' || x === '--regex') regex = true;
      else if (x === '-s' || x === '--separator') sep = a[++i] ?? '';
      else if (x.startsWith('--separator=')) sep = x.slice(12);
      else if (x.startsWith('-s') && x.length > 2) sep = x.slice(2);
      else if (/^-[br]+$/.test(x)) { if (x.includes('b')) before = true; if (x.includes('r')) regex = true; }
      else if (x.startsWith('-') && x.length > 1) { ctx.stderr += `tac: invalid option -- '${x.replace(/^-+/, '')}'\n`; return 1; }
      else files.push(x);
    }
    let status = 0;
    const emit = (text: string) => {
      const records = tacRecords(text, sep, before, regex);
      for (let i = records.length - 1; i >= 0; i--) ctx.stdout += records[i];
    };
    if (files.length === 0) { emit(ctx.stdin); return 0; }
    for (const f of files) {
      if (f === '-') { emit(ctx.stdin); continue; }
      try { emit(await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd), 'utf8') as string); }
      catch { ctx.stderr += `tac: failed to open '${f}' for reading: No such file or directory\n`; status = 1; }
    }
    return status;
  },
};

export const shufCmd: Command = {
  name: 'shuf',
  description: 'Shuffle lines of input',
  async exec(ctx) {
    let echo = false, repeat = false, zero = false;
    let range: [number, number] | null = null;
    let count = Infinity;
    let output: string | null = null;
    const operands: string[] = [];
    const a = ctx.args;
    const bad = (m: string) => { ctx.stderr += `shuf: ${m}\n`; return 1; };
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x === '--') { operands.push(...a.slice(i + 1)); break; }
      if (x === '-e' || x === '--echo') echo = true;
      else if (x === '-r' || x === '--repeat') repeat = true;
      else if (x === '-z' || x === '--zero-terminated') zero = true;
      else if (x === '-n' || x === '--head-count' || x.startsWith('--head-count=') || (x.startsWith('-n') && x.length > 2)) {
        const v = x.startsWith('--head-count=') ? x.slice(13) : x.length > 2 && !x.startsWith('--') ? x.slice(2) : a[++i];
        if (!/^\d+$/.test(v ?? '')) return bad(`invalid line count: '${v}'`);
        count = Math.min(count, parseInt(v, 10));
      } else if (x === '-i' || x === '--input-range' || x.startsWith('--input-range=') || (x.startsWith('-i') && x.length > 2)) {
        const v = x.startsWith('--input-range=') ? x.slice(14) : x.length > 2 && !x.startsWith('--') ? x.slice(2) : a[++i];
        const m = /^(\d+)-(\d+)$/.exec(v ?? '');
        if (!m) return bad(`invalid input range: '${v}'`);
        range = [parseInt(m[1], 10), parseInt(m[2], 10)];
        if (range[0] > range[1] + 1) return bad(`invalid input range: '${v}'`);
      } else if (x === '-o' || x === '--output' || x.startsWith('--output=') || (x.startsWith('-o') && x.length > 2)) {
        output = x.startsWith('--output=') ? x.slice(9) : x.length > 2 && !x.startsWith('--') ? x.slice(2) : a[++i];
      } else if (x.startsWith('-') && x.length > 1) return bad(`invalid option -- '${x.replace(/^-+/, '')}'`);
      else operands.push(x);
    }
    const sep = zero ? '\0' : '\n';
    let lines: string[];
    if (echo) lines = operands;
    else if (range) {
      if (operands.length) return bad(`extra operand '${operands[0]}'`);
      lines = [];
      for (let n = range[0]; n <= range[1]; n++) lines.push(String(n));
    } else {
      let content: string;
      if (operands.length === 0 || operands[0] === '-') content = ctx.stdin;
      else {
        try { content = await ctx.fs.readFile(ctx.fs.resolvePath(operands[0], ctx.cwd), 'utf8') as string; }
        catch { return bad(`${operands[0]}: No such file or directory`); }
      }
      lines = content === '' ? [] : (content.endsWith(sep) ? content.slice(0, -1) : content).split(sep);
    }
    const pick = (n: number) => Math.floor(Math.random() * n);
    const out: string[] = [];
    if (repeat) {
      if (lines.length === 0) { if (count !== Infinity) return bad('no lines to repeat'); }
      else for (let n = 0; n < Math.min(count, 100000); n++) out.push(lines[pick(lines.length)]);
    } else {
      for (let i = lines.length - 1; i > 0; i--) {   // Fisher-Yates
        const j = pick(i + 1);
        [lines[i], lines[j]] = [lines[j], lines[i]];
      }
      out.push(...lines.slice(0, count));
    }
    const text = out.map(l => l + sep).join('');
    if (output !== null) await ctx.fs.writeFile(ctx.fs.resolvePath(output, ctx.cwd), text);
    else ctx.stdout += text;
    return 0;
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
      if (f === '-') return textToBytes(ctx.stdin);
      const c = await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd));
      return typeof c === 'string' ? textToBytes(c) : c;
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
          : `${files[0]} ${files[1]} differ: byte ${i + 1}, line ${line}\n`;
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
