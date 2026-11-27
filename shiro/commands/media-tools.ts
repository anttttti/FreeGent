// ffmpeg, ffprobe, duckdb and tesseract in the browser shell: the same pinned programs as `tool()` in JavaScript (exec-sandbox/tools.ts),
// downloaded when first used. They read and write workspace files by path and need a browser (Worker, network); in Node they say so.

import type { Command, CommandContext } from './index';
import { readOperandBytes } from './flags';
import { loadTool, openDuckdb, runFfmpeg } from '../../exec-sandbox/tools';

const fail = (ctx: CommandContext, name: string, e: any): number => { ctx.stderr += `${name}: ${e?.message || e}\n`; return 1; };
const isFile = async (ctx: CommandContext, p: string): Promise<boolean> => { try { return (await ctx.fs.stat(p)).isFile(); } catch { return false; } };
const writeOut = async (ctx: CommandContext, abs: string, bytes: Uint8Array) => {
  await ctx.fs.mkdir(abs.slice(0, abs.lastIndexOf('/')) || '/', { recursive: true });
  await ctx.fs.writeFile(abs, bytes);
};

// A word of an ffmpeg command line that names a file: it is not an option or a number, and not a filter or a key=value (those hold = : , ).
const FILE_WORD = /^[^-=:,][^=:,]*\.[A-Za-z0-9]{1,5}$/;

async function mediaTool(ctx: CommandContext, name: 'ffmpeg' | 'ffprobe'): Promise<number> {
  const files: Record<string, Uint8Array> = {};
  const args: string[] = [];
  for (const a of ctx.args) {
    if (!FILE_WORD.test(a) || /^\d+(\.\d+)?$/.test(a)) { args.push(a); continue; }
    const abs = ctx.fs.resolvePath(a, ctx.cwd);
    if (await isFile(ctx, abs)) files[abs.slice(1)] = await readOperandBytes(ctx, a);
    args.push(abs);   // an input is staged under its own path; a name that does not exist yet is an output, written back to the same place
  }
  if (!args.length) { ctx.stderr += `usage: ${name} [options] -i input [output]\n`; return 1; }
  try {
    const r = await runFfmpeg(args, files, { probe: name === 'ffprobe' });
    for (const [rel, bytes] of Object.entries(r.files)) await writeOut(ctx, '/' + rel, bytes);
    ctx.stdout += r.stdout ? r.stdout + '\n' : '';
    ctx.stderr += r.stderr ? r.stderr + '\n' : '';
    return r.code;
  } catch (e) { return fail(ctx, name, e); }
}

// ── duckdb ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const splitStatements = (sql: string): string[] => {   // on ; outside quotes
  const out: string[] = []; let cur = '', q = '';
  for (const c of sql) {
    if (q) { cur += c; if (c === q) q = ''; }
    else if (c === "'" || c === '"') { q = c; cur += c; }
    else if (c === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};
const cell = (v: any) => v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v);
const csvCell = (v: any) => { const t = v === null || v === undefined ? '' : cell(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };

function render(rows: Record<string, any>[], mode: 'table' | 'csv' | 'json'): string {
  if (mode === 'json') return JSON.stringify(rows) + '\n';
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  if (mode === 'csv') return [cols.map(csvCell).join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n') + '\n';
  const w = cols.map(c => Math.max(c.length, ...rows.map(r => cell(r[c]).length)));
  const line = (cells: string[]) => cells.map((t, i) => t.padEnd(w[i])).join(' | ').trimEnd();
  return [line(cols), w.map(n => '-'.repeat(n)).join('-+-'), ...rows.map(r => line(cols.map(c => cell(r[c]))))].join('\n') + '\n';
}

async function duckdb(ctx: CommandContext): Promise<number> {
  let mode: 'table' | 'csv' | 'json' = 'table', sql = '';
  for (let i = 0; i < ctx.args.length; i++) {
    const a = ctx.args[i];
    if (a === '-csv') mode = 'csv'; else if (a === '-json') mode = 'json'; else if (a === '-table' || a === '-box') mode = 'table';
    else if (a === '-c' || a === '-s') sql += ctx.args[++i] + ';';
    else if (!a.startsWith('-')) sql += a + ';';
  }
  if (!sql.trim()) sql = ctx.stdin;
  if (!sql.trim()) { ctx.stderr += 'usage: duckdb [-csv|-json] "SELECT … FROM \'data.csv\'"   (files are read by name; COPY … TO \'out.parquet\' writes one)\n'; return 1; }
  let db: any;
  try {
    db = await openDuckdb();   // one database per command: tables do not outlive it
    // A quoted name that is a workspace file is made readable under the name as written.
    for (const m of sql.matchAll(/'([^']+)'/g)) {
      const abs = ctx.fs.resolvePath(m[1], ctx.cwd);
      if (await isFile(ctx, abs)) await db.registerFile(m[1], await readOperandBytes(ctx, m[1]));
    }
    let outText = '';
    for (const st of splitStatements(sql)) outText += render(await db.query(st), mode);
    for (const m of sql.matchAll(/\bTO\s+'([^']+)'/gi)) {
      let bytes: Uint8Array;
      try { bytes = await db.readFile(m[1]); } catch { continue; }   // the statement wrote no such file
      await writeOut(ctx, ctx.fs.resolvePath(m[1], ctx.cwd), bytes);   // a failed write is the command's failure
    }
    ctx.stdout += outText;
    return 0;
  } catch (e) { return fail(ctx, 'duckdb', e); }
  finally { try { await db?.close(); } catch { /* already gone */ } }
}

// ── tesseract ───────────────────────────────────────────────────────────────────────────────────────────────────────

async function tesseract(ctx: CommandContext): Promise<number> {
  const pos: string[] = [];
  for (let i = 0; i < ctx.args.length; i++) {
    const a = ctx.args[i];
    if (a === '-l') { if (ctx.args[++i] !== 'eng') { ctx.stderr += 'tesseract: only the English language file (-l eng) is available\n'; return 1; } }
    else if (!a.startsWith('-')) pos.push(a);
  }
  if (pos.length < 2) { ctx.stderr += 'usage: tesseract image.png stdout|outputbase [-l eng]\n'; return 1; }
  try {
    const t = await loadTool('tesseract');
    const r = await t.recognize(await readOperandBytes(ctx, pos[0]));
    if (pos[1] === 'stdout') ctx.stdout += r.text;
    else await ctx.fs.writeFile(ctx.fs.resolvePath(pos[1] + '.txt', ctx.cwd), r.text);
    return 0;
  } catch (e) { return fail(ctx, 'tesseract', e); }
}

const mk = (name: string, description: string, exec: Command['exec']): Command =>
  ({ name, description, exec, parityScope: 'integration-only', requirements: ['Worker', 'network (first use)'] });

export const mediaToolCmds: Command[] = [
  mk('ffmpeg', 'Audio and video conversion (ffmpeg 0.12 WebAssembly, single thread; downloaded on first use)', c => mediaTool(c, 'ffmpeg')),
  mk('ffprobe', 'Media file information (ffprobe, WebAssembly)', c => mediaTool(c, 'ffprobe')),
  mk('duckdb', 'SQL on CSV, JSON and Parquet files (DuckDB WebAssembly; downloaded on first use)', duckdb),
  mk('tesseract', 'Text from an image (Tesseract OCR WebAssembly, English; downloaded on first use)', tesseract),
];
