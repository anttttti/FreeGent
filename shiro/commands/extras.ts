/**
 * Small commands scripts expect to find: egrep, fgrep, zcat, truncate, uuidgen, sync.
 */
import type { Command } from './index';
import { runSubcommand } from './run-subcommand';
import { textToBytes } from '../utils/bytes';

function viaShell(name: string, description: string, argv: (args: string[]) => string[]): Command {
  return {
    name, description,
    async exec(ctx) {
      let out = '', err = '';
      const code = await runSubcommand(ctx, argv(ctx.args), s => { out += s; }, s => { err += s; });
      ctx.stdout += out;
      ctx.stderr += err;
      return code;
    },
  };
}

export const egrepCmd = viaShell('egrep', 'grep -E', a => ['grep', '-E', ...a]);
export const fgrepCmd = viaShell('fgrep', 'grep -F', a => ['grep', '-F', ...a]);
export const zcatCmd = viaShell('zcat', 'gzip -dc', a => ['gzip', '-dc', ...a]);

export const truncateCmd: Command = {
  name: 'truncate',
  description: 'Shrink or extend the size of files',
  async exec(ctx) {
    let size: string | null = null, noCreate = false;
    const files: string[] = [];
    const a = ctx.args;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x === '-s' || x === '--size') size = a[++i] ?? null;
      else if (x.startsWith('--size=')) size = x.slice(7);
      else if (x.startsWith('-s') && x.length > 2) size = x.slice(2);
      else if (x === '-c' || x === '--no-create') noCreate = true;
      else if (x.startsWith('-') && x.length > 1) { ctx.stderr += `truncate: invalid option -- '${x.replace(/^-+/, '')}'\n`; return 1; }
      else files.push(x);
    }
    if (size === null) { ctx.stderr += "truncate: you must specify either '--size' or '--reference'\n"; return 1; }
    if (files.length === 0) { ctx.stderr += 'truncate: missing file operand\n'; return 1; }
    const m = /^([+\-<>/%]?)(\d+)([KMGTPE]?)(B?)$/i.exec(size);
    if (!m) { ctx.stderr += `truncate: Invalid number: '${size}'\n`; return 1; }
    const unit = m[3] ? (m[4] ? 1000 : 1024) ** ('KMGTPE'.indexOf(m[3].toUpperCase()) + 1) : 1;
    const n = parseInt(m[2], 10) * unit;
    let status = 0;
    for (const f of files) {
      const path = ctx.fs.resolvePath(f, ctx.cwd);
      let cur: Uint8Array = new Uint8Array(0);
      let exists = true;
      try { const raw = await ctx.fs.readFile(path); cur = typeof raw === 'string' ? textToBytes(raw) : raw; }
      catch { exists = false; }
      if (!exists && noCreate) continue;
      let target = n;
      switch (m[1]) {
        case '+': target = cur.length + n; break;
        case '-': target = Math.max(0, cur.length - n); break;
        case '<': target = Math.min(cur.length, n); break;
        case '>': target = Math.max(cur.length, n); break;
        case '/': target = n ? Math.floor(cur.length / n) * n : cur.length; break;
        case '%': target = n ? Math.ceil(cur.length / n) * n : cur.length; break;
      }
      if (target > 1 << 30) { ctx.stderr += `truncate: failed to truncate '${f}' at ${target} bytes: File too large\n`; status = 1; continue; }
      const next = new Uint8Array(target);
      next.set(cur.subarray(0, Math.min(cur.length, target)));
      try { await ctx.fs.writeFile(path, next); }
      catch (e: any) { ctx.stderr += `truncate: cannot open '${f}' for writing: ${e.message}\n`; status = 1; }
    }
    return status;
  },
};

export const uuidgenCmd: Command = {
  name: 'uuidgen',
  description: 'Create a new UUID value',
  async exec(ctx) {
    const a = ctx.args;
    let uuid: string = crypto.randomUUID();
    if (a.includes('-t') || a.includes('--time')) {
      // time-based (version 1): 100 ns intervals since 1582-10-15, random node with the multicast bit set
      const t = BigInt(Date.now()) * 10000n + 122192928000000000n;
      const hex = (v: bigint, w: number) => v.toString(16).padStart(w, '0');
      const node = crypto.getRandomValues(new Uint8Array(6)); node[0] |= 1;
      uuid = `${hex(t & 0xffffffffn, 8)}-${hex((t >> 32n) & 0xffffn, 4)}-1${hex((t >> 48n) & 0xfffn, 3)}-${hex(BigInt(0x8000 | (crypto.getRandomValues(new Uint16Array(1))[0] & 0x3fff)), 4)}-${[...node].map(b => hex(BigInt(b), 2)).join('')}`;
    }
    if (a.includes('-x') || a.includes('--hex')) uuid = uuid.replace(/-/g, '');
    ctx.stdout += (a.includes('-U') || a.includes('--upper') ? uuid.toUpperCase() : uuid) + '\n';
    return 0;
  },
};

export const syncCmd: Command = {
  name: 'sync',
  description: 'Flush file system buffers (nothing to flush here)',
  async exec() { return 0; },
};
