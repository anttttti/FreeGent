import type { Command, CommandContext } from './index';
import { bytesToText, textToBytes } from '../utils/bytes';

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
  const r = b64decodeStream(text);
  return r.ok ? r.bytes : null;
}

/**
 * Decodes as GNU base64 -d does: as a stream, every whole byte up to the first character outside
 * the alphabet (or a missing end of padding) comes out, then the input is "invalid" (ok = false).
 * Padding ends the data; whitespace (newlines) is skipped.
 */
export function b64decodeStream(text: string): { bytes: Uint8Array; ok: boolean } {
  const out: number[] = [];
  let acc = 0, bits = 0, chars = 0, ok = true, padded = false;
  for (const ch of text) {
    if (ch === '\n' || ch === '\r') continue;
    if (ch === '=') { padded = true; chars++; continue; }
    const v = ALPHA.indexOf(ch);
    if (v < 0 || padded) { ok = false; break; }
    acc = ((acc << 6) | v) & 0xffffff; bits += 6; chars++;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
  }
  if (ok && chars % 4 !== 0) ok = false;   // unpadded or truncated: what decoded is kept
  return { bytes: Uint8Array.from(out), ok };
}

async function readBytes(ctx: CommandContext, f: string): Promise<Uint8Array> {
  if (f === '-') return textToBytes(ctx.stdin);
  const c = await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd));
  return typeof c === 'string' ? textToBytes(c) : c;
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
      const { bytes: out, ok } = b64decodeStream(text);
      ctx.stdout += bytesToText(out);
      if (!ok) { ctx.stderr += 'base64: invalid input\n'; return 1; }
      return 0;
    }
    const enc = b64encode(bytes);
    if (!enc) return 0;
    if (wrap > 0) { for (let i = 0; i < enc.length; i += wrap) ctx.stdout += enc.slice(i, i + wrap) + '\n'; }
    else ctx.stdout += enc;
    return 0;
  },
};
