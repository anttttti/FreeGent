import type { Command, CommandContext } from './index';
import { sha256 } from './checksums';
import { bytesToText, textToBytes } from '../utils/bytes';
import { readOperandBytes as readBytes } from './flags';

// GNU md5sum / sha1sum / sha256sum / sha512sum: "HASH  NAME" per file ("-" for stdin), -c to check
// a list of sums. File bytes are hashed as stored (binary files as bytes).

function md5(data: Uint8Array): string {
  const s = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  const len = data.length;
  const padded = new Uint8Array(((len + 8) >> 6) * 64 + 64);
  padded.set(data);
  padded[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bits >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bits / 2 ** 32), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < padded.length; off += 64) {
    const M = Array.from({ length: 16 }, (_, i) => dv.getUint32(off + i * 4, true));
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << s[i]) | (F >>> (32 - s[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((v, i) => out.setUint32(i * 4, v, true));
  return [...new Uint8Array(out.buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function digest(algo: string, data: Uint8Array): Promise<string> {
  if (algo === 'MD5') return md5(data);
  if (typeof crypto === 'undefined' || !crypto.subtle?.digest) {
    if (algo === 'SHA-256') return Array.from(sha256(data), b => b.toString(16).padStart(2, '0')).join('');
    throw new Error(`${algo} requires Web Crypto: use HTTPS or local execution`);
  }
  const buf = await crypto.subtle.digest(algo, data as BufferSource);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}


const TAGS: Record<string, string> = { MD5: 'MD5', 'SHA-1': 'SHA1', 'SHA-256': 'SHA256', 'SHA-384': 'SHA384', 'SHA-512': 'SHA512' };

function hashCommand(name: string, algo: string): Command {
  return {
    name,
    description: `Compute ${algo} message digests`,
    async exec(ctx) {
      let check = false, quiet = false, status = false, star = false, tag = false, zero = false, ignoreMissing = false, strict = false;
      const files: string[] = [];
      for (const a of ctx.args) {
        if (a === '-c' || a === '--check') check = true;
        else if (a === '--quiet') quiet = true;
        else if (a === '--status') status = true;
        else if (a === '-b' || a === '--binary') star = true;
        else if (a === '-t' || a === '--text') star = false;
        else if (a === '--tag') tag = true;
        else if (a === '-z' || a === '--zero') zero = true;
        else if (a === '--ignore-missing') ignoreMissing = true;
        else if (a === '--strict') strict = true;
        else if (a === '-w' || a === '--warn') { /* accepted */ }
        else if (a.startsWith('-') && a.length > 1 && a !== '-') { ctx.stderr += `${name}: invalid option -- '${a.replace(/^-+/, '')}'\n`; return 1; }
        else files.push(a);
      }
      if (!files.length) files.push('-');
      let rc = 0;
      if (check) {
        let failed = 0, unreadable = 0, bad = 0, checked = 0;
        for (const list of files) {
          let text: string;
          try { text = bytesToText(await readBytes(ctx, list)); }
          catch { ctx.stderr += `${name}: ${list}: No such file or directory\n`; rc = 1; continue; }
          let found = 0;
          for (const line of text.split('\n').filter(Boolean)) {
            const m = /^([0-9a-fA-F]+) [ *](.+)$/.exec(line) ?? (() => { const t = /^[A-Za-z0-9-]+ \((.+)\) = ([0-9a-fA-F]+)$/.exec(line); return t ? [line, t[2], t[1]] as unknown as RegExpExecArray : null; })();
            if (!m) { bad++; continue; }
            found++;
            let data: Uint8Array;
            try { data = await readBytes(ctx, m[2]); }
            catch {
              if (ignoreMissing) continue;
              unreadable++; failed++;
              if (!status) ctx.stdout += `${m[2]}: FAILED open or read\n`;
              ctx.stderr += `${name}: ${m[2]}: No such file or directory\n`;
              continue;
            }
            checked++;
            const ok = (await digest(algo, data)) === m[1].toLowerCase();
            if (!ok) failed++;
            if (!status && (!ok || !quiet)) ctx.stdout += `${m[2]}: ${ok ? 'OK' : 'FAILED'}\n`;
          }
          if (found === 0) { ctx.stderr += `${name}: ${list}: no properly formatted checksum lines found\n`; rc = 1; }
        }
        if (bad && !status) ctx.stderr += `${name}: WARNING: ${bad} line${bad > 1 ? 's are' : ' is'} improperly formatted\n`;
        if (unreadable && !status) ctx.stderr += `${name}: WARNING: ${unreadable} listed file${unreadable > 1 ? 's' : ''} could not be read\n`;
        const mismatched = failed - unreadable;
        if (mismatched && !status) ctx.stderr += `${name}: WARNING: ${mismatched} computed checksum${mismatched > 1 ? 's' : ''} did NOT match\n`;
        void checked;
        return failed || rc || (strict && bad) ? 1 : 0;
      }
      for (const f of files) {
        try {
          const h = await digest(algo, await readBytes(ctx, f));
          ctx.stdout += (tag ? `${TAGS[algo]} (${f}) = ${h}` : `${h} ${star ? '*' : ' '}${f}`) + (zero ? '\0' : '\n');
        }
        catch (error: any) { ctx.stderr += `${name}: ${f}: ${error?.message?.includes('requires Web Crypto') ? error.message : 'No such file or directory'}\n`; rc = 1; }
      }
      return rc;
    },
  };
}

export const md5sum = hashCommand('md5sum', 'MD5');
export const sha1sum = hashCommand('sha1sum', 'SHA-1');
export const sha256sum = hashCommand('sha256sum', 'SHA-256');
export const sha512sum = hashCommand('sha512sum', 'SHA-512');
export const sha384sum = hashCommand('sha384sum', 'SHA-384');
