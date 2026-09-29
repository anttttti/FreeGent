import type { Command, CommandContext } from './index';

// GNU sum: BSD checksum (default, -r: "%05d %5d" with 1K blocks, the name only when there are
// several files) or System V (-s: "%d %d NAME" with 512-byte blocks).
async function bytesOf(ctx: CommandContext, f: string): Promise<Uint8Array> {
  if (f === '-') return new TextEncoder().encode(ctx.stdin);
  const c = await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd));
  return typeof c === 'string' ? new TextEncoder().encode(c) : c;
}

export const sum: Command = {
  name: 'sum',
  description: 'Checksum and count the blocks in a file',
  async exec(ctx) {
    let sysv = false;
    const files: string[] = [];
    for (const a of ctx.args) {
      if (a === '-s' || a === '--sysv') sysv = true;
      else if (a === '-r') sysv = false;
      else files.push(a);
    }
    if (!files.length) files.push('-');
    let rc = 0;
    for (const f of files) {
      let d: Uint8Array;
      try { d = await bytesOf(ctx, f); } catch { ctx.stderr += `sum: ${f}: No such file or directory\n`; rc = 1; continue; }
      if (sysv) {
        let s = 0;
        for (const b of d) s = (s + b) >>> 0;
        let r = (s & 0xffff) + ((s >>> 16) & 0xffff);
        r = (r & 0xffff) + (r >>> 16);
        ctx.stdout += `${r} ${Math.ceil(d.length / 512)}${f === '-' && files.length === 1 ? '' : ' ' + f}\n`;
      } else {
        let c = 0;
        for (const b of d) { c = (c >> 1) + ((c & 1) << 15); c = (c + b) & 0xffff; }
        ctx.stdout += `${String(c).padStart(5, '0')} ${String(Math.ceil(d.length / 1024)).padStart(5)}${files.length > 1 ? ' ' + f : ''}\n`;
      }
    }
    return rc;
  },
};
