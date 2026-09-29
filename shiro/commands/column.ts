/**
 * column — util-linux column.
 *
 * -t: a table. Cells split on whitespace (runs merged) or, with -s, on any of the given characters
 * (empty cells kept). Columns are padded to their widest cell and joined with two spaces (-o to
 * change); the last column is not padded, and short rows get empty cells.
 * Otherwise: fill mode — entries in columns (-x: across rows) that fit in 80 characters (-c),
 * each column as wide as the widest entry rounded up to a tab stop, padded with tabs.
 */
import type { Command } from './index';
import { readOperands, toLines } from './flags';

export const column: Command = {
  name: "column",
  description: "Format input into columns",
  async exec(ctx) {
    let table = false, across = false, width = 80;
    let seps: string | null = null, outSep = '  ';
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--table') table = true;
      else if (a === '--fillrows') across = true;
      else if (a.startsWith('--separator=')) seps = a.slice(12);
      else if (a.startsWith('--output-separator=')) outSep = a.slice(19);
      else if (a.startsWith('--output-width=')) width = parseInt(a.slice(15), 10);
      else if (a.startsWith('-') && a.length > 1) {
        for (let j = 1; j < a.length; j++) {
          const c = a[j];
          const rest = a.slice(j + 1);
          if (c === 't') table = true;
          else if (c === 'x') across = true;
          else if (c === 's') { seps = rest || args[++i]; break; }
          else if (c === 'o') { outSep = rest || args[++i]; break; }
          else if (c === 'c') { width = parseInt(rest || args[++i], 10); break; }
          else if (c === 'n' || c === 'e' || c === 'L') { /* no-op */ }
        }
      } else files.push(a);
    }
    const inputs = await readOperands(ctx, 'column', files);
    const lines = inputs.flatMap(inp => toLines(inp.text).lines).filter(l => l.trim() !== '');

    if (table) {
      const rows = lines.map(l => seps === null
        ? l.split(/[ \t]+/).filter(Boolean)
        : l.split(new RegExp('[' + seps.replace(/[\]\\^-]/g, '\\$&') + ']')));
      const ncol = Math.max(0, ...rows.map(r => r.length));
      const widths = Array(ncol).fill(0);
      for (const r of rows) r.forEach((c, k) => { widths[k] = Math.max(widths[k], [...c].length); });
      for (const r of rows) {
        while (r.length < ncol) r.push('');
        ctx.stdout += r.map((c, k) => k === ncol - 1 ? c : c + ' '.repeat(widths[k] - [...c].length) + outSep).join('') + '\n';
      }
      return inputs.failed ? 1 : 0;
    }

    // Fill mode
    const items = lines;
    if (!items.length) return 0;
    const maxLen = Math.max(...items.map(s => [...s].length));
    const colWidth = (maxLen + 8) & ~7;
    const numCols = Math.max(1, Math.floor(width / colWidth));
    if (numCols <= 1) { ctx.stdout += items.map(s => s + '\n').join(''); return 0; }
    const numRows = Math.ceil(items.length / numCols);
    const grid: string[][] = [];
    if (across) for (let r = 0; r < numRows; r++) grid.push(items.slice(r * numCols, (r + 1) * numCols));
    else for (let r = 0; r < numRows; r++) { const row: string[] = []; for (let c = 0; c < numCols; c++) { const k = c * numRows + r; if (k < items.length) row.push(items[k]); } grid.push(row); }
    for (const row of grid) {
      let out = '', col = 0;
      row.forEach((s, k) => {
        out += s;
        col += [...s].length;
        if (k < row.length - 1) {
          const target = (k + 1) * colWidth;
          while (col < target) { out += '\t'; col = (col & ~7) + 8; }
        }
      });
      ctx.stdout += out + '\n';
    }
    return inputs.failed ? 1 : 0;
  },
};
