/**
 * stat — file status (GNU stat: -c/--format, --printf, -t, -L, default layout).
 * The filesystem has no owners or device numbers: uid/gid are 0/root, device 0.
 */
import type { Command } from './index';
import { statEntry } from './flags';

interface Info { path: string; type: 'file' | 'dir' | 'symlink'; size: number; mode: number; mtime: number; target?: string }

const typeBits = (t: Info['type']) => (t === 'dir' ? 0o040000 : t === 'symlink' ? 0o120000 : 0o100000);
const rawMode = (i: Info) => typeBits(i.type) | (i.mode & 0o7777);

function perms(i: Info): string {
  const m = i.mode;
  const t = i.type === 'dir' ? 'd' : i.type === 'symlink' ? 'l' : '-';
  const r = (b: number, c: string) => (m & b ? c : '-');
  const x = (b: number, sb: number, cs: string, c: string) => ((m & sb) ? (m & b ? cs : cs.toUpperCase()) : (m & b ? c : '-'));
  return t + r(0o400, 'r') + r(0o200, 'w') + x(0o100, 0o4000, 's', 'x') + r(0o040, 'r') + r(0o020, 'w') + x(0o010, 0o2000, 's', 'x') + r(0o004, 'r') + r(0o002, 'w') + x(0o001, 0o1000, 't', 'x');
}

const fileType = (i: Info) => (i.type === 'dir' ? 'directory' : i.type === 'symlink' ? 'symbolic link' : i.size === 0 ? 'regular empty file' : 'regular file');
const blocks = (i: Info) => (i.type === 'symlink' || i.size === 0 && i.type === 'file' ? 0 : Math.ceil(Math.max(i.size, 1) / 4096) * 8);

function human(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}000000 +0000`;
}

function directive(c: string, i: Info): string | null {
  const sec = Math.floor(i.mtime / 1000);
  switch (c) {
    case 'a': return (i.mode & 0o7777).toString(8);
    case 'A': return perms(i);
    case 'b': return String(blocks(i));
    case 'B': return '512';
    case 'd': return '0';
    case 'D': return '0';
    case 'f': return rawMode(i).toString(16);
    case 'F': return fileType(i);
    case 'g': return '0';
    case 'G': return 'root';
    case 'h': return '1';
    case 'i': return '0';
    case 'm': return '/';
    case 'n': return i.path;
    case 'N': return i.type === 'symlink' ? `'${i.path}' -> '${i.target ?? ''}'` : `'${i.path}'`;
    case 'o': return '4096';
    case 's': return String(i.size);
    case 't': case 'T': return '0';
    case 'u': return '0';
    case 'U': return 'root';
    case 'w': return '-';
    case 'W': return '0';
    case 'x': case 'y': case 'z': return human(i.mtime);
    case 'X': case 'Y': case 'Z': return String(sec);
    default: return null;
  }
}

function render(fmt: string, i: Info, printf: boolean): string {
  let out = '';
  for (let k = 0; k < fmt.length; k++) {
    const ch = fmt[k];
    if (printf && ch === '\\') {
      const n = fmt[++k];
      out += ({ n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', '0': '\0' } as Record<string, string>)[n] ?? '\\' + (n ?? '');
      continue;
    }
    if (ch !== '%') { out += ch; continue; }
    const m = /^%([-+ #0']*)(\d*)(?:\.(\d+))?([a-zA-Z%])/.exec(fmt.slice(k));
    if (!m) { out += ch; continue; }
    if (m[4] === '%') { out += '%'; k += m[0].length - 1; continue; }
    let text = directive(m[4], i);
    if (text === null) { out += m[0]; k += m[0].length - 1; continue; }
    if (m[3] !== undefined && 'nNFAsa'.includes(m[4]) && !/\d/.test(m[4])) text = text.slice(0, parseInt(m[3], 10));
    const w = m[2] ? parseInt(m[2], 10) : 0;
    const left = m[1].includes('-');
    const zero = m[1].includes('0') && !left && /^[-\d]/.test(text);
    text = left ? text.padEnd(w) : text.padStart(w, zero ? '0' : ' ');
    out += text;
    k += m[0].length - 1;
  }
  return out;
}

export const stat: Command = {
  name: "stat",
  description: "Display file status",
  async exec(ctx) {
    const a = ctx.args;
    let format: string | null = null, printf = false, terse = false, deref = false;
    const files: string[] = [];
    const bad = (m: string) => { ctx.stderr += `stat: ${m}\n`; return 1; };
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x === '--') { files.push(...a.slice(i + 1)); break; }
      if (x === '-c' || x === '--format') { format = a[++i] ?? null; if (format === null) return bad(`option requires an argument -- 'c'`); }
      else if (x.startsWith('--format=')) format = x.slice(9);
      else if (x.startsWith('-c') && x.length > 2) format = x.slice(2);
      else if (x === '--printf' || x.startsWith('--printf=')) { format = x === '--printf' ? (a[++i] ?? '') : x.slice(9); printf = true; }
      else if (x === '-t' || x === '--terse') terse = true;
      else if (x === '-L' || x === '--dereference') deref = true;
      else if (x === '-f' || x === '--file-system') return bad('--file-system is not supported');
      else if (x.startsWith('-') && x.length > 1) return bad(`invalid option -- '${x.replace(/^-+/, '')}'`);
      else files.push(x);
    }
    if (files.length === 0) return bad('missing operand');
    let status = 0;
    for (const path of files) {
      const full = ctx.fs.resolvePath(path, ctx.cwd);
      let st;
      try { st = await statEntry(ctx.fs, full); }
      catch { ctx.stderr += `stat: cannot statx '${path}': No such file or directory\n`; status = 1; continue; }
      if (deref && st.type === 'symlink') { try { st = { ...(await ctx.fs.stat(full) as any), type: 'file' }; } catch { /* dangling: keep */ } }
      const info: Info = { path, type: st.type, size: st.type === 'dir' ? 4096 : st.size, mode: st.mode ?? (st.type === 'dir' ? 0o755 : 0o644), mtime: st.mtime, target: st.target };
      if (format !== null) { ctx.stdout += render(format, info, printf) + (printf ? '' : '\n'); continue; }
      if (terse) {
        const s = Math.floor(info.mtime / 1000);
        ctx.stdout += `${path} ${info.size} ${blocks(info)} ${rawMode(info).toString(16)} 0 0 0 0 1 0 0 ${s} ${s} ${s} 0 4096\n`;
        continue;
      }
      const when = human(info.mtime);
      ctx.stdout += `  File: ${info.type === 'symlink' ? `${path} -> ${info.target ?? ''}` : path}\n` +
        `  Size: ${String(info.size).padEnd(10)}\tBlocks: ${String(blocks(info)).padEnd(10)} IO Block: 4096   ${fileType(info)}\n` +
        `Device: 0h/0d\tInode: 0          Links: 1\n` +
        `Access: (${(info.mode & 0o7777).toString(8).padStart(4, '0')}/${perms(info)})  Uid: (    0/    root)   Gid: (    0/    root)\n` +
        `Access: ${when}\nModify: ${when}\nChange: ${when}\n Birth: -\n`;
    }
    return status;
  },
};
