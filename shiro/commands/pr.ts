/**
 * pr — paginate and columnate files for printing (GNU pr).
 *
 * Page = 5 header lines (2 blank, "date  name  Page N", 2 blank) + body + 5 trailer lines, 66 lines in all;
 * -t drops header and trailer. -COLUMN / -a / -m lay text out in columns padded with tabs (spaces
 * after the last tab stop that fits); -s CHAR separates instead. -n numbers lines, -d double spaces,
 * -o indents, -h sets the header, -l the page length, -w the width, +FIRST[:LAST] selects pages.
 */
import type { Command } from './index';
import { readFileText } from './flags';
import { strftime } from './date';


/** Pad `text` (currently `at` columns wide) out to column `to`: tabs while a stop fits, then spaces. */
function padTo(at: number, to: number, tabs: boolean): string {
  let s = '';
  if (tabs) {
    for (let next = (Math.floor(at / 8) + 1) * 8; next <= to; next = (Math.floor(at / 8) + 1) * 8) { s += '\t'; at = next; }
  }
  return s + ' '.repeat(Math.max(0, to - at));
}

const BLANK_TOP = 2, BLANK_BELOW = 2, TRAILER = 5;

export const pr: Command = {
  name: "pr",
  description: "Convert text files for printing with headers and page breaks",
  async exec(ctx) {
    const a = ctx.args;
    let header: string | null = null, pageLength = 66, pageWidth = 72, omit = false, double = false;
    let columns = 1, across = false, merge = false, margin = 0, firstPage = 1, lastPage = Infinity;
    let sep: string | null = null, numberSep: string | null = null, numberDigits = 5, firstNumber = 1;
    let formFeed = false, dateFmt = '%Y-%m-%d %H:%M', expandTabs = false, truncate = false, noFileWarnings = false;
    const files: string[] = [];
    const bad = (m: string) => { ctx.stderr += `pr: ${m}\n`; return 1; };
    const num = (s: string, what: string): number | null => (/^\d+$/.test(s) && parseInt(s, 10) > 0 ? parseInt(s, 10) : (bad(`invalid ${what} '${s}'`), null));
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x === '--') { files.push(...a.slice(i + 1)); break; }
      let m: RegExpExecArray | null;
      if ((m = /^\+(\d+)(?::(\d+))?$/.exec(x))) { firstPage = parseInt(m[1], 10); if (m[2]) lastPage = parseInt(m[2], 10); }
      else if (/^-\d+$/.test(x)) columns = parseInt(x.slice(1), 10);
      else if (x === '--columns' || x.startsWith('--columns=')) { const v = x.includes('=') ? x.slice(10) : a[++i]; const n = num(v ?? '', 'number of columns'); if (n === null) return 1; columns = n; }
      else if (x === '-a' || x === '--across') across = true;
      else if (x === '-d' || x === '--double-space') double = true;
      else if (x === '-t' || x === '--omit-header') omit = true;
      else if (x === '-T' || x === '--omit-pagination') omit = true;
      else if (x === '-m' || x === '--merge') merge = true;
      else if (x === '-F' || x === '-f' || x === '--form-feed') formFeed = true;
      else if (x === '-r' || x === '--no-file-warnings') noFileWarnings = true;
      else if (x === '-v' || x === '--show-nonprinting' || x === '-J' || x === '--join-lines') { /* accepted */ }
      else if (x === '-h' || x === '--header') header = a[++i] ?? '';
      else if (x.startsWith('--header=')) header = x.slice(9);
      else if (x === '-l' || x === '--length') { const n = num(a[++i] ?? '', 'page length'); if (n === null) return 1; pageLength = n; }
      else if (x.startsWith('--length=')) { const n = num(x.slice(9), 'page length'); if (n === null) return 1; pageLength = n; }
      else if (x.startsWith('-l') && /^\d+$/.test(x.slice(2))) pageLength = parseInt(x.slice(2), 10);
      else if (x === '-w' || x === '-W' || x === '--width' || x === '--page-width') { const n = num(a[++i] ?? '', 'page width'); if (n === null) return 1; pageWidth = n; if (x === '-W' || x === '--page-width') truncate = true; }
      else if (/^-[wW]\d+$/.test(x)) { pageWidth = parseInt(x.slice(2), 10); if (x[1] === 'W') truncate = true; }
      else if (x.startsWith('--width=')) pageWidth = parseInt(x.slice(8), 10);
      else if (x === '-o' || x === '--indent') { margin = parseInt(a[++i] ?? '', 10); if (!(margin >= 0)) return bad(`invalid line offset '${a[i]}'`); }
      else if (/^-o\d+$/.test(x)) margin = parseInt(x.slice(2), 10);
      else if (x.startsWith('--indent=')) margin = parseInt(x.slice(9), 10);
      else if (x === '-N' || x === '--first-line-number') firstNumber = parseInt(a[++i] ?? '1', 10);
      else if (/^-N-?\d+$/.test(x)) firstNumber = parseInt(x.slice(2), 10);
      else if (x.startsWith('-s')) sep = x.length > 2 ? x[2] : '\t';
      else if (x.startsWith('--separator=')) sep = x.slice(12) || '\t';
      else if (x.startsWith('-S')) sep = x.slice(2) || ' ';
      else if (x.startsWith('--sep-string=')) sep = x.slice(13);
      else if (x.startsWith('-n')) { const r = x.slice(2); numberSep = '\t'; if (r) { const c = /^\D/.test(r) ? r[0] : null; if (c) { numberSep = c; if (r.length > 1) numberDigits = parseInt(r.slice(1), 10) || 5; } else numberDigits = parseInt(r, 10) || 5; } }
      else if (x === '--number-lines') numberSep = '\t';
      else if (x.startsWith('-D')) dateFmt = (x.length > 2 ? x.slice(2) : a[++i] ?? '').replace(/^\+/, '');
      else if (x.startsWith('--date-format=')) dateFmt = x.slice(14);
      else if (x.startsWith('-e')) expandTabs = true;
      else if (x.startsWith('-i')) { /* output tabs: accepted (padding already uses them) */ }
      else if (x.startsWith('-') && x.length > 1) return bad(`invalid option -- '${x.replace(/^-+/, '')}'`);
      else files.push(x);
    }
    if (files.length === 0) files.push('-');
    if (pageLength <= BLANK_TOP + BLANK_BELOW + 1 + TRAILER) omit = true;     // too short for a header and trailer
    const body = omit ? pageLength : pageLength - (BLANK_TOP + 1 + BLANK_BELOW) - TRAILER;
    const indent = ' '.repeat(margin);

    // load the inputs
    interface Src { name: string; lines: string[]; mtime: Date }
    const srcs: Src[] = [];
    let status = 0;
    for (const f of files) {
      try {
        let text: string, mtime = new Date();
        if (f === '-') text = ctx.stdin;
        else {
          const full = ctx.fs.resolvePath(f, ctx.cwd);
          text = await readFileText(ctx.fs, full);
          try { mtime = new Date((await ctx.fs.stat(full) as any).mtime ?? Date.now()); } catch { /* keep now */ }
        }
        const lines = text === '' ? [] : (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
        srcs.push({ name: f === '-' ? '' : f, lines: expandTabs ? lines.map(l => l.replace(/\t/g, ' '.repeat(8))) : lines, mtime });
      } catch {
        if (!noFileWarnings) ctx.stderr += `pr: cannot open '${f}': No such file or directory\n`;
        status = 1;
      }
    }

    let out = '';
    const colCount = merge ? srcs.length : columns;
    const sepLen = sep !== null ? sep.length : 1;
    const colWidth = colCount > 1 ? Math.floor((pageWidth - (colCount - 1) * sepLen) / colCount) : pageWidth;
    let number = firstNumber;

    const renderRow = (cells: string[]): string => {
      const parts: string[] = [];
      let used = 0;
      cells.forEach((cell, ci) => {
        let text = cell;
        if (numberSep !== null && cell !== '') {
          text = String(number++).padStart(numberDigits).slice(-numberDigits) + numberSep + cell;
        }
        if (colCount > 1 && sep === null && text.length > colWidth) text = text.slice(0, colWidth);
        if (truncate && text.length > pageWidth) text = text.slice(0, pageWidth);
        const last = ci === cells.length - 1;
        if (colCount > 1 && ci > 0) {
          if (sep !== null) { parts.push(sep); used += sep.length; }
          else { const start = ci * (colWidth + sepLen); parts.push(padTo(used, start, true)); used = start; }
        }
        parts.push(text);
        used += text.length;
        void last;
      });
      // trailing padding is never written
      return indent + parts.join('').replace(/[ \t]+$/, m => (cells[cells.length - 1] === '' ? '' : m));
    };

    const emit = (s: Src, mergedSrcs: Src[] | null) => {
      const inputs = mergedSrcs ? mergedSrcs.map(x => x.lines) : [s.lines];
      // rows of cells per page
      let pageNo = 1;
      let idx = 0;                      // lines consumed (single-stream mode)
      const cursors = inputs.map(() => 0);
      const total = mergedSrcs ? Math.max(...inputs.map(l => l.length)) : s.lines.length;
      const title = header ?? s.name;
      const when = strftime(dateFmt, s.mtime, false);
      const doneAll = () => (mergedSrcs ? cursors.every((c, k) => c >= inputs[k].length) : idx >= total);
      while (!doneAll()) {
        let rows: string[][] = [];
        if (mergedSrcs) {
          for (let r = 0; r < body && !doneAll(); r++) { rows.push(inputs.map((lines, k) => (cursors[k] < lines.length ? lines[cursors[k]++] : ''))); }
        } else if (colCount === 1) {
          for (let r = 0; r < body && idx < total; r++) rows.push([s.lines[idx++]]);
        } else {
          const chunk = s.lines.slice(idx, idx + body * colCount);
          idx += chunk.length;
          const perCol = chunk.length < body * colCount ? Math.ceil(chunk.length / colCount) : body;   // the last page is balanced
          if (across) for (let r = 0; r * colCount < chunk.length; r++) rows.push(chunk.slice(r * colCount, (r + 1) * colCount));
          else for (let r = 0; r < perCol; r++) { const row: string[] = []; for (let c = 0; c < colCount; c++) { const v = chunk[c * perCol + r]; if (v !== undefined) row.push(v); } rows.push(row); }
        }
        const lastCell = (row: string[]) => { while (row.length > 1 && row[row.length - 1] === '') row.pop(); return row; };
        rows = rows.map(r => (colCount > 1 ? lastCell(r) : r));
        if (pageNo >= firstPage && pageNo <= lastPage) {
          if (!omit) {
            const width = Math.max(pageWidth, 1);
            const mid = width - when.length - `Page ${pageNo}`.length;
            const left = Math.floor((mid - title.length) / 2);
            const headerLine = mid >= title.length ? when + ' '.repeat(left) + title + ' '.repeat(mid - title.length - left) + `Page ${pageNo}` : `${when} ${title} Page ${pageNo}`;
            out += '\n'.repeat(BLANK_TOP) + indent + headerLine + '\n'.repeat(BLANK_BELOW + 1);
          }
          let printed = 0;
          for (const row of rows) {
            out += renderRow(row) + '\n';
            printed++;
            if (double) { out += '\n'; printed++; }
          }
          if (!omit) {
            if (formFeed) out += '\f';
            else out += '\n'.repeat(Math.max(0, body - printed) + TRAILER);
          }
        } else if (numberSep !== null) number += rows.reduce((n, r) => n + r.filter(c => c !== '').length, 0);
        pageNo++;
      }
    };

    if (merge) { if (srcs.length) emit(srcs[0], srcs); }
    else for (const s of srcs) { number = firstNumber; emit(s, null); }
    ctx.stdout += out;
    return status;
  },
};
