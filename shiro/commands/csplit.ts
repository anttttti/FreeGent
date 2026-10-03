/**
 * csplit — split a file at context lines (GNU csplit).
 *
 * Patterns: LINE, /REGEXP/[OFFSET], %REGEXP%[OFFSET], each optionally followed by {N} or {*}
 * to repeat. A piece is written for every split, empty ones included (-z elides them); on an
 * error the pieces already written are removed unless -k.
 */

import type { Command } from './index';

/** POSIX basic regular expression → JS: \( \) \{ \} \| \+ \? are operators, bare ( ) { } | + ? literals. */
function breToJs(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) {
      const n = src[++i];
      if ('(){}|+?'.includes(n)) out += n;
      else out += '\\' + n;
    } else if ('(){}|+?'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return out;
}

function formatSuffix(fmt: string, n: number): string {
  const m = /%([-+ #0]*)(\d*)([diouxX])/.exec(fmt);
  if (!m) return fmt;
  const w = m[2] ? parseInt(m[2], 10) : 0;
  const radix = m[3] === 'o' ? 8 : m[3] === 'x' || m[3] === 'X' ? 16 : 10;
  let t = n.toString(radix);
  if (m[3] === 'X') t = t.toUpperCase();
  t = m[1].includes('-') ? t.padEnd(w) : t.padStart(w, m[1].includes('0') ? '0' : ' ');
  return fmt.replace(m[0], t);
}

export const csplitCmd: Command = {
  name: 'csplit',
  description: 'Split a file into sections determined by context lines',
  async exec(ctx) {
    const a = ctx.args;
    let prefix = 'xx', digits = 2, quiet = false, keep = false, elide = false, suppress = false, suffixFmt: string | null = null;
    const operands: string[] = [];
    const bad = (m: string) => { ctx.stderr += `csplit: ${m}\n`; return 1; };
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x === '--') { operands.push(...a.slice(i + 1)); break; }
      if (x === '-f' || x === '--prefix') prefix = a[++i] ?? 'xx';
      else if (x.startsWith('--prefix=')) prefix = x.slice(9);
      else if (x.startsWith('-f') && x.length > 2) prefix = x.slice(2);
      else if (x === '-n' || x === '--digits') digits = parseInt(a[++i], 10);
      else if (x.startsWith('--digits=')) digits = parseInt(x.slice(9), 10);
      else if (x.startsWith('-n') && x.length > 2) digits = parseInt(x.slice(2), 10);
      else if (x === '-b' || x === '--suffix-format') suffixFmt = a[++i] ?? null;
      else if (x.startsWith('--suffix-format=')) suffixFmt = x.slice(16);
      else if (x === '-s' || x === '-q' || x === '--quiet' || x === '--silent') quiet = true;
      else if (x === '-k' || x === '--keep-files') keep = true;
      else if (x === '-z' || x === '--elide-empty-files') elide = true;
      else if (x === '--suppress-matched') suppress = true;
      else if (/^-[sqkz]+$/.test(x)) { for (const c of x.slice(1)) { if (c === 's' || c === 'q') quiet = true; else if (c === 'k') keep = true; else elide = true; } }
      else if (x.startsWith('-') && x.length > 1 && !/^-\d/.test(x)) return bad(`invalid option -- '${x.replace(/^-+/, '')}'`);
      else operands.push(x);
    }
    if (operands.length === 0) return bad('missing operand');
    if (operands.length < 2) return bad(`missing operand after '${operands[0]}'`);
    if (!(digits >= 0)) return bad('invalid number');

    let content: string;
    const file = operands[0];
    if (file === '-') content = ctx.stdin;
    else {
      try { content = await ctx.fs.readFile(ctx.fs.resolvePath(file, ctx.cwd), 'utf8') as string; }
      catch { return bad(`cannot open '${file}' for reading: No such file or directory`); }
    }
    // lines keep their terminators so that pieces reproduce the input exactly
    const lines: string[] = [];
    for (let s = 0; s < content.length;) {
      const nl = content.indexOf('\n', s);
      const e = nl < 0 ? content.length : nl + 1;
      lines.push(content.slice(s, e));
      s = e;
    }

    type Step = { kind: 'line'; n: number } | { kind: 're' | 'skip'; re: RegExp; src: string; offset: number };
    const steps: { step: Step; repeat: number; forever: boolean }[] = [];
    for (const p of operands.slice(1)) {
      if (/^\{(\d+|\*)\}$/.test(p)) {
        const last = steps[steps.length - 1];
        if (!last) return bad(`${p}: invalid pattern`);
        if (p === '{*}') last.forever = true; else last.repeat = parseInt(p.slice(1, -1), 10) + 1;
        continue;
      }
      let m: RegExpExecArray | null;
      if ((m = /^\/(.*)\/([+-]\d+)?$/.exec(p)) || (m = /^%(.*)%([+-]\d+)?$/.exec(p))) {
        let re: RegExp;
        try { re = new RegExp(breToJs(m[1])); } catch { return bad(`${p}: invalid regular expression`); }
        steps.push({ step: { kind: p[0] === '/' ? 're' : 'skip', re, src: p, offset: m[2] ? parseInt(m[2], 10) : 0 }, repeat: 1, forever: false });
      } else if (/^\d+$/.test(p)) {
        const n = parseInt(p, 10);
        if (n === 0) return bad(`${p}: line number must be greater than zero`);
        steps.push({ step: { kind: 'line', n }, repeat: 1, forever: false });
      } else return bad(`${p}: invalid pattern`);
    }

    const written: string[] = [];
    const pieces: string[] = [];
    let cur = 0;                 // index of the first line not yet put in a piece
    // --suppress-matched: the matched line is dropped from the start of the piece it begins, except
    // that GNU csplit 8.32 keeps it when a regexp match starts the last piece
    let dropPending: 'line' | 're' | null = null;
    const piece = async (start: number, end: number, final: boolean) => {
      let st = start;
      if (dropPending && (dropPending === 'line' || !final) && end > st) st++;
      await emit(lines.slice(st, end).join(''));
    };
    let lastLine = 0;            // 1-based number of the previous 'line' pattern
    const fail = async (msg: string) => {
      ctx.stderr += `csplit: ${msg}\n`;
      if (!keep) for (const f of written) { try { await ctx.fs.unlink(ctx.fs.resolvePath(f, ctx.cwd)); } catch { /* gone */ } }
      return 1;
    };
    const emit = async (text: string) => {
      const idx = written.length;
      const sfx = suffixFmt ? formatSuffix(suffixFmt, idx) : String(idx).padStart(digits, '0');
      const name = prefix + sfx;
      if (elide && text === '') return;          // -z: no empty files (numbering skips them too)
      await ctx.fs.writeFile(ctx.fs.resolvePath(name, ctx.cwd), text);
      written.push(name);
      pieces.push(text);
      if (!quiet) ctx.stdout += `${new TextEncoder().encode(text).length}\n`;
    };

    for (const { step, repeat, forever } of steps) {
      for (let rep = 0; forever || rep < repeat; rep++) {
        if (step.kind === 'line') {
          // {N} repeats at the same interval: 3 {2} splits before lines 3, 6 and 9
          const n = rep === 0 ? step.n : lastLine + step.n;
          if (n - 1 < cur) return fail(`'${n}': line number out of range`);
          if (n - 1 > lines.length) {
            if (forever) break;
            await piece(cur, lines.length, true);     // GNU writes what there is, then reports the error
            return fail(`'${n}': line number out of range`);
          }
          await piece(cur, n - 1, false);
          cur = n - 1;
          lastLine = n;
          dropPending = suppress ? 'line' : null;
          continue;
        }
        // regexp: search from the current line (after the previous match when repeating)
        const from = rep > 0 ? cur + 1 : cur;
        let found = -1;
        for (let i = from; i < lines.length; i++) { if (step.re.test(lines[i].replace(/\n$/, ''))) { found = i; break; } }
        if (found < 0) { if (forever) break; return fail(`'${step.src}': match not found`); }
        let at = found + step.offset;
        if (at < cur) return fail(`'${step.src}': line number out of range`);
        if (at > lines.length) at = lines.length;
        if (step.kind === 'skip') { cur = at; continue; }      // %re%: discard up to the match
        await piece(cur, at, false);
        cur = at;
        dropPending = suppress ? 're' : null;
      }
    }
    await piece(cur, lines.length, true);
    return 0;
  },
};
