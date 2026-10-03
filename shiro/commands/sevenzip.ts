import type { Command, CommandContext } from './index';

// Emscripten build of 7-Zip's Alone2 CLI. Keep JS and WASM versions pinned together.
const SEVENZIP_VERSION = '1.2.0';
const SEVENZIP_CDN = `https://cdn.jsdelivr.net/npm/7z-wasm@${SEVENZIP_VERSION}`;
const SEVENZIP_MODULE_URL = `${SEVENZIP_CDN}/7zz.es6.js`;
const SEVENZIP_WASM_URL = `${SEVENZIP_CDN}/7zz.wasm`;

type SevenZipModule = {
  FS: any;
  callMain(args: string[]): number | void;
};
type SevenZipFactory = (options: Record<string, unknown>) => Promise<SevenZipModule>;

let factoryPromise: Promise<{ factory: SevenZipFactory; wasmBinary: Uint8Array }> | null = null;

/** Test hook for exercising the command without downloading the browser WASM bundle. */
export function __setSevenZipForTest(factory: SevenZipFactory | null): void {
  factoryPromise = factory
    ? Promise.resolve({ factory, wasmBinary: new Uint8Array() })
    : null;
}

async function loadSevenZip(ctx: CommandContext): Promise<{ factory: SevenZipFactory; wasmBinary: Uint8Array }> {
  if (!factoryPromise) {
    factoryPromise = (async () => {
      ctx.stdout += 'Loading 7-Zip WebAssembly (~1.7 MB, first use)...\n';
      const [mod, response] = await Promise.all([
        import(/* @vite-ignore */ SEVENZIP_MODULE_URL),
        fetch(SEVENZIP_WASM_URL),
      ]);
      if (!response.ok) throw new Error(`failed to download 7zz.wasm: ${response.status} ${response.statusText}`);
      const factory = (mod.default || mod.SevenZip) as SevenZipFactory | undefined;
      if (typeof factory !== 'function') throw new Error('7-Zip module did not export its Emscripten factory');
      const wasmBinary = new Uint8Array(await response.arrayBuffer());
      ctx.stdout += '7-Zip loaded.\n';
      return { factory, wasmBinary };
    })().catch((err) => {
      factoryPromise = null;
      throw err;
    });
  }
  return factoryPromise;
}

function ensureWasmDir(FS: any, path: string): void {
  let current = '';
  for (const part of path.split('/').filter(Boolean)) {
    current += `/${part}`;
    try { FS.mkdir(current); } catch { /* already exists */ }
  }
}

function fingerprint(bytes: Uint8Array): string {
  // Fast change detection so unchanged staged files aren't written back to the workspace.
  let hashA = 2166136261;
  let hashB = 0x9747b28c;
  for (const byte of bytes) {
    hashA = Math.imul(hashA ^ byte, 16777619);
    hashB = Math.imul(hashB ^ byte, 0x5bd1e995);
  }
  return `${bytes.byteLength}:${hashA >>> 0}:${hashB >>> 0}`;
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
  beforeFiles: Map<string, string>,
  beforeDirs: Set<string>,
  visited: Set<string>,
): Promise<boolean> {
  const resolved = ctx.fs.resolvePath(path, ctx.cwd);
  if (visited.has(resolved)) return true;

  let stat: any;
  try { stat = await ctx.fs.lstat(resolved); } catch { return false; }
  if (stat.isSymbolicLink?.()) return false;
  visited.add(resolved);

  if (stat.isDirectory()) {
    ensureWasmDir(FS, resolved);
    beforeDirs.add(resolved);
    for (const name of await ctx.fs.readdir(resolved)) {
      await stagePath(ctx, FS, `${resolved}/${name}`, beforeFiles, beforeDirs, visited);
    }
    return true;
  }

  const raw = await ctx.fs.readFile(resolved);
  const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
  ensureWasmDir(FS, parentPath(resolved));
  FS.writeFile(resolved, bytes);
  beforeFiles.set(resolved, fingerprint(bytes));
  return true;
}

async function syncPath(
  ctx: CommandContext,
  FS: any,
  path: string,
  currentFiles: Set<string>,
  currentDirs: Set<string>,
  visited: Set<string>,
  beforeFiles: Map<string, string>,
): Promise<void> {
  if (visited.has(path)) return;
  visited.add(path);

  let stat: any;
  try { stat = FS.lstat ? FS.lstat(path) : FS.stat(path); } catch { return; }
  if (stat.isSymbolicLink?.()) return;
  if (stat.isDirectory()) {
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
  if (beforeFiles.get(path) !== fingerprint(bytes)) await ctx.fs.writeFile(path, bytes);
}

async function syncChanges(
  ctx: CommandContext,
  FS: any,
  roots: string[],
  beforeFiles: Map<string, string>,
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
      try { await ctx.fs.unlink(path); } catch { /* already absent */ }
    }
  }
  for (const path of [...beforeDirs].sort((a, b) => b.length - a.length)) {
    if (!currentDirs.has(path) && uniqueRoots.some(root => path === root || path.startsWith(root.replace(/\/$/, '') + '/'))) {
      try { await ctx.fs.rmdir(path); } catch { /* still contains files or already absent */ }
    }
  }
}

async function runSevenZip(ctx: CommandContext): Promise<number> {
  const args = ctx.args;
  if (args.length === 0) {
    ctx.stdout = '7-Zip (Shiro WebAssembly)\nUsage: 7z <command> [switches...] archive [files...]\nCommands: a add, x extract with paths, e extract flat, l list, t test\n';
    return 0;
  }

  let loaded: { factory: SevenZipFactory; wasmBinary: Uint8Array };
  try {
    loaded = await loadSevenZip(ctx);
  } catch (err: any) {
    ctx.stderr += `7z: failed to load: ${err?.message || err}\n`;
    return 1;
  }

  const stdout: string[] = [];
  const stderr: string[] = [];
  let sevenZip: SevenZipModule;
  try {
    sevenZip = await loaded.factory({
      wasmBinary: loaded.wasmBinary,
      locateFile: (path: string) => path.endsWith('.wasm') ? SEVENZIP_WASM_URL : `${SEVENZIP_CDN}/${path}`,
      print: (line: string) => stdout.push(line),
      printErr: (line: string) => stderr.push(line),
    });
  } catch (err: any) {
    ctx.stderr += `7z: failed to initialize: ${err?.message || err}\n`;
    return 1;
  }

  const { command, operands, outputDir } = parseArgs(args);
  const FS = sevenZip.FS;
  const beforeFiles = new Map<string, string>();
  const beforeDirs = new Set<string>();
  const visited = new Set<string>();
  const syncRoots: string[] = [];

  try {
    ensureWasmDir(FS, ctx.cwd);
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
      ensureWasmDir(FS, parentPath(archivePath));
      syncRoots.push(archivePath);
    }

    // Extraction defaults to the current directory. Stage it to preserve overwrite/skip behavior.
    if (['x', 'e'].includes(command)) {
      const destination = outputDir ? ctx.fs.resolvePath(outputDir, ctx.cwd) : ctx.cwd;
      await stagePath(ctx, FS, destination, beforeFiles, beforeDirs, visited);
      ensureWasmDir(FS, destination);
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
    if (stdout.length) ctx.stdout += stdout.join('\n') + '\n';
    if (stderr.length) ctx.stderr += stderr.join('\n') + '\n';
    return exitCode;
  } catch (err: any) {
    if (stdout.length) ctx.stdout += stdout.join('\n') + '\n';
    if (stderr.length) ctx.stderr += stderr.join('\n') + '\n';
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
