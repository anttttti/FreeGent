/** One upstream Zstandard CLI for commands and archive callers. */
import type { Command, CommandContext } from './index';
import { packageCommand } from '../wasi-packages';
import { bytesToText, textToBytes } from '../utils/bytes';

export const zstdCmd:Command = packageCommand('zstd');
export const unzstdCmd:Command = packageCommand('unzstd');
export const zstdcatCmd:Command = packageCommand('zstdcat');

async function transform(data:Uint8Array,ctx:CommandContext,args:string[]):Promise<Uint8Array> {
  const result = await ctx.shell.execArgv(['zstd','-q','-c',...args],bytesToText(data),true);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `zstd exited with status ${result.exitCode}`);
  return textToBytes(result.stdout);
}
export function zstdCompress(data:Uint8Array,ctx:CommandContext,level=3):Promise<Uint8Array> {
  return transform(data,ctx,[`-${level}`]);
}
export function zstdDecompress(data:Uint8Array,ctx:CommandContext):Promise<Uint8Array> {
  return transform(data,ctx,['-d']);
}
