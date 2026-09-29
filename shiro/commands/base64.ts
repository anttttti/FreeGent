import type { Command, CommandContext } from './index';

// GNU base64: encode bytes, wrapped at 76 columns (-w N, 0 = no wrapping); -d decodes (-i ignores
// non-alphabet characters). Binary-safe: works on bytes, not JavaScript strings.
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function b64encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHA[(n >> 18) & 63] + ALPHA[(n >> 12) & 63] + (i + 1 < bytes.length ? ALPHA[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? ALPHA[n & 63] : '=');
  }
  return out;
}
export function b64decode(text: string): Uint8Array | null {
  const clean = text.replace(/=+$/, '');
  if (/[^A-Za-z0-9+/]/.test(clean) || clean.length % 4 === 1) return null;
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const v = [0, 1, 2, 3].map(k => ALPHA.indexOf(clean[i + k] ?? 'A'));
    const n = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3];
    out.push((n >> 16) & 255);
    if (i + 2 < clean.length) out.push((n >> 8) & 255);
    if (i + 3 < clean.length) out.push(n & 255);
  }
  return Uint8Array.from(out);
}

async function readBytes(ctx: CommandContext, f: string): Promise<Uint8Array> {
  if (f === '-') return new TextEncoder().encode(ctx.stdin);
  const c = await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd));
  return typeof c === 'string' ? new TextEncoder().encode(c) : c;
}

export const base64: Command = {
  name: "base64",
  description: "Base64 encode or decode",
  async exec(ctx) {
    let decode = false, ignoreGarbage = false, wrap = 76;
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-d' || a === '--decode' || a === '-D') decode = true;
      else if (a === '-i' || a === '--ignore-garbage') ignoreGarbage = true;
      else if (a === '-w' || a === '--wrap') wrap = parseInt(args[++i], 10);
      else if (a.startsWith('--wrap=')) wrap = parseInt(a.slice(7), 10);
      else if (a.startsWith('-w')) wrap = parseInt(a.slice(2), 10);
      else if (/^-[di]+$/.test(a)) { if (a.includes('d')) decode = true; if (a.includes('i')) ignoreGarbage = true; }
      else files.push(a);
    }
    let bytes: Uint8Array;
    try { bytes = await readBytes(ctx, files[0] ?? '-'); }
    catch { ctx.stderr += `base64: ${files[0]}: No such file or directory\n`; return 1; }
    if (decode) {
      let text = new TextDecoder('latin1').decode(bytes);
      text = ignoreGarbage ? text.replace(/[^A-Za-z0-9+/=]/g, '') : text.replace(/\n/g, '');
      const out = b64decode(text);
      if (!out) { ctx.stderr += 'base64: invalid input\n'; return 1; }
      ctx.stdout += new TextDecoder().decode(out);
      return 0;
    }
    const enc = b64encode(bytes);
    if (!enc) return 0;
    if (wrap > 0) { for (let i = 0; i < enc.length; i += wrap) ctx.stdout += enc.slice(i, i + wrap) + '\n'; }
    else ctx.stdout += enc;
    return 0;
  },
};
