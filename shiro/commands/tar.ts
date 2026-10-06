import { transformBytes } from '../utils/streams';
/**
 * tar — create, append, list and extract archives (POSIX ustar, GNU long names, pax paths).
 *
 * Binary-safe (file contents are bytes), reads gzip / bzip2 / xz / zstd archives by their magic
 * bytes, writes them with -z -j -J --zstd or -a (by file suffix), and takes archives from stdin or
 * puts them on stdout with -f -. Exit status follows GNU tar: 0 ok, 2 on fatal or per-file errors.
 */
import type { Command, CommandContext } from './index';
import { readdirEntries, statEntry } from './flags';
import { bytesToText, textToBytes } from '../utils/bytes';
import { globToRegex } from '../utils/glob-regex.js';

const BLOCK = 512;
const enc = new TextEncoder();
const dec = new TextDecoder();

type Codec = 'none' | 'gzip' | 'bzip2' | 'xz' | 'zstd';

interface Entry {
  name: string;
  kind: 'file' | 'dir' | 'symlink' | 'hardlink' | 'other';
  mode: number;
  mtime: number;          // seconds
  size: number;
  uname: string;
  gname: string;
  linkname: string;
  data: Uint8Array;
}

// ── compression ──────────────────────────────────────────────────────


function detectCodec(b: Uint8Array): Codec {
  if (b[0] === 0x1f && b[1] === 0x8b) return 'gzip';
  if (b[0] === 0x42 && b[1] === 0x5a && b[2] === 0x68) return 'bzip2';
  if (b[0] === 0xfd && b[1] === 0x37 && b[2] === 0x7a && b[3] === 0x58) return 'xz';
  if (b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd) return 'zstd';
  return 'none';
}

async function decompress(codec: Codec, data: Uint8Array,ctx:CommandContext): Promise<Uint8Array> {
  switch (codec) {
    case 'gzip': return transformBytes(new DecompressionStream('gzip') as any, data);
    case 'bzip2': return (await import('./bzip2')).bzip2Decompress(data);
    case 'xz': return (await import('./xz')).xzDecompress(data);
    case 'zstd': return (await import('./zstd')).zstdDecompress(data,ctx);
    default: return data;
  }
}

async function compress(codec: Codec, data: Uint8Array,ctx:CommandContext): Promise<Uint8Array> {
  switch (codec) {
    case 'gzip': return transformBytes(new CompressionStream('gzip') as any, data);
    case 'bzip2': return (await import('./bzip2')).bzip2Compress(data);
    case 'xz': return (await import('./xz')).xzCompress(data);
    case 'zstd': return (await import('./zstd')).zstdCompress(data,ctx);
    default: return data;
  }
}

function codecForName(name: string): Codec {
  if (/\.(tar\.gz|tgz)$/i.test(name)) return 'gzip';
  if (/\.(tar\.bz2|tbz2?|tbz)$/i.test(name)) return 'bzip2';
  if (/\.(tar\.xz|txz)$/i.test(name)) return 'xz';
  if (/\.(tar\.zst|tzst)$/i.test(name)) return 'zstd';
  return 'none';
}

// ── ustar blocks ─────────────────────────────────────────────────────

const octal = (n: number, len: number) => n.toString(8).padStart(len - 1, '0').slice(-(len - 1)) + '\0';

function headerBlock(name: string, e: Entry, typeflag: string, size: number, linkname: string): Uint8Array {
  const h = new Uint8Array(BLOCK);
  let fileName = name, prefix = '';
  const bytesLen = (s: string) => enc.encode(s).length;
  if (bytesLen(fileName) > 100) {
    // split at a slash so that the prefix (<= 155) and the rest (<= 100) both fit
    for (let slash = fileName.indexOf('/'); slash >= 0; slash = fileName.indexOf('/', slash + 1)) {
      const p = fileName.slice(0, slash), n = fileName.slice(slash + 1);
      if (bytesLen(p) <= 155 && bytesLen(n) <= 100 && n.length) { prefix = p; fileName = n; break; }
    }
  }
  h.set(enc.encode(fileName).slice(0, 100), 0);
  h.set(enc.encode(octal(e.mode & 0o7777, 8)), 100);
  h.set(enc.encode(octal(0, 8)), 108);
  h.set(enc.encode(octal(0, 8)), 116);
  h.set(enc.encode(octal(size, 12)), 124);
  h.set(enc.encode(octal(Math.max(0, Math.floor(e.mtime)), 12)), 136);
  for (let i = 148; i < 156; i++) h[i] = 0x20;
  h[156] = typeflag.charCodeAt(0);
  h.set(enc.encode(linkname).slice(0, 100), 157);
  h.set(enc.encode('ustar\0'), 257);
  h.set(enc.encode('00'), 263);
  h.set(enc.encode(e.uname).slice(0, 31), 265);
  h.set(enc.encode(e.gname).slice(0, 31), 297);
  if (prefix) h.set(enc.encode(prefix).slice(0, 155), 345);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  h.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);
  return h;
}

const padBlock = (d: Uint8Array) => {
  const r = d.length % BLOCK;
  if (r === 0) return d;
  const out = new Uint8Array(d.length + BLOCK - r);
  out.set(d);
  return out;
};

function encodeEntry(e: Entry): Uint8Array[] {
  const out: Uint8Array[] = [];
  const nameBytes = enc.encode(e.name);
  const fits = nameBytes.length <= 100 || (() => {
    for (let slash = e.name.indexOf('/'); slash >= 0; slash = e.name.indexOf('/', slash + 1)) {
      if (enc.encode(e.name.slice(0, slash)).length <= 155 && enc.encode(e.name.slice(slash + 1)).length <= 100 && slash + 1 < e.name.length) return true;
    }
    return false;
  })();
  if (!fits) {                                   // GNU long name: an 'L' entry whose data is the name
    const body = new Uint8Array(nameBytes.length + 1);
    body.set(nameBytes);
    out.push(headerBlock('././@LongLink', { ...e, mode: 0 }, 'L', body.length, ''), padBlock(body));
  }
  const flag = e.kind === 'dir' ? '5' : e.kind === 'symlink' ? '2' : e.kind === 'hardlink' ? '1' : '0';
  const size = e.kind === 'file' ? e.data.length : 0;
  out.push(headerBlock(fits ? e.name : e.name.slice(0, 100), e, flag, size, e.linkname));
  if (size) out.push(padBlock(e.data));
  return out;
}

const TRAILER = () => new Uint8Array(BLOCK * 2);

function field(b: Uint8Array, off: number, len: number): string {
  let end = off;
  while (end < off + len && b[end] !== 0) end++;
  return dec.decode(b.subarray(off, end));
}

function num(b: Uint8Array, off: number, len: number): number {
  if (b[off] & 0x80) {                           // GNU base-256
    let v = b[off] & 0x7f;
    for (let i = 1; i < len; i++) v = v * 256 + b[off + i];
    return v;
  }
  const s = field(b, off, len).trim();
  return s ? parseInt(s, 8) || 0 : 0;
}

class NotTar extends Error {}

function parseArchive(buf: Uint8Array): Entry[] {
  const entries: Entry[] = [];
  let pos = 0;
  let longName: string | null = null, longLink: string | null = null;
  let pax: Record<string, string> = {};
  while (pos + BLOCK <= buf.length) {
    const h = buf.subarray(pos, pos + BLOCK);
    if (h.every(x => x === 0)) break;
    // verify the checksum so that a non-archive is reported instead of parsed as garbage
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += (i >= 148 && i < 156) ? 0x20 : h[i];
    if (sum !== num(h, 148, 8)) throw new NotTar('This does not look like a tar archive');
    pos += BLOCK;
    const typeflag = String.fromCharCode(h[156] || 0x30);
    let size = num(h, 124, 12);
    const body = () => buf.subarray(pos, pos + size);
    const skip = () => { pos += Math.ceil(size / BLOCK) * BLOCK; };
    if (typeflag === 'L') { longName = field(body(), 0, size); skip(); continue; }
    if (typeflag === 'K') { longLink = field(body(), 0, size); skip(); continue; }
    if (typeflag === 'x' || typeflag === 'g') {
      if (typeflag === 'x') {
        const text = dec.decode(body());
        for (let i = 0; i < text.length;) {            // "<len> key=value\n" records
          const sp = text.indexOf(' ', i);
          const len = parseInt(text.slice(i, sp), 10);
          if (!(len > 0)) break;
          const rec = text.slice(sp + 1, i + len - 1);
          const eq = rec.indexOf('=');
          if (eq > 0) pax[rec.slice(0, eq)] = rec.slice(eq + 1);
          i += len;
        }
      }
      skip();
      continue;
    }
    const prefix = field(h, 345, 155);
    let name = pax.path ?? longName ?? ((prefix ? prefix + '/' : '') + field(h, 0, 100));
    const linkname = pax.linkpath ?? longLink ?? field(h, 157, 100);
    if (pax.size) size = parseInt(pax.size, 10);
    const kind: Entry['kind'] = typeflag === '5' || (typeflag === '0' && name.endsWith('/')) ? 'dir'
      : typeflag === '2' ? 'symlink' : typeflag === '1' ? 'hardlink'
      : (typeflag === '0' || typeflag === '7') ? 'file' : 'other';
    const data = kind === 'file' ? buf.slice(pos, pos + size) : new Uint8Array(0);
    entries.push({
      name, kind, mode: num(h, 100, 8), mtime: pax.mtime ? Math.floor(parseFloat(pax.mtime)) : num(h, 136, 12), size,
      uname: field(h, 265, 32), gname: field(h, 297, 32), linkname, data,
    });
    pos += Math.ceil((kind === 'file' ? size : 0) / BLOCK) * BLOCK;
    if (kind !== 'file' && size) pos += Math.ceil(size / BLOCK) * BLOCK;
    longName = longLink = null;
    pax = {};
  }
  return entries;
}

// ── patterns ─────────────────────────────────────────────────────────

function excluded(name: string, patterns: RegExp[]): boolean {
  if (patterns.length === 0) return false;
  const bare = name.replace(/\/+$/, '');
  const parts = bare.split('/');
  for (let i = 0; i < parts.length; i++) {
    const tail = parts.slice(i).join('/');
    if (patterns.some(p => p.test(tail))) return true;
  }
  return false;
}

// ── command ──────────────────────────────────────────────────────────

interface Opts {
  mode: '' | 'c' | 'x' | 't' | 'r';
  file: string | null;
  dir: string | null;
  verbose: boolean;
  codec: Codec;
  auto: boolean;
  excludes: string[];
  excludeFiles: string[];
  filesFrom: string[];
  strip: number;
  toStdout: boolean;
  keepOld: boolean;
  mtime: number | null;
  nullSep: boolean;
  operands: string[];
  /** how many --exclude patterns had been seen when each operand appeared (GNU: they apply to later operands only) */
  excludeAt: number[];
}

function parseOptions(args: string[]): Opts | string {
  const o: Opts = { mode: '', file: null, dir: null, verbose: false, codec: 'none', auto: false, excludes: [], excludeFiles: [], filesFrom: [], strip: 0, toStdout: false, keepOld: false, mtime: null, nullSep: false, operands: [], excludeAt: [] };
  const setMode = (m: Opts['mode']) => { if (o.mode && o.mode !== m) return false; o.mode = m; return true; };
  let list = args.slice();
  // old style: `tar czf a.tgz x` (letters without a dash)
  if (list.length && /^[A-Za-z]+$/.test(list[0]) && !list[0].startsWith('-')) list = ['-' + list[0], ...list.slice(1)];
  const takes = new Set(['f', 'C', 'X', 'T', 'I']);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--') { for (const x of list.slice(i + 1)) { o.operands.push(x); o.excludeAt.push(o.excludes.length); } break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      let val: string | undefined = eq > 0 ? a.slice(eq + 1) : undefined;
      const need = () => (val ??= list[++i]);
      let ok = true;
      switch (name) {
        case 'create': ok = setMode('c'); break;
        case 'extract': case 'get': ok = setMode('x'); break;
        case 'list': ok = setMode('t'); break;
        case 'append': ok = setMode('r'); break;
        case 'file': o.file = need() ?? null; break;
        case 'directory': o.dir = need() ?? null; break;
        case 'verbose': o.verbose = true; break;
        case 'gzip': case 'gunzip': case 'ungzip': o.codec = 'gzip'; break;
        case 'bzip2': o.codec = 'bzip2'; break;
        case 'xz': o.codec = 'xz'; break;
        case 'zstd': o.codec = 'zstd'; break;
        case 'auto-compress': o.auto = true; break;
        case 'exclude': o.excludes.push(need() ?? ''); break;
        case 'exclude-from': o.excludeFiles.push(need() ?? ''); break;
        case 'files-from': o.filesFrom.push(need() ?? ''); break;
        case 'strip-components': o.strip = parseInt(need() ?? '0', 10) || 0; break;
        case 'to-stdout': o.toStdout = true; break;
        case 'keep-old-files': o.keepOld = true; break;
        case 'null': o.nullSep = true; break;
        case 'mtime': { const v = need() ?? ''; const t = v.startsWith('@') ? Number(v.slice(1)) : Date.parse(v) / 1000; if (Number.isNaN(t)) return `tar: Substituting current time for invalid date '${v}'`; o.mtime = t; break; }
        case 'owner': case 'group': case 'sort': case 'format': case 'transform': case 'xform':
          if (name === 'transform' || name === 'xform') return `tar: --${name} is not supported`;
          need(); break;
        case 'wildcards': case 'no-wildcards': case 'anchored': case 'no-anchored': case 'numeric-owner': case 'no-same-owner': case 'same-owner':
        case 'preserve-permissions': case 'same-permissions': case 'no-same-permissions': case 'overwrite': case 'one-file-system': case 'dereference':
        case 'touch': case 'totals': case 'sparse': case 'no-recursion': case 'recursion': case 'atime-preserve': case 'warning': case 'blocking-factor': case 'use-compress-program':
          if (['warning', 'blocking-factor', 'use-compress-program'].includes(name) && val === undefined && name !== 'warning') need();
          break;
        default: return `tar: unrecognized option '--${name}'`;
      }
      if (!ok) return 'tar: You may not specify more than one \'-Acdtrux\', \'--delete\' or  \'--test-label\' option';
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const c = a[k];
        if (takes.has(c)) {
          const val = k + 1 < a.length ? a.slice(k + 1) : list[++i];
          if (val === undefined) return `tar: option requires an argument -- '${c}'`;
          if (c === 'f') o.file = val; else if (c === 'C') o.dir = val; else if (c === 'X') o.excludeFiles.push(val); else if (c === 'T') o.filesFrom.push(val);
          break;
        }
        let ok = true;
        switch (c) {
          case 'c': ok = setMode('c'); break;
          case 'x': ok = setMode('x'); break;
          case 't': ok = setMode('t'); break;
          case 'r': case 'u': ok = setMode('r'); break;
          case 'v': o.verbose = true; break;
          case 'z': o.codec = 'gzip'; break;
          case 'j': o.codec = 'bzip2'; break;
          case 'J': o.codec = 'xz'; break;
          case 'a': o.auto = true; break;
          case 'O': o.toStdout = true; break;
          case 'k': o.keepOld = true; break;
          case 'p': case 'P': case 'h': case 'm': case 'S': case 'w': case 'o': case 'l': break;
          default: return `tar: invalid option -- '${c}'`;
        }
        if (!ok) return 'tar: You may not specify more than one \'-Acdtrux\', \'--delete\' or  \'--test-label\' option';
      }
      continue;
    }
    o.operands.push(a);
    o.excludeAt.push(o.excludes.length);
  }
  return o;
}

export const tar: Command = {
  name: 'tar',
  description: 'Archive utility (ustar, gzip/bzip2/xz/zstd)',
  async exec(ctx: CommandContext) {
    const parsed = parseOptions(ctx.args);
    if (typeof parsed === 'string') { ctx.stderr += parsed + '\n'; return 2; }
    const o = parsed;
    if (!o.mode) { ctx.stderr += "tar: You must specify one of the '-Acdtrux', '--delete' or '--test-label' options\n"; return 2; }
    const fail = (m: string) => { ctx.stderr += `tar: ${m}\n`; return 2; };
    const work = o.dir ? ctx.fs.resolvePath(o.dir, ctx.cwd) : ctx.cwd;
    if (o.dir) {
      let isDir = false;
      try { isDir = (await ctx.fs.stat(work))?.type === 'dir'; } catch { /* absent */ }
      if (!isDir) return fail(`${o.dir}: Cannot open: No such file or directory`);
    }
    const stdio = o.file === '-' || o.file === null;
    const toStdout = stdio && o.mode === 'c';
    // names go to stdout, except while the archive itself is going there
    const say = (s: string) => { if (toStdout) ctx.stderr += s + '\n'; else ctx.stdout += s + '\n'; };
    let hadError = false;

    const readList = async (path: string): Promise<string[]> => {
      const text = path === '-' ? ctx.stdin : await ctx.fs.readFile(ctx.fs.resolvePath(path, ctx.cwd), 'utf8') as string;
      return text.split(o.nullSep ? '\0' : '\n').filter(Boolean);
    };

    try {
      const allExcludes = o.excludes.map(g => globToRegex(g));
      const fromFiles: RegExp[] = [];
      for (const f of o.excludeFiles) {
        try { for (const line of await readList(f)) fromFiles.push(globToRegex(line)); }
        catch { return fail(`${f}: Cannot open: No such file or directory`); }
      }
      let patterns = [...allExcludes, ...fromFiles];
      let operands = o.operands;
      for (const f of o.filesFrom) {
        try { operands = operands.concat(await readList(f)); } catch { return fail(`${f}: Cannot open: No such file or directory`); }
      }

      // ── create / append
      if (o.mode === 'c' || o.mode === 'r') {
        if (stdio && o.mode === 'r') return fail('Cannot update: archive is standard input');
        if (operands.length === 0) return fail('Cowardly refusing to create an empty archive');
        const blocks: Uint8Array[] = [];
        const archivePath = stdio ? '' : ctx.fs.resolvePath(o.file!, ctx.cwd);
        const walk = async (path: string, memberName: string) => {
          if (excluded(memberName, patterns)) return;
          const full = ctx.fs.resolvePath(path, work);
          let st;
          try { st = await statEntry(ctx.fs, full); }
          catch { ctx.stderr += `tar: ${memberName}: Cannot stat: No such file or directory\n`; hadError = true; return; }
          const base: Entry = {
            name: memberName, kind: 'file', mode: st.mode ? (st.mode & 0o7777) : 0o644,
            mtime: o.mtime ?? Math.floor((st.mtime || Date.now()) / 1000), size: st.size, uname: 'user', gname: 'user', linkname: '', data: new Uint8Array(0),
          };
          if (st.type === 'dir') {
            const name = memberName.endsWith('/') ? memberName : memberName + '/';
            blocks.push(...encodeEntry({ ...base, name, kind: 'dir', mode: st.mode ? (st.mode & 0o7777) : 0o755, size: 0 }));
            if (o.verbose) say(name);
            const items = await readdirEntries(ctx.fs, full);
            for (const item of items) await walk(full + '/' + item.name, name + item.name);
          } else if (st.type === 'symlink') {
            blocks.push(...encodeEntry({ ...base, kind: 'symlink', linkname: st.target ?? '', size: 0 }));
            if (o.verbose) say(memberName);
          } else {
            if (full === archivePath) { ctx.stderr += `tar: ${memberName}: file is the archive; not dumped\n`; return; }
            const raw = await ctx.fs.readFile(full);
            const data = typeof raw === 'string' ? textToBytes(raw) : raw;
            blocks.push(...encodeEntry({ ...base, data, size: data.length }));
            if (o.verbose) say(memberName);
          }
        };
        for (let k = 0; k < operands.length; k++) {
          const op = operands[k];
          const name = op.startsWith('/') ? op.replace(/^\/+/, '') : op;
          if (name !== op) ctx.stderr += `tar: Removing leading \`/' from member names\n`;
          // --exclude applies to the operands after it (files from -T count as last)
          const applies = k < o.excludeAt.length ? o.excludeAt[k] : allExcludes.length;
          patterns = [...allExcludes.slice(0, applies), ...fromFiles];
          await walk(op, name || '.');
        }
        let body = blocks;
        let archive: Uint8Array;
        let codec: Codec = o.codec;
        if (codec === 'none' && o.auto && !stdio) codec = codecForName(o.file!);
        if (o.mode === 'r') {
          let existing: Uint8Array;
          try { const raw = await ctx.fs.readFile(archivePath); existing = typeof raw === 'string' ? textToBytes(raw) : raw; }
          catch { return fail(`${o.file}: Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now`); }
          if (detectCodec(existing) !== 'none') return fail('Cannot update compressed archives');
          let end = existing.length;
          while (end >= BLOCK && existing.subarray(end - BLOCK, end).every(x => x === 0)) end -= BLOCK;
          body = [existing.subarray(0, end), ...blocks];
        }
        const total = body.reduce((s, b) => s + b.length, 0) + BLOCK * 2;
        archive = new Uint8Array(total);
        let off = 0;
        for (const b of body) { archive.set(b, off); off += b.length; }
        archive.set(TRAILER(), off);
        archive = await compress(codec, archive,ctx);
        if (stdio) ctx.stdout += bytesToText(archive);
        else await ctx.fs.writeFile(archivePath, archive);
        return hadError ? (ctx.stderr += 'tar: Exiting with failure status due to previous errors\n', 2) : 0;
      }

      // ── list / extract
      let raw: Uint8Array;
      if (stdio) raw = textToBytes(ctx.stdin);
      else {
        try { const r = await ctx.fs.readFile(ctx.fs.resolvePath(o.file!, ctx.cwd)); raw = typeof r === 'string' ? textToBytes(r) : r; }
        catch { return fail(`${o.file}: Cannot open: No such file or directory\ntar: Error is not recoverable: exiting now`); }
      }
      if (typeof raw !== 'object') return fail('invalid archive');
      if (raw.length === 0) return 0;
      let data: Uint8Array;
      try { data = await decompress(detectCodec(raw), raw,ctx); }
      catch (e: any) { return fail(`${e?.message ?? e}`); }
      const head = dec.decode(data.subarray(0, 13));
      if (head === 'FLUFFY-TAR-V1') {
        const text = dec.decode(data);
        return o.mode === 'x' ? await extractOldFormat(text, ctx, work, o.verbose) : listOldFormat(text, ctx);
      }
      let entries: Entry[];
      try { entries = parseArchive(data); }
      catch (e: any) { return fail(e instanceof NotTar ? e.message : `Unexpected EOF in archive`); }
      if (entries.length === 0 && data.length > 0 && !data.subarray(0, BLOCK).every(x => x === 0)) return fail('This does not look like a tar archive');

      const wanted = operands.map(op => op.replace(/\/+$/, ''));
      const matches = (name: string) => {
        if (wanted.length === 0) return true;
        const bare = name.replace(/\/+$/, '');
        return wanted.some(w => bare === w || bare.startsWith(w + '/'));
      };
      const seen = new Set<string>();
      for (const e of entries) {
        if (!matches(e.name) || excluded(e.name, patterns)) continue;
        seen.add(wanted.find(w => e.name.replace(/\/+$/, '') === w || e.name.startsWith(w + '/')) ?? '');
        if (o.mode === 't') {
          if (o.verbose) {
            const perm = (e.kind === 'dir' ? 'd' : e.kind === 'symlink' ? 'l' : e.kind === 'hardlink' ? 'h' : '-') +
              [6, 3, 0].map(sh => ((e.mode >> sh) & 4 ? 'r' : '-') + ((e.mode >> sh) & 2 ? 'w' : '-') + ((e.mode >> sh) & 1 ? 'x' : '-')).join('');
            const d = new Date(e.mtime * 1000);
            const date = d.toISOString().slice(0, 16).replace('T', ' ');
            const link = e.kind === 'symlink' ? ` -> ${e.linkname}` : e.kind === 'hardlink' ? ` link to ${e.linkname}` : '';
            ctx.stdout += `${perm} ${e.uname || '0'}/${e.gname || '0'} ${String(e.size).padStart(8)} ${date} ${e.name}${link}\n`;
          } else ctx.stdout += e.name + '\n';
          continue;
        }
        // extract
        let name = e.name;
        if (o.strip > 0) {
          const parts = name.replace(/\/+$/, '').split('/');
          if (parts.length <= o.strip) continue;
          name = parts.slice(o.strip).join('/') + (e.kind === 'dir' ? '/' : '');
        }
        name = name.replace(/^\/+/, '');
        if (name.split('/').includes('..')) { ctx.stderr += `tar: ${e.name}: Member name contains '..'\n`; hadError = true; continue; }
        if (o.toStdout) {
          if (e.kind === 'file') ctx.stdout += bytesToText(e.data);
          continue;
        }
        const target = ctx.fs.resolvePath(name, work);
        if (o.verbose) ctx.stdout += e.name + '\n';
        try {
          if (e.kind === 'dir') await ctx.fs.mkdir(target, { recursive: true });
          else {
            const slash = target.lastIndexOf('/');
            if (slash > 0) { try { await ctx.fs.mkdir(target.slice(0, slash), { recursive: true }); } catch { /* exists */ } }
            if (o.keepOld) { let exists = false; try { exists = !!(await ctx.fs.stat(target)); } catch { /* absent */ } if (exists) { ctx.stderr += `tar: ${name}: Cannot open: File exists\n`; hadError = true; continue; } }
            if (e.kind === 'symlink') {
              try { await ctx.fs.unlink(target); } catch { /* absent */ }
              await ctx.fs.symlink(e.linkname, target);
            } else if (e.kind === 'hardlink') {
              const src = ctx.fs.resolvePath(e.linkname.replace(/^\/+/, ''), work);
              await ctx.fs.writeFile(target, await ctx.fs.readFile(src));
            } else if (e.kind === 'file') {
              await ctx.fs.writeFile(target, e.data);
              try { await ctx.fs.chmod(target, e.mode & 0o7777); } catch { /* no modes here */ }
            }
          }
        } catch (err: any) {
          ctx.stderr += `tar: ${name}: Cannot extract: ${err?.message ?? err}\n`;
          hadError = true;
        }
      }
      for (const w of wanted) {
        if (!entries.some(e => e.name.replace(/\/+$/, '') === w || e.name.startsWith(w + '/'))) {
          ctx.stderr += `tar: ${w}: Not found in archive\n`;
          hadError = true;
        }
      }
      if (hadError) { ctx.stderr += 'tar: Exiting with failure status due to previous errors\n'; return 2; }
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `tar: ${e instanceof Error ? e.message : e}\n`;
      return 2;
    }
  },
};

// Backward compatibility: old FLUFFY-TAR-V1 format
async function extractOldFormat(content: string, ctx: any, workingDir: string, verbose: boolean): Promise<number> {
  const lines = content.split('\n');
  let i = 1;
  const extracted: string[] = [];
  while (i < lines.length) {
    if (!lines[i].startsWith('FILE:')) break;
    const filePath = lines[i].slice(5);
    const type = lines[i + 2].slice(5);
    i += 4; // Skip FILE:, SIZE:, TYPE:, DATA-START
    const contentLines: string[] = [];
    while (i < lines.length && lines[i] !== 'DATA-END') {
      contentLines.push(lines[i]);
      i++;
    }
    const fileContent = contentLines.join('\n');
    i++; // Skip DATA-END
    const targetPath = ctx.fs.resolvePath(filePath, workingDir);
    if (type === 'dir') {
      await ctx.fs.mkdir(targetPath, { recursive: true });
    } else {
      const lastSlash = targetPath.lastIndexOf('/');
      if (lastSlash > 0) {
        try { await ctx.fs.mkdir(targetPath.slice(0, lastSlash), { recursive: true }); } catch {}
      }
      await ctx.fs.writeFile(targetPath, fileContent);
    }
    extracted.push(filePath);
  }
  if (verbose) ctx.stdout += extracted.join('\n') + '\n';
  return 0;
}

function listOldFormat(content: string, ctx: any): number {
  const lines = content.split('\n');
  const fileList: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith('FILE:')) fileList.push(lines[i].slice(5));
  }
  ctx.stdout += fileList.join('\n') + '\n';
  return 0;
}
