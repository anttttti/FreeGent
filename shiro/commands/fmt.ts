import type { Command } from './index';
import { readOperands } from './flags';

// GNU fmt: "optimal" paragraph filling as in coreutils fmt.c. Lines aim at the goal width
// (93% of -w, default 75) by minimising squared shortfall and raggedness, with bonuses for
// breaking after sentences and punctuation and penalties for widows, orphans and breaking after
// a period that doesn't end a sentence. Paragraphs are runs of non-blank lines with the same
// indentation. -s only splits long lines, -u uniform spacing, -g goal, -p prefix.

const SQR = (n: number) => n * n;
const SHORT_COST = (n: number) => SQR(n * 10);
const RAGGED_COST = (n: number) => SHORT_COST(n) / 2;
const LINE_COST = SQR(70);
const WIDOW_COST = (n: number) => Math.floor(SQR(200) / (n + 2));
const ORPHAN_COST = (n: number) => Math.floor(SQR(150) / (n + 2));
const SENTENCE_BONUS = SQR(50);
const NOBREAK_COST = SQR(600);
const PAREN_BONUS = SQR(40);
const PUNCT_BONUS = SQR(40);

interface Word { text: string; length: number; space: number; paren: boolean; period: boolean; punct: boolean; final: boolean;
  bestCost: number; nextBreak: number; lineLength: number }

function makeWords(lines: string[], uniform: boolean, lastInInput: boolean): Word[] {
  const words: Word[] = [];
  lines.forEach((line, li) => {
    // Spacing is measured in columns, so a tab counts to the next tab stop.
    const re = /(\S+)(\s*)/g;
    let m: RegExpExecArray | null;
    const lead = line.match(/^\s*/)![0];
    const body = line.slice(lead.length);
    const adv = (col: number, t: string) => { for (const c of t) col = c === '\t' ? (Math.floor(col / 8) + 1) * 8 : col + 1; return col; };
    let col = adv(0, lead);
    while ((m = re.exec(body)) !== null) {
      const text = m[1];
      const atEnd = m.index + m[0].length >= body.length;
      const period = /[.?!]['")\]]*$/.test(text);
      col = adv(col, text);
      const after = adv(col, m[2]);
      const spaceCols = after - col;
      col = after;
      const w: Word = {
        text, length: [...text].length, space: spaceCols,
        paren: /^[(['`"]/.test(text), period, punct: /[!-/:-@[-`{-~]$/.test(text),
        final: false, bestCost: 0, nextBreak: 0, lineLength: 0,
      };
      // A sentence ends at a period followed by a line end or two spaces, or at the end of input.
      w.final = (atEnd && lastInInput && li === lines.length - 1) || (period && (atEnd || w.space > 1));
      if (atEnd || uniform) w.space = w.final ? 2 : 1;
      words.push(w);
    }
  });
  return words;
}

function fmtParagraph(words: Word[], firstIndent: number, otherIndent: number, maxWidth: number, goal: number) {
  const limit = words.length;
  const sentinel: Word = { text: '', length: 0, space: 0, paren: false, period: false, punct: false, final: false, bestCost: 0, nextBreak: limit, lineLength: 0 };
  const W = (k: number) => k === limit ? sentinel : words[k];
  const lineCost = (next: number, len: number): number => {
    if (next === limit) return 0;
    let cost = SHORT_COST(goal - len);
    if (W(next).nextBreak !== limit) cost += RAGGED_COST(len - W(next).lineLength);
    return cost;
  };
  const baseCost = (k: number): number => {
    let cost = LINE_COST;
    if (k > 0) {
      const prev = words[k - 1];
      if (prev.period) cost += prev.final ? -SENTENCE_BONUS : NOBREAK_COST;
      else if (prev.punct) cost -= PUNCT_BONUS;
      else if (k > 1 && words[k - 2].final) cost += WIDOW_COST(words[k - 2].length);
    }
    const w = words[k];
    if (w.paren) cost -= PAREN_BONUS;
    else if (w.final) cost += ORPHAN_COST(w.length);
    return cost;
  };
  for (let start = limit - 1; start >= 0; start--) {
    let best = Infinity;
    let len = (start === 0 ? firstIndent : otherIndent) + words[start].length;
    let w = start;
    do {
      w++;
      const wcost = lineCost(w, len) + W(w).bestCost;
      if (wcost < best) { best = wcost; words[start].nextBreak = w; words[start].lineLength = len; }
      if (w === limit) break;
      len += words[w - 1].space + words[w].length;
    } while (len < maxWidth);
    words[start].bestCost = best + baseCost(start);
  }
}

export const fmt: Command = {
  name: "fmt",
  description: "Simple optimal text formatter",
  async exec(ctx) {
    let width = 75, goal: number | null = null, splitOnly = false, uniform = false, prefix = '';
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (/^-\d+$/.test(a)) width = parseInt(a.slice(1), 10);
      else if (a === '-w' || a === '--width') width = parseInt(args[++i], 10);
      else if (a.startsWith('--width=')) width = parseInt(a.slice(8), 10);
      else if (a.startsWith('-w')) width = parseInt(a.slice(2), 10);
      else if (a === '-g' || a === '--goal') goal = parseInt(args[++i], 10);
      else if (a.startsWith('-g')) goal = parseInt(a.slice(2), 10);
      else if (a === '-p' || a === '--prefix') prefix = args[++i] ?? '';
      else if (a.startsWith('-p')) prefix = a.slice(2);
      else if (a === '-s' || a === '--split-only') splitOnly = true;
      else if (a === '-u' || a === '--uniform-spacing') uniform = true;
      else if (/^-[csut]+$/.test(a)) { if (a.includes('s')) splitOnly = true; if (a.includes('u')) uniform = true; }
      else files.push(a);
    }
    const goalWidth = goal ?? Math.floor(width * (2 * (100 - 7) + 1) / 200);
    const inputs = await readOperands(ctx, 'fmt', files);
    const text = inputs.map(i => i.text).join('');
    const lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    const indentOf = (l: string) => { let col = 0; for (const c of l.match(/^[ \t]*/)![0]) col = c === '\t' ? (Math.floor(col / 8) + 1) * 8 : col + 1; return col; };
    // Tabs in the input: indentation and spacing are written with tabs where they fit (put_space).
    const tabs = text.includes('\t');
    const space = (from: number, n: number) => {
      let col = from, s = '';
      const target = from + n;
      if (tabs) {
        const tabTarget = Math.floor(target / 8) * 8;
        if (col + 1 < tabTarget) while (col < tabTarget) { s += '\t'; col = (Math.floor(col / 8) + 1) * 8; }
      }
      while (col < target) { s += ' '; col++; }
      return s;
    };
    let out = '';
    const emitPara = (para: string[], last: boolean) => {
      const indent = indentOf(para[0]);
      const groups = splitOnly ? para.map(l => [l]) : [para];
      for (const g of groups) {
        const words = makeWords(g.map(l => l.startsWith(prefix) ? l.slice(prefix.length) : l), uniform, last);
        if (!words.length) { out += '\n'; continue; }
        fmtParagraph(words, indent, indentOf(g[1] ?? g[0]), width, goalWidth);
        for (let k = 0; k < words.length; k = words[k].nextBreak) {
          const lineIndent = k === 0 ? indent : indentOf(g[1] ?? g[0]);
          let line = prefix + space(0, lineIndent);
          let col = lineIndent;
          for (let j = k; j < words[k].nextBreak; j++) {
            line += words[j].text;
            col += words[j].length;
            if (j < words[k].nextBreak - 1) { line += space(col, words[j].space); col += words[j].space; }
          }
          out += line + '\n';
        }
      }
    };
    // Paragraphs: runs of non-blank lines with the same indentation.
    const paras: (string[] | string)[] = [];
    let para: string[] = [];
    const flush = () => { if (para.length) paras.push(para); para = []; };
    for (const l of lines) {
      const body = prefix && l.startsWith(prefix) ? l.slice(prefix.length) : l;
      if (body.trim() === '' || (prefix && !l.startsWith(prefix))) { flush(); paras.push(l); continue; }
      if (para.length && indentOf(l) !== indentOf(para[para.length - 1])) flush();
      para.push(l);
    }
    flush();
    const lastPara = paras.reduce((k, p, i) => Array.isArray(p) ? i : k, -1);
    paras.forEach((p, i) => { if (Array.isArray(p)) emitPara(p, i === lastPara); else out += p + '\n'; });
    ctx.stdout += out;
    return inputs.failed ? 1 : 0;
  },
};
