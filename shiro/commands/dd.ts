/**
 * dd — copy and convert data
 */

import type { Command } from './index';
import { fromByteString, toByteString } from '../utils/bytes';
import { parseSize as parseSizeStrict } from './flags';

// dd falls back to 512 for an unparsable block size.
function parseSize(s: string): number { return parseSizeStrict(s) ?? (parseInt(s, 10) || 512); }

export const ddCmd: Command = {
  name: 'dd',
  description: 'Copy and convert data',
  async exec(ctx) {
    try {
      let ifPath = '';
      let ofPath = '';
      let bs = 512;
      let count = -1;
      let skip = 0;
      let seek = 0;
      let conv = '';
      let status = '';

      for (const arg of ctx.args) {
        const [key, ...rest] = arg.split('=');
        const val = rest.join('=');
        switch (key) {
          case 'if': ifPath = val; break;
          case 'of': ofPath = val; break;
          case 'bs': bs = parseSize(val); break;
          case 'count': count = parseInt(val, 10); break;
          case 'skip': skip = parseInt(val, 10); break;
          case 'seek': seek = parseInt(val, 10); break;
          case 'conv': conv = val; break;
          case 'status': status = val; break;
        }
      }

      // Read input
      let data: string;
      if (ifPath) {
        if (ifPath === '/dev/zero') {
          const totalBytes = count >= 0 ? bs * count : bs;
          data = '\0'.repeat(totalBytes);
        } else if (ifPath === '/dev/random' || ifPath === '/dev/urandom') {
          const totalBytes = count >= 0 ? bs * count : bs;
          const bytes = new Uint8Array(totalBytes);
          crypto.getRandomValues(bytes);
          data = String.fromCharCode(...bytes);
        } else {
          const resolved = ctx.fs.resolvePath(ifPath, ctx.cwd);
          try {data = toByteString(await ctx.fs.readFile(resolved,'utf8') as string);}
          catch (error:any) {if (error.code === 'ENOENT') throw new Error(`failed to open '${ifPath}': No such file or directory`); throw error;}
        }
      } else {
        data = toByteString(ctx.stdin);
      }

      // Apply skip (in blocks)
      if (skip > 0) {
        data = data.substring(skip * bs);
      }

      // Apply count (in blocks)
      if (count >= 0) {
        data = data.substring(0, count * bs);
      }

      // Apply conversions
      if (conv) {
        const convs = conv.split(',');
        for (const c of convs) {
          switch (c) {
            case 'ucase': data = data.toUpperCase(); break;
            case 'lcase': data = data.toLowerCase(); break;
            case 'swab': {
              const chars = data.split('');
              for (let i = 0; i + 1 < chars.length; i += 2) {
                [chars[i], chars[i + 1]] = [chars[i + 1], chars[i]];
              }
              data = chars.join('');
              break;
            }
          }
        }
      }

      // Write output
      if (ofPath) {
        const resolved = ctx.fs.resolvePath(ofPath, ctx.cwd);
        if (seek > 0) {
          let existing = '';
          try { existing = await ctx.fs.readFile(resolved, 'utf8') as string; } catch {}
          const padded = existing.padEnd(seek * bs, '\0');
          data = padded + data;
        }
        await ctx.fs.writeFile(resolved, fromByteString(data));
      } else {
        ctx.stdout += fromByteString(data);
      }

      // Status line to stderr
      const blocks = count >= 0 ? count : Math.ceil(data.length / bs);
      if (status !== 'none') ctx.stderr += `${blocks}+0 records in\n${blocks}+0 records out\n${data.length} bytes copied\n`;
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `dd: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
