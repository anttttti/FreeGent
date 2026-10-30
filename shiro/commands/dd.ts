/**
 * dd — copy and convert data
 *
 * Works on bytes throughout. It used to read files as UTF-8 text, so invalid sequences became U+FFFD and the copy changed (codex R301);
 * conv=ucase/lcase used Unicode case mapping on byte values ("ß" became "SS", R298); conv=notrunc was accepted and ignored (R297);
 * /dev/urandom asked Web Crypto for more than its 65,536-byte limit at once (R299); the status line echoed count= instead of what was
 * copied (R300); and a malformed size such as bs=4banana fell back to its numeric prefix (R305).
 */

import type { Command } from './index';
import { bytesToText, textToBytes } from '../utils/bytes';
import { parseSize } from './flags';

const CONVERSIONS = new Set(['ucase', 'lcase', 'swab', 'notrunc', 'noerror', 'sync', 'fsync', 'fdatasync']);

function count(key: string, val: string): number {
  if (!/^\d+$/.test(val)) throw new Error(`invalid number: '${val}' (${key}=)`);
  return Number(val);
}

export const ddCmd: Command = {
  name: 'dd',
  description: 'Copy and convert data',
  async exec(ctx) {
    try {
      let ifPath = '';
      let ofPath = '';
      let bs = 512;
      let blocks = -1;
      let skip = 0;
      let seek = 0;
      const convs = new Set<string>();
      let status = '';

      for (const arg of ctx.args) {
        const [key, ...rest] = arg.split('=');
        const val = rest.join('=');
        switch (key) {
          case 'if': ifPath = val; break;
          case 'of': ofPath = val; break;
          case 'bs': case 'ibs': case 'obs': {
            const n = parseSize(val);
            if (n === null || !(n > 0)) throw new Error(`invalid number: '${val}' (${key}=)`);
            bs = n; break;
          }
          case 'count': blocks = count(key, val); break;
          case 'skip': skip = count(key, val); break;
          case 'seek': seek = count(key, val); break;
          case 'conv':
            for (const c of val.split(',').filter(Boolean)) {
              if (!CONVERSIONS.has(c)) throw new Error(`invalid conversion: '${c}'`);
              convs.add(c);
            }
            break;
          case 'status': status = val; break;
          case 'iflag': case 'oflag': case 'cbs': break;   // accepted; nothing here depends on them
          default: throw new Error(`unrecognized operand '${arg}'`);
        }
      }

      // Read input
      let data: Uint8Array<ArrayBufferLike>;
      if (ifPath === '/dev/zero') {
        data = new Uint8Array(blocks >= 0 ? bs * blocks : bs);
      } else if (ifPath === '/dev/random' || ifPath === '/dev/urandom') {
        data = new Uint8Array(blocks >= 0 ? bs * blocks : bs);
        for (let i = 0; i < data.length; i += 65536) crypto.getRandomValues(data.subarray(i, i + 65536) as Uint8Array<ArrayBuffer>);   // Web Crypto's per-call limit
      } else if (ifPath) {
        const resolved = ctx.fs.resolvePath(ifPath, ctx.cwd);
        try {
          const raw = await ctx.fs.readFile(resolved);
          data = typeof raw === 'string' ? textToBytes(raw) : raw;
        } catch (error: any) {
          if (error.code === 'ENOENT') throw new Error(`failed to open '${ifPath}': No such file or directory`);
          throw error;
        }
      } else {
        data = textToBytes(ctx.stdin);
      }

      if (skip > 0) data = data.subarray(Math.min(data.length, skip * bs));
      if (blocks >= 0) data = data.subarray(0, Math.min(data.length, blocks * bs));
      const inLength = data.length;

      // Conversions: on bytes, ASCII letters only, as dd does
      if (convs.has('ucase') || convs.has('lcase') || convs.has('swab')) {
        const out = data.slice();
        if (convs.has('ucase')) for (let i = 0; i < out.length; i++) if (out[i] >= 0x61 && out[i] <= 0x7a) out[i] -= 0x20;
        if (convs.has('lcase')) for (let i = 0; i < out.length; i++) if (out[i] >= 0x41 && out[i] <= 0x5a) out[i] += 0x20;
        if (convs.has('swab')) for (let i = 0; i + 1 < out.length; i += 2) { const t = out[i]; out[i] = out[i + 1]; out[i + 1] = t; }
        data = out;
      }

      // Write output
      if (ofPath) {
        const resolved = ctx.fs.resolvePath(ofPath, ctx.cwd);
        let existing: Uint8Array = new Uint8Array(0);
        if (seek > 0 || convs.has('notrunc')) {
          try { const raw = await ctx.fs.readFile(resolved); existing = typeof raw === 'string' ? textToBytes(raw) : raw; } catch { /* new file */ }
        }
        const start = seek * bs;
        // Without notrunc the output ends where the copy ends; with it, what follows in the existing file stays.
        const end = start + data.length;
        const size = convs.has('notrunc') ? Math.max(existing.length, end) : end;
        const out = new Uint8Array(size);
        out.set(existing.subarray(0, Math.min(existing.length, convs.has('notrunc') ? size : start)));
        out.set(data, start);
        await ctx.fs.writeFile(resolved, out);
      } else {
        ctx.stdout += bytesToText(data);
      }

      // Status line to stderr: whole and partial records actually copied
      const full = Math.floor(inLength / bs), part = inLength % bs ? 1 : 0;
      if (status !== 'none') ctx.stderr += `${full}+${part} records in\n${full}+${part} records out\n${data.length} bytes copied\n`;
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `dd: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
