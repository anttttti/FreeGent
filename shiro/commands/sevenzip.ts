import type { Command, CommandContext } from './index';
import { ensureRuntimeDir, runtimeIsDirectory, runtimeIsLink, stageRuntimePath } from '../runtime-filesystem';
import { sameBytes, bytesToText, textToBytes } from '../utils/bytes';
import { verifyArtifact } from '../wasi-packages';
import { SEVENZIP_ASSET_PINS } from '../wasi-artifact-pins';

type SevenZipModule = {
  FS: any;
  callMain(args: string[]): number | void;
};
type SevenZipFactory = (options: Record<string, unknown>) => Promise<SevenZipModule>;

let factoryPromise: Promise<{ factory: SevenZipFactory; wasmBinary: Uint8Array }> | null = null;

/** Test hook for exercising the command without downloading the browser WASM bundle. */
export function __setSevenZipForTest(factory: SevenZipFactory | null, wasmBinary = new Uint8Array()): void {
  factoryPromise = factory
    ? Promise.resolve({ factory, wasmBinary })
    : null;
}

async function loadSevenZip(ctx: CommandContext): Promise<{ factory: SevenZipFactory; wasmBinary: Uint8Array }> {
  if (!factoryPromise) {
    factoryPromise = (async () => {
      ctx.shell.onProgress?.('Loading 7-Zip WebAssembly (~1.7 MB, first use)...');
      const assets = [SEVENZIP_ASSET_PINS['7zz.es6.js'], SEVENZIP_ASSET_PINS['7zz.wasm']];
      const [loader, wasm] = await Promise.all(assets.map(async pin => {
        const response = await fetch(pin.url);
        if (!response.ok) throw new Error(`failed to download 7-Zip asset: ${response.status} ${response.statusText}`);
        const bytes = await response.arrayBuffer();
        await verifyArtifact(bytes, pin);
        return bytes;
      }));
      // Import only the verified loader, inside the opaque execution sandbox.
      // Importing the CDN URL first would execute code before checking its hash.
      const url = URL.createObjectURL(new Blob([loader], {type:'text/javascript'}));
      let mod;
      try { mod = await import(/* @vite-ignore */ url); }
      finally { URL.revokeObjectURL(url); }
      const factory = (mod.default || mod.SevenZip) as SevenZipFactory | undefined;
      if (typeof factory !== 'function') throw new Error('7-Zip module did not export its Emscripten factory');
      const wasmBinary = new Uint8Array(wasm);
      ctx.shell.onProgress?.('7-Zip loaded.');
      return { factory, wasmBinary };
    })().catch((err) => {
      factoryPromise = null;
      throw err;
    });
  }
  return factoryPromise;
}


function parentPath(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

function parseArgs(args: string[]): {
  command: string;
  operands: string[];
  outputDir: string | null;
} {
  const commandIndex = args.findIndex(arg => !arg.startsWith('-'));
  const command = commandIndex >= 0 ? args[commandIndex].toLowerCase() : '';
  const operands: string[] = [];
  let outputDir: string | null = null;
  let afterEndOfOptions = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (i === commandIndex) continue;
    if (!afterEndOfOptions && arg === '--') {
      afterEndOfOptions = true;
      continue;
    }
    if (!afterEndOfOptions && arg === '-o') {
      if (i + 1 < args.length) outputDir = args[++i];
      continue;
    }
    if (!afterEndOfOptions && arg.startsWith('-o') && arg.length > 2) {
      outputDir = arg.slice(2);
      continue;
    }
    if (!afterEndOfOptions && arg.startsWith('-')) continue;
    operands.push(arg.startsWith('@') ? arg.slice(1) : arg);
  }

  return { command, operands, outputDir };
}

async function stagePath(
  ctx: CommandContext,
  FS: any,
  path: string,
  beforeFiles: Map<string, Uint8Array>,
  beforeDirs: Set<string>,
  visited: Set<string>,
): Promise<boolean> {
  return stageRuntimePath(FS,ctx.fs,ctx.fs.resolvePath(path,ctx.cwd), {
    files:beforeFiles, dirs:beforeDirs, visited, allowMissing:true,
  });
}

async function syncPath(
  ctx: CommandContext,
  FS: any,
  path: string,
  currentFiles: Set<string>,
  currentDirs: Set<string>,
  visited: Set<string>,
  beforeFiles: Map<string, Uint8Array>,
): Promise<void> {
  if (visited.has(path)) return;
  visited.add(path);

  let stat: any;
  try { stat = FS.lstat ? FS.lstat(path) : FS.stat(path); } catch(error:any) {
    if (error.errno === 44 || /^ENOENT:/.test(error.message ?? '')) return;
    throw error;
  }
  if (runtimeIsLink(FS,stat)) throw new Error(`Cannot synchronize symbolic link: ${path}`);
  if (runtimeIsDirectory(FS,stat)) {
    currentDirs.add(path);
    await ctx.fs.mkdir(path, { recursive: true });
    for (const name of FS.readdir(path)) {
      if (name === '.' || name === '..') continue;
      await syncPath(ctx, FS, `${path}/${name}`, currentFiles, currentDirs, visited, beforeFiles);
    }
    return;
  }

  const bytes = FS.readFile(path) as Uint8Array;
  currentFiles.add(path);
  const before = beforeFiles.get(path);
  if (!before || !sameBytes(before,bytes)) await ctx.fs.writeFile(path, bytes);
}

async function syncChanges(
  ctx: CommandContext,
  FS: any,
  roots: string[],
  beforeFiles: Map<string, Uint8Array>,
  beforeDirs: Set<string>,
): Promise<void> {
  const uniqueRoots = [...new Set(roots)].sort((a, b) => a.length - b.length)
    .filter((path, i, all) => !all.slice(0, i).some(root => path === root || path.startsWith(root.replace(/\/$/, '') + '/')));
  const currentFiles = new Set<string>();
  const currentDirs = new Set<string>();
  const visited = new Set<string>();

  for (const root of uniqueRoots) {
    await syncPath(ctx, FS, root, currentFiles, currentDirs, visited, beforeFiles);
  }

  for (const path of beforeFiles.keys()) {
    if (!currentFiles.has(path) && uniqueRoots.some(root => path === root || path.startsWith(root.replace(/\/$/, '') + '/'))) {
      if (await ctx.fs.exists(path)) await ctx.fs.unlink(path);
    }
  }
  for (const path of [...beforeDirs].sort((a, b) => b.length - a.length)) {
    if (!currentDirs.has(path) && uniqueRoots.some(root => path === root || path.startsWith(root.replace(/\/$/, '') + '/'))) {
      if (await ctx.fs.exists(path)) await ctx.fs.rmdir(path);
    }
  }
}

async function runSevenZip(ctx: CommandContext): Promise<number> {
  const args = ctx.args;

  let loaded: { factory: SevenZipFactory; wasmBinary: Uint8Array };
  try {
    loaded = await loadSevenZip(ctx);
  } catch (err: any) {
    ctx.stderr += `7z: failed to load: ${err?.message || err}\n`;
    return 1;
  }

  const stdout: number[] = [];
  const stderr: number[] = [];
  const input = textToBytes(ctx.stdin);
  let inputOffset = 0;
  // Emscripten's line-oriented print callbacks decode UTF-8 and lose arbitrary
  // extracted bytes. Its standard stream devices accept raw byte callbacks.
  const printLine = (stream:number[], line:string) => {
    for (const byte of textToBytes(line + '\n')) stream.push(byte);
  };
  const flushOutput = () => {
    ctx.stdout += bytesToText(Uint8Array.from(stdout));
    ctx.stderr += bytesToText(Uint8Array.from(stderr));
    stdout.length = stderr.length = 0;
  };
  let sevenZip: SevenZipModule;
  try {
    sevenZip = await loaded.factory({
      wasmBinary: loaded.wasmBinary,
      locateFile: (path:string) => {
        if (path === '7zz.wasm') return SEVENZIP_ASSET_PINS['7zz.wasm'].url;
        throw new Error(`7-Zip requested an undeclared runtime asset: ${path}`);
      },
      stdin: () => inputOffset < input.length ? input[inputOffset++] : null,
      stdout: (byte:number) => { if (byte != null) stdout.push(byte); },
      stderr: (byte:number) => { if (byte != null) stderr.push(byte); },
      print: (line:string) => printLine(stdout,line),
      printErr: (line:string) => printLine(stderr,line),
    });
  } catch (err: any) {
    flushOutput();
    ctx.stderr += `7z: failed to initialize: ${err?.message || err}\n`;
    return 1;
  }

  const { command, operands, outputDir } = parseArgs(args);
  const FS = sevenZip.FS;
  const beforeFiles = new Map<string, Uint8Array>();
  const beforeDirs = new Set<string>();
  const visited = new Set<string>();
  const syncRoots: string[] = [];

  try {
    ensureRuntimeDir(FS, ctx.cwd);
    FS.chdir(ctx.cwd);

    // Stage explicit archive/source paths. Directory inputs are copied recursively.
    for (const operand of operands) {
      if (operand.includes('*') || operand.includes('?') || operand.includes('[')) {
        // 7-Zip expands wildcards itself, so its working directory must be available.
        if (['a', 'u'].includes(command)) {
          await stagePath(ctx, FS, ctx.cwd, beforeFiles, beforeDirs, visited);
          syncRoots.push(ctx.cwd);
        }
        continue;
      }
      const abs = ctx.fs.resolvePath(operand, ctx.cwd);
      if (await stagePath(ctx, FS, abs, beforeFiles, beforeDirs, visited)) syncRoots.push(abs);
    }

    const archivePath = ['a', 'u', 'd', 'rn'].includes(command) && operands.length
      ? ctx.fs.resolvePath(operands[0], ctx.cwd)
      : null;
    if (archivePath) {
      ensureRuntimeDir(FS, parentPath(archivePath));
      syncRoots.push(archivePath);
    }

    // Extraction defaults to the current directory. Stage it to preserve overwrite/skip behavior.
    if (['x', 'e'].includes(command)) {
      const destination = outputDir ? ctx.fs.resolvePath(outputDir, ctx.cwd) : ctx.cwd;
      await stagePath(ctx, FS, destination, beforeFiles, beforeDirs, visited);
      ensureRuntimeDir(FS, destination);
      syncRoots.push(destination);
    }

    let exitCode = 0;
    try {
      const result = sevenZip.callMain(args);
      if (typeof result === 'number') exitCode = result;
    } catch (err: any) {
      const status = Number(err?.status);
      if (Number.isInteger(status) && status >= 0) exitCode = status;
      else throw err;
    }

    await syncChanges(ctx, FS, syncRoots, beforeFiles, beforeDirs);
    flushOutput();
    return exitCode;
  } catch (err: any) {
    flushOutput();
    ctx.stderr += `7z: ${err?.message || err}\n`;
    try { await syncChanges(ctx, FS, syncRoots, beforeFiles, beforeDirs); } catch { /* retain original failure */ }
    return 1;
  }
}

export const sevenZipCmd: Command = {
  name: '7z',
  description: '7-Zip archive creation, listing, testing, and extraction (WebAssembly)',
  exec: runSevenZip,
};
