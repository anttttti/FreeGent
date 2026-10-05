import { transformBytes } from '../utils/streams';
/**
 * zip / unzip — Info-ZIP compatible archives: stored and deflated entries, central directory,
 * CRC-32 checks, Unix modes, binary-safe contents. No encryption and no ZIP64 (4 GiB limits).
 *
 * zip:   -r -j -q -0..-9 -m -u -f -d -x PAT... -i PAT... -X -D -@ -z (archive "-" is stdout)
 * unzip: -l -v -Z -Z1 -p -c -t -q -qq -o -n -j -d DIR -x PAT... [members]
 */
import type { Command, CommandContext } from './index';
import { crc32 } from './checksums';
import { bytesToText, textToBytes } from '../utils/bytes';
import { readdirEntries, statEntry } from './flags';

const enc = new TextEncoder();
const dec = new TextDecoder();

const deflateRaw = (d: Uint8Array) => transformBytes(new CompressionStream('deflate-raw') as any, d);
const inflateRaw = (d: Uint8Array) => transformBytes(new DecompressionStream('deflate-raw') as any, d);

interface Entry {
  name: string;
  method: number;          // 0 stored, 8 deflated
  crc: number;
  csize: number;
  usize: number;
  time: number;            // DOS
  date: number;
  extAttr: number;         // external attributes: Unix mode in the high 16 bits
  data: Uint8Array;        // the stored / deflated bytes
  isDir: boolean;
}

function dosStamp(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  const y = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
const dosString = (e: Entry) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${1980 + (e.date >> 9)}-${p((e.date >> 5) & 15)}-${p(e.date & 31)} ${p(e.time >> 11)}:${p((e.time >> 5) & 63)}`;
};

// ── reading and writing archives ─────────────────────────────────────

function readArchive(buf: Uint8Array): Entry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('End-of-central-directory signature not found');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: Entry[] = [];
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad central directory');
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
    const time = dv.getUint16(p + 12, true), date = dv.getUint16(p + 14, true);
    const crc = dv.getUint32(p + 16, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const extAttr = dv.getUint32(p + 38, true), local = dv.getUint32(p + 42, true);
    const name = (flags & 0x800 ? dec : new TextDecoder('utf-8')).decode(buf.subarray(p + 46, p + 46 + nl));
    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error('bad local header');
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    out.push({ name, method, crc, csize, usize, time, date, extAttr, data: buf.subarray(start, start + csize), isDir: name.endsWith('/') });
    p += 46 + nl + xl + cl;
  }
  return out;
}

function writeArchive(entries: Entry[], comment = ''): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const utf8 = /[^\x00-\x7f]/.test(e.name) ? 0x800 : 0;
    const lh = new Uint8Array(30 + name.length);
    const l = new DataView(lh.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, e.method === 0 && e.isDir ? 10 : 20, true); l.setUint16(6, utf8, true);
    l.setUint16(8, e.method, true); l.setUint16(10, e.time, true); l.setUint16(12, e.date, true);
    l.setUint32(14, e.crc, true); l.setUint32(18, e.csize, true); l.setUint32(22, e.usize, true); l.setUint16(26, name.length, true);
    lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length);
    const c = new DataView(ch.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 0x031e, true); c.setUint16(6, e.method === 0 && e.isDir ? 10 : 20, true); c.setUint16(8, utf8, true);
    c.setUint16(10, e.method, true); c.setUint16(12, e.time, true); c.setUint16(14, e.date, true);
    c.setUint32(16, e.crc, true); c.setUint32(20, e.csize, true); c.setUint32(24, e.usize, true); c.setUint16(28, name.length, true);
    c.setUint32(38, e.extAttr, true); c.setUint32(42, offset, true);
    ch.set(name, 46);
    parts.push(lh, e.data);
    central.push(ch);
    offset += lh.length + e.data.length;
  }
  const cd = central.reduce((n, x) => n + x.length, 0);
  const cm = enc.encode(comment);
  const end = new Uint8Array(22 + cm.length);
  const v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true); v.setUint16(8, entries.length, true); v.setUint16(10, entries.length, true);
  v.setUint32(12, cd, true); v.setUint32(16, offset, true); v.setUint16(20, cm.length, true);
  end.set(cm, 22);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of all) { out.set(x, o); o += x.length; }
  return out;
}

async function entryData(e: Entry): Promise<Uint8Array> {
  if (e.method === 0) return e.data;
  if (e.method === 8) return inflateRaw(e.data);
  throw new Error(`unsupported compression method ${e.method}`);
}

function globToRegex(g: string, slashSpecial = false): RegExp {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*') re += slashSpecial ? '[^/]*' : '.*';
    else if (ch === '?') re += slashSpecial ? '[^/]' : '.';
    else if (ch === '[') { const close = g.indexOf(']', i + 2); if (close > 0) { re += '[' + g.slice(i + 1, close).replace(/^!/, '^') + ']'; i = close; } else re += '\\['; }
    else re += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

async function readFileBytes(ctx: CommandContext, path: string): Promise<Uint8Array> {
  const raw = await ctx.fs.readFile(path);
  return typeof raw === 'string' ? textToBytes(raw) : raw;
}

// ── zip ──────────────────────────────────────────────────────────────

export const zipCmd: Command = {
  name: 'zip',
  description: 'Create and update ZIP archives',
  async exec(ctx) {
    const a = ctx.args;
    let recurse = false, junk = false, quiet = false, move = false, update = false, freshen = false, del = false, noDirs = false, level = 6, namesFromStdin = false;
    let comment = '';
    const excludes: RegExp[] = [], includes: RegExp[] = [];
    const operands: string[] = [];
    const bad = (m: string) => { ctx.stderr += `zip error: ${m}\n`; return 16; };
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x === '--') { operands.push(...a.slice(i + 1)); break; }
      if (x === '-x' || x === '-i' || x === '--exclude' || x === '--include') {
        const list = x === '-x' || x === '--exclude' ? excludes : includes;
        while (i + 1 < a.length && !a[i + 1].startsWith('-')) list.push(globToRegex(a[++i]));
        continue;
      }
      if (x === '-z') { comment = ctx.stdin.replace(/\n+$/, ''); continue; }
      if (x === '-@') { namesFromStdin = true; continue; }
      if (x.startsWith('--')) {
        switch (x) {
          case '--recurse-paths': recurse = true; break;
          case '--junk-paths': junk = true; break;
          case '--quiet': quiet = true; break;
          case '--move': move = true; break;
          case '--update': update = true; break;
          case '--freshen': freshen = true; break;
          case '--delete': del = true; break;
          case '--no-dir-entries': noDirs = true; break;
          case '--no-extra': break;
          default: return bad(`unknown option ${x}`);
        }
        continue;
      }
      if (x.startsWith('-') && x.length > 1) {
        for (const c of x.slice(1)) {
          if (c === 'r') recurse = true; else if (c === 'j') junk = true; else if (c === 'q') quiet = true; else if (c === 'm') move = true;
          else if (c === 'u') update = true; else if (c === 'f') freshen = true; else if (c === 'd') del = true; else if (c === 'D') noDirs = true;
          else if (c === 'X' || c === 'y' || c === 'g' || c === 'S' || c === 'T' || c === 'v') { /* accepted */ }
          else if (/\d/.test(c)) level = parseInt(c, 10);
          else return bad(`Invalid command arguments (short option '${c}' not supported)`);
        }
        continue;
      }
      operands.push(x);
    }
    if (operands.length === 0) { ctx.stderr += 'zip error: Nothing to do! (zip)\n'.replace('(zip)', '(zip.zip)'); return 12; }
    let archiveName = operands[0];
    const toStdout = archiveName === '-';
    if (!toStdout && !/\.[^/]+$/.test(archiveName.split('/').pop()!)) archiveName += '.zip';
    const archivePath = ctx.fs.resolvePath(archiveName, ctx.cwd);
    let names = operands.slice(1);
    if (namesFromStdin) names = names.concat(ctx.stdin.split('\n').filter(Boolean));
    const say = (s: string) => { if (!quiet) ctx.stdout += s + '\n'; };

    let entries: Entry[] = [];
    let existed = false;
    if (!toStdout) {
      try { entries = readArchive(await readFileBytes(ctx, archivePath)); existed = true; } catch (e: any) {
        if (!/ENOENT|no such file|not found/i.test(String(e?.message)) && existed) return bad(e.message);
      }
    }
    const matchesAny = (list: RegExp[], n: string) => list.some(r => r.test(n));

    if (del) {                                              // zip -d ARCHIVE PATTERN...
      if (!existed) { ctx.stderr += `\nzip error: Zip file structure invalid (${archiveName})\n`; return 3; }
      const pats = names.map(n => globToRegex(n));
      const keep = entries.filter(e => !pats.some(p => p.test(e.name)) );
      if (keep.length === entries.length) { ctx.stderr += `\nzip error: Nothing to do! (${archiveName})\n`; return 12; }
      for (const e of entries) if (!keep.includes(e)) say(`deleting: ${e.name}`);
      if (keep.length === 0) await ctx.fs.unlink(archivePath);
      else await ctx.fs.writeFile(archivePath, writeArchive(keep));
      return 0;
    }

    const added: { name: string; path: string; isDir: boolean }[] = [];
    const collect = async (path: string, shown: string, top: boolean) => {
      const full = ctx.fs.resolvePath(path, ctx.cwd);
      let st;
      try { st = await statEntry(ctx.fs, full); }
      catch { if (top) ctx.stderr += `\tzip warning: name not matched: ${shown}\n`; return; }
      let member = shown.replace(/^\/+/, '').replace(/^(\.\/)+/, '');
      if (junk) member = member.replace(/\/+$/, '').split('/').pop()!;
      if (st.type === 'dir') {
        if (!recurse && top) {
          if (!noDirs && !junk) added.push({ name: member.replace(/\/*$/, '/'), path: full, isDir: true });
          return;
        }
        if (!noDirs && !junk && member) added.push({ name: member.replace(/\/*$/, '/'), path: full, isDir: true });
        for (const item of await readdirEntries(ctx.fs, full)) await collect(full + '/' + item.name, (shown.replace(/\/+$/, '') + '/' + item.name), false);
      } else added.push({ name: member, path: full, isDir: false });
    };
    for (const n of names) await collect(n, n, true);
    let todo = added.filter(f => !matchesAny(excludes, f.name) && (includes.length === 0 || matchesAny(includes, f.name)));
    if (todo.length === 0 && !existed) { ctx.stderr += `\nzip error: Nothing to do! (${archiveName})\n`; return 12; }

    let changed = false;
    for (const f of todo) {
      const idx = entries.findIndex(e => e.name === f.name);
      let st;
      try { st = await statEntry(ctx.fs, f.path); } catch { continue; }
      const stamp = dosStamp(st.mtime || Date.now());
      if (idx >= 0 && (update || freshen)) {                // only newer files replace entries
        const old = entries[idx];
        if ((old.date << 16 | old.time) >= (stamp.date << 16 | stamp.time) && !f.isDir) continue;
      }
      if (idx < 0 && freshen) continue;
      let entry: Entry;
      if (f.isDir) {
        entry = { name: f.name, method: 0, crc: 0, csize: 0, usize: 0, ...stamp, extAttr: (((st.mode ?? 0o755) & 0o7777 | 0o040000) << 16 | 0x10) >>> 0, data: new Uint8Array(0), isDir: true };
        say(`${idx >= 0 ? 'updating' : '  adding'}: ${f.name} (stored 0%)`);
      } else {
        const data = await readFileBytes(ctx, f.path);
        let method = 0, packed = data;
        if (level > 0 && data.length > 0) {
          const d = await deflateRaw(data);
          if (d.length < data.length) { method = 8; packed = d; }
        }
        entry = { name: f.name, method, crc: crc32(data), csize: packed.length, usize: data.length, ...stamp, extAttr: (((st.mode ?? 0o644) & 0o7777 | 0o100000) << 16) >>> 0, data: packed, isDir: false };
        const pct = data.length ? Math.round((1 - packed.length / data.length) * 100) : 0;
        say(`${idx >= 0 ? 'updating' : '  adding'}: ${f.name} (${method === 8 ? 'deflated' : 'stored'} ${method === 8 ? pct : 0}%)`);
      }
      if (idx >= 0) entries[idx] = entry; else entries.push(entry);
      changed = true;
    }
    if (!changed) {
      if (todo.length === 0 || update || freshen) { ctx.stderr += `\nzip error: Nothing to do! (${archiveName})\n`; return 12; }
    }
    const bytes = writeArchive(entries, comment);
    if (toStdout) ctx.stdout += bytesToText(bytes);
    else await ctx.fs.writeFile(archivePath, bytes);
    if (move) {
      for (const f of todo.filter(x => !x.isDir)) { try { await ctx.fs.unlink(f.path); } catch { /* gone */ } }
      for (const f of todo.filter(x => x.isDir).reverse()) { try { await ctx.fs.rmdir(f.path); } catch { /* not empty */ } }
    }
    return 0;
  },
};

// ── unzip ────────────────────────────────────────────────────────────

export const unzipCmd: Command = {
  name: 'unzip',
  description: 'List, test and extract ZIP archives',
  async exec(ctx) {
    const a = ctx.args;
    let list = false, verbose = false, zipinfo = false, names1 = false, pipe = false, test = false, quiet = 0, overwrite = false, never = false, junk = false;
    let dir: string | null = null;
    const operands: string[] = [];
    const excludes: RegExp[] = [];
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x === '--') { operands.push(...a.slice(i + 1)); break; }
      if (x === '-d') { dir = a[++i] ?? null; continue; }
      if (x.startsWith('-d') && x.length > 2) { dir = x.slice(2); continue; }
      if (x === '-x') { while (i + 1 < a.length && !a[i + 1].startsWith('-')) excludes.push(globToRegex(a[++i])); continue; }
      if (x === '-Z') { zipinfo = true; continue; }
      if (x === '-Z1') { zipinfo = true; names1 = true; continue; }
      if (x.startsWith('-') && x.length > 1) {
        for (const c of x.slice(1)) {
          if (c === 'l') list = true; else if (c === 'v') verbose = true; else if (c === 'p' || c === 'c') pipe = true; else if (c === 't') test = true;
          else if (c === 'q') quiet++; else if (c === 'o') overwrite = true; else if (c === 'n') never = true; else if (c === 'j') junk = true;
          else if (c === 'a' || c === 'b' || c === 'C' || c === 'D' || c === 'f' || c === 'u' || c === 'X' || c === 'K' || c === 'L' || c === 'M' || c === 'T' || c === 'V' || c === 'Z' || c === '1') { /* accepted */ }
          else { ctx.stderr += `unzip:  invalid option -${c}\n`; return 10; }
        }
        continue;
      }
      operands.push(x);
    }
    if (operands.length === 0) { ctx.stderr += 'UnZip: no archive given\n'; return 10; }
    const archiveArg = operands[0];
    let bytes: Uint8Array | null = null;
    for (const cand of [archiveArg, archiveArg + '.zip', archiveArg + '.ZIP']) {
      try { bytes = await readFileBytes(ctx, ctx.fs.resolvePath(cand, ctx.cwd)); break; } catch { /* try the next */ }
    }
    if (!bytes) { ctx.stderr += `unzip:  cannot find or open ${archiveArg}, ${archiveArg}.zip or ${archiveArg}.ZIP.\n`; return 9; }
    let entries: Entry[];
    try { entries = readArchive(bytes); }
    catch { ctx.stderr += `  End-of-central-directory signature not found.  Either this file is not\n  a zipfile, or it constitutes one disk of a multi-part archive.\n`; return 9; }

    const patterns = operands.slice(1).map(p => globToRegex(p));
    const chosen = entries.filter(e => (patterns.length === 0 || patterns.some(p => p.test(e.name))) && !excludes.some(p => p.test(e.name)));
    let status = 0;
    for (const p of operands.slice(1)) {
      if (!entries.some(e => globToRegex(p).test(e.name))) { ctx.stderr += `caution: filename not matched:  ${p}\n`; status = 11; }
    }
    if (patterns.length && chosen.length === 0) return 11;

    if (zipinfo) {
      if (names1) { for (const e of chosen) ctx.stdout += e.name + '\n'; return 0; }
      const total = chosen.reduce((n, e) => n + e.usize, 0);
      ctx.stdout += `Archive:  ${archiveArg}\nZip file size: ${bytes.length} bytes, number of entries: ${entries.length}\n`;
      for (const e of chosen) {
        const mode = (e.extAttr >>> 16) & 0o7777, dirbit = e.isDir ? 'd' : '-';
        const perm = [6, 3, 0].map(s => ((mode >> s) & 4 ? 'r' : '-') + ((mode >> s) & 2 ? 'w' : '-') + ((mode >> s) & 1 ? 'x' : '-')).join('');
        ctx.stdout += `${dirbit}${perm} 3.0 unx ${String(e.usize).padStart(8)} ${e.method === 8 ? 'defN' : 'stor'}  ${dosString(e)} ${e.name}\n`;
      }
      ctx.stdout += `${chosen.length} files, ${total} bytes uncompressed, ${chosen.reduce((n, e) => n + e.csize, 0)} bytes compressed\n`;
      return 0;
    }
    if (list || verbose) {
      ctx.stdout += `Archive:  ${archiveArg}\n`;
      if (verbose) {
        ctx.stdout += ` Length   Method    Size  Cmpr    Date    Time   CRC-32   Name\n--------  ------  ------- ---- ---------- ----- --------  ----\n`;
        let u = 0, c = 0;
        for (const e of chosen) {
          const pct = e.usize ? Math.round((1 - e.csize / e.usize) * 100) : 0;
          ctx.stdout += `${String(e.usize).padStart(8)}  ${(e.method === 8 ? 'Defl:N' : 'Stored').padEnd(6)} ${String(e.csize).padStart(8)} ${String(pct + '%').padStart(3)} ${dosString(e)} ${e.crc.toString(16).padStart(8, '0')}  ${e.name}\n`;
          u += e.usize; c += e.csize;
        }
        const pct = u ? Math.round((1 - c / u) * 100) : 0;
        ctx.stdout += `--------          -------  ---                            -------\n${String(u).padStart(8)}         ${String(c).padStart(8)} ${String(pct + '%').padStart(3)}                            ${chosen.length} file${chosen.length === 1 ? '' : 's'}\n`;
      } else {
        ctx.stdout += `  Length      Date    Time    Name\n---------  ---------- -----   ----\n`;
        let u = 0;
        for (const e of chosen) { ctx.stdout += `${String(e.usize).padStart(9)}  ${dosString(e)}   ${e.name}\n`; u += e.usize; }
        ctx.stdout += `---------                     -------\n${String(u).padStart(9)}                     ${chosen.length} file${chosen.length === 1 ? '' : 's'}\n`;
      }
      return status;
    }
    if (test) {
      if (quiet < 2) ctx.stdout += `Archive:  ${archiveArg}\n`;
      let bad = 0;
      for (const e of chosen) {
        let ok = true;
        if (!e.isDir) { try { ok = crc32(await entryData(e)) === e.crc; } catch { ok = false; } }
        if (!ok) bad++;
        if (!quiet) ctx.stdout += `    testing: ${e.name.padEnd(22)} ${ok ? 'OK' : 'FAILED'}\n`;
      }
      ctx.stdout += bad ? `At least one error was detected in ${archiveArg}.\n` : `No errors detected in compressed data of ${archiveArg}.\n`;
      return bad ? 2 : status;
    }
    if (pipe) {
      for (const e of chosen) if (!e.isDir) ctx.stdout += bytesToText(await entryData(e));
      return status;
    }

    // extract
    const base = dir ? ctx.fs.resolvePath(dir, ctx.cwd) : ctx.cwd;
    if (quiet < 2) { if (!quiet) ctx.stdout += `Archive:  ${archiveArg}\n`; }
    if (dir) { try { await ctx.fs.mkdir(base, { recursive: true }); } catch { /* exists */ } }
    for (const e of chosen) {
      let rel = e.name;
      if (junk) rel = rel.replace(/\/+$/, '').split('/').pop()! + (e.isDir ? '/' : '');
      if (junk && e.isDir) continue;
      if (rel.split('/').includes('..')) { ctx.stderr += `warning:  skipped "../" path component(s) in ${e.name}\n`; rel = rel.split('/').filter(p => p !== '..').join('/'); }
      const shown = (dir ? dir.replace(/\/+$/, '') + '/' : '') + rel;
      const target = ctx.fs.resolvePath(rel, base);
      try {
        if (e.isDir) {
          await ctx.fs.mkdir(target, { recursive: true });
          if (!quiet) ctx.stdout += `   creating: ${shown}\n`;
          continue;
        }
        let exists = false;
        try { exists = !!(await ctx.fs.stat(target)); } catch { /* new */ }
        if (exists && never) continue;
        if (exists && !overwrite) {
          ctx.stdout += `replace ${shown}? [y]es, [n]o, [A]ll, [N]one, [r]ename:  NULL\n(EOF or read error, treating as "[N]one" ...)\n`;
          status = Math.max(status, 1);
          continue;
        }
        const slash = target.lastIndexOf('/');
        if (slash > 0) { try { await ctx.fs.mkdir(target.slice(0, slash), { recursive: true }); } catch { /* exists */ } }
        const data = await entryData(e);
        if (crc32(data) !== e.crc) { ctx.stderr += `${shown}  bad CRC ${crc32(data).toString(16).padStart(8, '0')}  (should be ${e.crc.toString(16).padStart(8, '0')})\n`; status = Math.max(status, 2); }
        await ctx.fs.writeFile(target, data);
        const mode = (e.extAttr >>> 16) & 0o7777;
        if (mode) { try { await ctx.fs.chmod(target, mode); } catch { /* no modes here */ } }
        if (!quiet) ctx.stdout += `${e.method === 8 ? '  inflating' : ' extracting'}: ${shown}\n`;
      } catch (err: any) {
        ctx.stderr += `error:  cannot create ${shown}: ${err?.message ?? err}\n`;
        status = Math.max(status, 2);
      }
    }
    return status;
  },
};
