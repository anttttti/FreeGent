import type { Command } from './index';
import { bytesToText, textToBytes } from '../utils/bytes';

import { transformBytes } from '../utils/streams';
const compress = (data:Uint8Array) => transformBytes(new CompressionStream('gzip') as any,data);
const decompress = (data:Uint8Array) => transformBytes(new DecompressionStream('gzip') as any,data);

export const gzipCmd: Command = {
  name: 'gzip',
  description: 'Compress files (gzip)',
  async exec(ctx) {
    let toStdout = false;
    let decompressMode = false;
    let keep = false;
    let test = false;
    const files: string[] = [];

    for (let i = 0; i < ctx.args.length; i++) {
      const arg = ctx.args[i];
      if (arg === '-c' || arg === '--stdout') toStdout = true;
      else if (arg === '-d' || arg === '--decompress') decompressMode = true;
      else if (arg === '-k' || arg === '--keep') keep = true;
      else if (arg === '-t' || arg === '--test') {test = true; decompressMode = true;}
      else if (arg === '-f' || arg === '--force') { /* ignore */ }
      else if (arg.startsWith('-') && !arg.startsWith('--')) {
        for (const f of arg.slice(1)) {
          if (f === 'c') toStdout = true;
          else if (f === 'd') decompressMode = true;
          else if (f === 'k') keep = true;
          else if (f === 't') {test = true; decompressMode = true;}
          else if (f === 'f') { /* ignore */ }
        }
      } else {
        files.push(arg);
      }
    }

    // Stdin pipe mode
    if (files.length === 0) {
      if (!ctx.stdin) {
        ctx.stderr = 'gzip: compressed data not written to terminal\n';
        return 1;
      }
      // Binary data in a pipe arrives with its non-UTF-8 bytes escaped (utils/bytes.ts).
      const input = textToBytes(ctx.stdin);
      let result: Uint8Array;
      try { result = decompressMode ? await decompress(input) : await compress(input); }
      catch { ctx.stderr += '\ngzip: stdin: not in gzip format\n'; return 1; }
      if (test) return 0;
      if (decompressMode) {
        ctx.stdout = bytesToText(result);
      } else {
        ctx.stdout = bytesToText(result);
      }
      return 0;
    }

    for (const file of files) {
      const resolved = ctx.fs.resolvePath(file, ctx.cwd);
      try {
        const data = await ctx.fs.readFile(resolved);
        const input = typeof data === 'string' ? textToBytes(data) : data;

        if (decompressMode) {
          const result = await decompress(input);
          if (test) continue;
          const outPath = resolved.replace(/\.gz$/, '');
          if (toStdout) {
            ctx.stdout += bytesToText(result);
          } else {
            await ctx.fs.writeFile(outPath, result);
            if (!keep) await ctx.fs.unlink(resolved);
          }
        } else {
          const result = await compress(input);
          const outPath = resolved + '.gz';
          if (toStdout) {
            ctx.stdout += bytesToText(result);
          } else {
            await ctx.fs.writeFile(outPath, result);
            if (!keep) await ctx.fs.unlink(resolved);
          }
        }
      } catch (e: any) {
        ctx.stderr += `gzip: ${file}: ${e.message}\n`;
        return 1;
      }
    }
    return 0;
  },
};

export const gunzipCmd: Command = {
  name: 'gunzip',
  description: 'Decompress gzip files',
  async exec(ctx) {
    // Prepend -d flag and delegate to gzip
    ctx.args = ['-d', ...ctx.args];
    return gzipCmd.exec(ctx);
  },
};
