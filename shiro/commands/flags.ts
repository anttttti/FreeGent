/**
 * Shared utilities for command argument parsing and filesystem helpers.
 */

import type { FileSystem } from '../filesystem';
import type { CommandContext } from './index';
import { textToBytes } from '../utils/bytes';

/** Stable CLI wording for filesystem errors; unknown storage failures retain their message. */
export function filesystemError(error: unknown): string {
  const code = (error as {code?:string})?.code;
  const messages: Record<string,string> = {ENOENT:'No such file or directory', ENOTDIR:'Not a directory',
    EISDIR:'Is a directory', EACCES:'Permission denied', EPERM:'Operation not permitted', EEXIST:'File exists'};
  return messages[code ?? ''] ?? (error instanceof Error ? error.message : String(error));
}

/** GNU's default shell quoting leaves ordinary path operands bare. */
export function quoteOperand(path: string): string {
  return /[^\w./:+,-]/.test(path) ? "'" + path.replace(/'/g, "'\\''") + "'" : path;
}

export interface ParsedArgs {
  flags: Record<string, boolean>;
  values: Record<string, string>;
  positional: string[];
}

/**
 * Parse command arguments into flags, values, and positional args.
 * @param args - raw argument array
 * @param valueFlags - flags that consume the next argument as a value (e.g., ["n"])
 */
export function parseArgs(args: string[], valueFlags: string[] = []): ParsedArgs {
  const flags: Record<string, boolean> = {};
  const values: Record<string, string> = {};
  const positional: string[] = [];
  const valueFlagSet = new Set(valueFlags);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }

    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const eq = name.indexOf('=');
      if (eq > 0 && valueFlagSet.has(name.slice(0,eq))) {
        values[name.slice(0,eq)] = name.slice(eq+1);
      } else if (valueFlagSet.has(name) && i + 1 < args.length) {
        values[name] = args[++i];
      } else {
        flags[name] = true;
      }
    } else if (arg.startsWith("-") && arg.length > 1 && !/^-\d/.test(arg)) {
      const chars = arg.slice(1);

      // Check if the entire string after - matches a long-form value flag
      // (e.g., -name matches value flag "name", -type matches "type")
      if (valueFlagSet.has(chars) && i + 1 < args.length) {
        values[chars] = args[++i];
      } else {
        // Combined short flags: -rf → r=true, f=true
        // Value flag: -n 10 → n="10"
        for (let j = 0; j < chars.length; j++) {
          const ch = chars[j];
          if (valueFlagSet.has(ch)) {
            // Rest of chars or next arg is the value
            const rest = chars.slice(j + 1);
            if (rest) {
              values[ch] = rest;
            } else if (i + 1 < args.length) {
              values[ch] = args[++i];
            }
            break;
          }
          flags[ch] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, values, positional };
}

/**
 * Read input from either files or stdin.
 * If positional args are present, read files. Otherwise use stdin.
 */
export async function readInput(
  positional: string[],
  stdin: string,
  fs: { readFile(path: string, encoding?: string): Promise<string | Uint8Array> },
  cwd: string,
  resolvePath: (path: string, cwd: string) => string
): Promise<{ content: string; files: string[] }> {
  if (positional.length === 0) {
    return { content: stdin, files: [] };
  }
  const files: string[] = [];
  const parts: string[] = [];
  for (const p of positional) {
    const resolved = resolvePath(p, cwd);
    files.push(resolved);
    parts.push(await fs.readFile(resolved, 'utf8') as string);
  }
  return { content: parts.join(""), files };
}

/**
 * Read a file as text (convenience wrapper that always returns string).
 */
export async function readFileText(fs: FileSystem, path: string): Promise<string> {
  return (await fs.readFile(path, 'utf8')) as string;
}

/** A file operand as bytes ("-" = stdin), for commands that work on raw data. */
export async function readOperandBytes(ctx: CommandContext, f: string): Promise<Uint8Array> {
  if (f === '-') return textToBytes(ctx.stdin);
  const c = await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd));
  return typeof c === 'string' ? textToBytes(c) : c;
}

/** GNU size operand: 1k = 1024, 1kB = 1000, `b` = 512, plain digits as is. null when malformed. */
export function parseSize(s: string): number | null {
  const m = /^(\d+)([a-zA-Z]*)$/.exec(s);
  if (!m) return null;
  const n = parseInt(m[1], 10), u = m[2];
  if (u === '') return n;
  if (u === 'b') return n * 512;
  const idx = 'KMGTPEZY'.indexOf(u[0].toUpperCase());
  if (idx < 0) return null;
  if (u.length === 1) return n * 1024 ** (idx + 1);            // K, M, G …: powers of 1024
  if (u.length === 2 && u[1] === 'B') return n * 1000 ** (idx + 1);   // kB, MB, GB …: powers of 1000
  return null;
}

/** Directory entry with metadata (replaces FluffyEntry). */
export interface DirEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink';
  size: number;
  mtime: number;
  mode?: number;
  target?: string;
}

/** Stat result as a plain object (replaces FluffyStat). */
export interface StatEntry {
  type: 'file' | 'dir' | 'symlink';
  size: number;
  mode: number;
  mtime: number;
  target?: string;
}

/**
 * Read directory entries with metadata (name, type, size, mtime).
 * Uses lstat to detect symlinks without following them.
 */
export async function readdirEntries(fs: FileSystem, path: string): Promise<DirEntry[]> {
  const names = await fs.readdir(path);
  const entries: DirEntry[] = [];
  for (const name of names) {
    const childPath = path === '/' ? '/' + name : path + '/' + name;
    const stat = await fs.lstat(childPath);
    const entry: DirEntry = {
      name,
      type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'dir' : 'file',
      size: stat.size,
      mtime: stat.mtime.getTime(),
    };
    if (stat.isSymbolicLink()) {
      try { entry.target = await fs.readlink(childPath); } catch {}
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Get file stat as a plain object (type, size, mode, mtime).
 * Uses lstat to detect symlinks.
 */
export async function statEntry(fs: FileSystem, path: string): Promise<StatEntry> {
  const s = await fs.lstat(path);
  const result: StatEntry = {
    type: s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'dir' : 'file',
    size: s.size,
    mode: s.isSymbolicLink() ? 0o777 : s.mode,
    mtime: s.mtime.getTime(),
  };
  if (s.isSymbolicLink()) {
    try { result.target = await fs.readlink(path); } catch {}
  }
  return result;
}

/**
 * Lines of a text. A final separator ends the last line rather than starting another;
 * `lastNl` says whether the text had it (GNU tools keep a missing final newline missing).
 */
export function toLines(text: string, sep = '\n'): { lines: string[]; lastNl: boolean } {
  if (text === '') return { lines: [], lastNl: true };
  const lines = text.split(sep);
  const lastNl = text.endsWith(sep);
  if (lastNl) lines.pop();
  return { lines, lastNl };
}

/** Lines back to text: each line ends with sep, except the last when lastNl is false. */
export function fromLines(lines: string[], lastNl = true, sep = '\n'): string {
  if (!lines.length) return '';
  return lines.join(sep) + (lastNl ? sep : '');
}

/**
 * Reads each operand ("-" or none = stdin) for commands that handle files one at a time.
 * Missing files are reported as "cmd: name: No such file or directory" and skipped.
 */
export async function readOperands(
  ctx: { args: string[]; stdin: string; stderr: string; cwd: string; fs: { readFile(path: string, encoding?: string): Promise<string | Uint8Array>; resolvePath(p: string, cwd: string): string } },
  cmd: string, files: string[],
): Promise<{ name: string; text: string }[] & { failed?: boolean }> {
  const out: { name: string; text: string }[] & { failed?: boolean } = [];
  for (const f of files.length ? files : ['-']) {
    if (f === '-') { out.push({ name: '-', text: ctx.stdin }); continue; }
    try { out.push({ name: f, text: await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd), 'utf8') as string }); }
    catch (error) { ctx.stderr += cmd === 'head' || cmd === 'tail' ? `${cmd}: cannot open '${f}' for reading: ${filesystemError(error)}\n` : `${cmd}: ${quoteOperand(f)}: ${filesystemError(error)}\n`; out.failed = true; }
  }
  return out;
}

/**
 * Why a file can't be created at an absolute path, as coreutils reports it — its directory
 * doesn't exist ("No such file or directory") or isn't a directory ("Not a directory") — or null
 * when it can. The workspace would otherwise make the missing directory appear.
 */
export async function cannotCreate(fs: { exists(p: string): Promise<boolean>; stat(p: string): Promise<{ isDirectory(): boolean }> }, abs: string): Promise<string | null> {
  const parent = abs.slice(0, abs.lastIndexOf('/')) || '/';
  if (!(await fs.exists(parent))) return 'No such file or directory';
  if (!(await fs.stat(parent)).isDirectory()) return 'Not a directory';
  return null;
}
