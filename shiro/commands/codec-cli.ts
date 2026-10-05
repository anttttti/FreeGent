// Shared gzip-style command line for single-stream compressors (xz, zstd, bzip2).
import type { Command, CommandContext } from './index';
import { bytesToText, textToBytes } from '../utils/bytes';

export { concatBytes } from '../utils/bytes';

export interface CodecSpec {
  name: string;                 // command name, e.g. 'xz'
  suffixes: string[];           // accepted suffixes, first is the one appended: ['.xz', '.txz']
  defaultLevel?: number;        // compression level when none is given (bzip2: 9)
  dataErrorStatus?: number;     // exit status for corrupt or unrecognized input (bzip2 uses 2)
  keepSource?: boolean;         // zstd keeps the input file unless --rm; xz and gzip delete it
  compress(data: Uint8Array, level: number): Uint8Array;
  decompress(data: Uint8Array): Uint8Array;
}

/** Build the main command plus its `un*` / `*cat` front-ends. */
export function makeCodecCommands(spec: CodecSpec, aliases: { name: string; prepend: string[] }[]): Command[] {
  const main: Command = {
    name: spec.name,
    description: `Compress or decompress files (${spec.name})`,
    exec: ctx => run(spec, ctx),
  };
  const extras = aliases.map<Command>(a => ({
    name: a.name,
    description: `${spec.name} ${a.prepend.join(' ')}`,
    exec: ctx => run(spec, { ...ctx, args: [...a.prepend, ...ctx.args] } as CommandContext, ctx),
  }));
  return [main, ...extras];
}

async function run(spec: CodecSpec, ctx: CommandContext, out: CommandContext = ctx): Promise<number> {
  let decompress = false, toStdout = false, keep = !!spec.keepSource, force = false, test = false, list = false, quiet = false, verbose = false;
  let level = spec.defaultLevel ?? 6;
  const files: string[] = [];
  let noOpts = false;
  const prog = spec.name;
  const err = (m: string) => { out.stderr += `${prog}: ${m}\n`; };

  for (let i = 0; i < ctx.args.length; i++) {
    const a = ctx.args[i];
    if (noOpts || a === '-' || !a.startsWith('-')) { files.push(a); continue; }
    if (a === '--') { noOpts = true; continue; }
    if (a.startsWith('--')) {
      switch (a) {
        case '--decompress': case '--uncompress': decompress = true; break;
        case '--compress': decompress = false; break;
        case '--stdout': case '--to-stdout': toStdout = true; break;
        case '--keep': keep = true; break;
        case '--force': force = true; break;
        case '--test': test = true; break;
        case '--list': list = true; break;
        case '--quiet': quiet = true; break;
        case '--verbose': verbose = true; break;
        case '--fast': level = 1; break;
        case '--best': level = 9; break;
        case '--rm': keep = false; break;
        case '--version': out.stdout += `${prog} (shiro)\n`; return 0;
        case '--help': out.stdout += `Usage: ${prog} [OPTION]... [FILE]...\n`; return 0;
        default:
          if (/^--(threads|memory|format|check|extreme|no-progress|single-stream|ultra|long|adapt|block-size)(=|$)/.test(a)) break;
          err(`unrecognized option '${a}'`);
          return 1;
      }
      continue;
    }
    for (const f of a.slice(1)) {
      if (f === 'd') decompress = true;
      else if (f === 'z') decompress = false;
      else if (f === 'c') toStdout = true;
      else if (f === 'k') keep = true;
      else if (f === 'f') force = true;
      else if (f === 't') test = true;
      else if (f === 'l') list = true;
      else if (f === 'q') quiet = true;
      else if (f === 'v') verbose = true;
      else if (/[0-9]/.test(f)) level = +f;
      else if (f === 'T' || f === 'M' || f === 'S') { if (a.length === 2) i++; break; }
      else if (f === 'e' || f === 'H' || f === 'V' || f === 'h') { if (f === 'V') { out.stdout += `${prog} (shiro)\n`; return 0; } }
      else { err(`invalid option -- '${f}'`); return 1; }
    }
  }
  if (list) { err('--list is not supported'); return 1; }

  const stripSuffix = (p: string) => {
    for (const s of spec.suffixes) if (p.endsWith(s)) return p.slice(0, -s.length) + (s === '.txz' ? '.tar' : '');
    return null;
  };
  const convert = (bytes: Uint8Array, label: string): Uint8Array | null => {
    try { return decompress || test ? spec.decompress(bytes) : spec.compress(bytes, level); }
    catch (e: any) {
      if (spec.name === 'bzip2' && /bad magic/.test(String(e?.message))) {
        out.stderr += `${prog}: ${label} is not a bzip2 file.\n`;
      } else if (spec.name === 'zstd' && label === '(stdin)' && /not in zstd format/.test(String(e?.message))) {
        out.stderr += 'zstd: /*stdin*\\: unsupported format \n';
      } else {
        err(`${label}: ${e.message}`);
      }
      return null;
    }
  };

  if (files.length === 0 || (files.length === 1 && files[0] === '-')) {
    if (!ctx.stdin) {
      if (!decompress && !test) err('compressed data not written to a terminal. Use -f to force compression.');
      else err('(stdin): Unexpected end of input');
      return 1;
    }
    const res = convert(textToBytes(ctx.stdin), '(stdin)');
    if (!res) return decompress || test ? spec.dataErrorStatus ?? 1 : 1;
    if (!test) out.stdout += bytesToText(res);
    return 0;
  }

  let status = 0;
  for (const file of files) {
    const path = ctx.fs.resolvePath(file, ctx.cwd);
    let bytes: Uint8Array;
    try {
      const data = await ctx.fs.readFile(path);
      bytes = typeof data === 'string' ? textToBytes(data) : data;
    } catch {
      err(`${file}: No such file or directory`);
      status = 1;
      continue;
    }
    const doDecode = decompress || test;
    let outPath: string | null = null;
    if (!toStdout && !test) {
      if (doDecode) {
        const stem = stripSuffix(path);
        if (stem === null) { err(`${file}: Filename has an unknown extension, skipping`); status = 1; continue; }
        outPath = stem;
      } else {
        if (spec.suffixes.some(s => path.endsWith(s)) && !force) { err(`${file}: File already has '${spec.suffixes[0]}' suffix, skipping`); status = 1; continue; }
        outPath = path + spec.suffixes[0];
      }
      if (!force) {
        let exists = false;
        try { exists = !!(await ctx.fs.stat(outPath)); } catch { /* absent */ }
        if (exists) { err(`${outPath.split('/').pop()}: Target file already exists; use -f to overwrite`); status = 1; continue; }
      }
    }
    const res = convert(bytes, file);
    if (!res) { status = Math.max(status, decompress || test ? spec.dataErrorStatus ?? 1 : 1); continue; }
    if (test) { if (verbose && !quiet) out.stderr += `${file}: OK\n`; continue; }
    if (toStdout) { out.stdout += bytesToText(res); continue; }
    await ctx.fs.writeFile(outPath!, res);
    if (!keep) await ctx.fs.unlink(path);
    if (verbose && !quiet) out.stderr += `${file} -> ${outPath!.split('/').pop()}\n`;
  }
  return status;
}
