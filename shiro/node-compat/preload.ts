import type { CommandContext } from '../commands/index';
import { skippedSizes } from './file-cache';

// Every `node` run copies the files around it into strings. A game project with hundreds of images and saved pages made that
// step run for 20-40 s and then took the tab down, even for `node -e "console.log('hi')"` (uploaded logs 2026-11-09, 40 crash
// records). Binary files read as UTF-8 text are useless to a script anyway, and the total is capped.
const _BINARY_EXT = /\.(?:png|jpe?g|gif|webp|bmp|ico|avif|tiff?|mp[34]|m4a|ogg|oga|wav|flac|webm|mov|avi|mkv|zip|gz|tgz|bz2|xz|7z|rar|tar|pdf|woff2?|ttf|otf|eot|wasm|bin|so|dll|exe|dylib|class|jar|pyc|npy|npz|onnx|pt|safetensors|sqlite3?|db)$/i;
const _PRELOAD_BUDGET = 48 * 1024 * 1024;   // characters held by one run's preload
const _spent = new WeakMap<object, number>();
const _budgetLeft = (cache: object): number => _PRELOAD_BUDGET - (_spent.get(cache) ?? 0);
const _spend = (cache: object, n: number): void => { _spent.set(cache, (_spent.get(cache) ?? 0) + n); };

/**
 * Pre-load files from the virtual filesystem into the memory cache.
 * This enables synchronous readFileSync/statSync to work without IndexedDB round-trips.
 */
export async function preloadDir(
  ctx: CommandContext,
  fileCache: Map<string, string>,
  fileMtimes: Map<string, number>,
  dir: string,
  depth = 0,
  maxDepth = 5,
): Promise<void> {
  if (depth > maxDepth) return;
  try {
    const entries = await ctx.fs.readdir(dir);
    for (const name of entries) {
      if (name === '.git') continue;
      if (name === 'node_modules' && depth > 0) continue;
      const fp = dir + '/' + name;
      try {
        const st = await ctx.fs.stat(fp);
        if (st.isDirectory()) {
          fileMtimes.set(fp, st.mtime?.getTime?.() || Date.now());
          fileCache.set(fp + '/.', '');   // the directory exists, even when empty
          await preloadDir(ctx, fileCache, fileMtimes, fp, depth + 1, maxDepth);
        } else if (fileCache.has(fp)) {
          // already read in this run (the script's project root is walked again after the working directory)
        } else if (st.size < 16777216 && !_BINARY_EXT.test(fp) && _budgetLeft(fileCache) > st.size) { // 16MB limit
          const content = await ctx.fs.readFile(fp, 'utf8');
          fileCache.set(fp, content as string);
          _spend(fileCache, (content as string).length);
          fileMtimes.set(fp, st.mtime?.getTime?.() || Date.now());
        } else {
          fileMtimes.set(fp, st.mtime?.getTime?.() || Date.now());   // not read, but exists, stat and readdir still find it
          skippedSizes(fileMtimes).set(fp, st.size ?? 0);
        }
      } catch { /* skip */ }
    }
  } catch (e: any) {
    if (depth === 0 && !/no such file|ENOENT/i.test(e.message)) console.warn(`[preload] readdir('${dir}') FAILED: ${e.message}`);
  }
}

/**
 * Full environment initialization: repair dirs, replay WAL, create config dirs,
 * preload common locations, OAuth token refresh, node_modules preloading.
 */
export async function preloadEnvironment(
  ctx: CommandContext,
  fileCache: Map<string, string>,
  fileMtimes: Map<string, number>,
  scriptPath: string,
): Promise<void> {
  const homeDir = ctx.env['HOME'] || '/home/user';

  // Repair corrupted directory nodes
  for (const dirPath of ['/', '/home', homeDir, '/tmp']) {
    try {
      const st = await ctx.fs.stat(dirPath);
      if (!st.isDirectory()) {
        console.warn(`[init] Repairing corrupted dir node: ${dirPath}`);
        try { await ctx.fs.unlink(dirPath); } catch {}
        await ctx.fs.mkdir(dirPath, { recursive: true });
      }
    } catch {
      try { await ctx.fs.mkdir(dirPath, { recursive: true }); } catch {}
    }
  }
  try { await ctx.fs.mkdir(homeDir, { recursive: true }); } catch {}
  try { await ctx.fs.mkdir('/tmp', { recursive: true }); } catch {}

  // Replay localStorage WAL — recover config files that didn't flush to IndexedDB before page close
  try {
    const walKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('wal:')) walKeys.push(key);
    }
    let walReplayed = 0, walSkipped = 0;
    for (const key of walKeys) {
      const path = key.slice(4); // strip 'wal:' prefix
      if (path.includes('.tmp.')) {
        localStorage.removeItem(key);
        walSkipped++;
        continue;
      }
      const data = localStorage.getItem(key);
      if (data !== null) {
        const parentDir = path.substring(0, path.lastIndexOf('/'));
        try { await ctx.fs.mkdir(parentDir, { recursive: true }); } catch {}
        await ctx.fs.writeFile(path, data);
        walReplayed++;
      }
      localStorage.removeItem(key);
    }
    if (walReplayed || walSkipped) {
      console.warn(`[wal] Replayed ${walReplayed} files, skipped ${walSkipped} .tmp files`);
    }
  } catch (e: any) {
    console.warn(`[wal] Replay error: ${e.message}`);
  }

  // Clean up stale .tmp files from atomic writes (home dir + .claude dir)
  for (const cleanDir of [homeDir, homeDir + '/.claude']) {
    try {
      const entries = await ctx.fs.readdir(cleanDir);
      let tmpCleaned = 0;
      for (const name of entries) {
        if (name.includes('.tmp.')) {
          try { await ctx.fs.unlink(cleanDir + '/' + name); tmpCleaned++; } catch {}
        }
      }
      if (tmpCleaned) console.warn(`[init] Cleaned ${tmpCleaned} stale .tmp files from ${cleanDir}`);
    } catch {}
  }

  // Pre-load files from common locations
  const preloadDirs = [ctx.cwd];
  if (homeDir !== ctx.cwd) preloadDirs.push(homeDir);
  preloadDirs.push('/tmp');
  preloadDirs.push(homeDir + '/.claude');
  preloadDirs.push(homeDir + '/.config');

  for (const dir of preloadDirs) {
    await preloadDir(ctx, fileCache, fileMtimes, dir, 0, 5);
    try {
      const st = await ctx.fs.stat(dir);
      if (st.isDirectory()) {
        fileCache.set(dir + '/.', ''); // marker for directory existence
      }
    } catch { /* skip if dir doesn't exist */ }
  }

  // Explicitly preload critical CLI config files (safety net)
  const criticalFiles = [
    homeDir + '/.claude.json',
    homeDir + '/.claude/.credentials.json',
    homeDir + '/.claude/.config.json',
    homeDir + '/.claude/settings.json',
    homeDir + '/.claude/settings.local.json',
  ];
  for (const fp of criticalFiles) {
    if (!fileCache.has(fp)) {
      try {
        const content = await ctx.fs.readFile(fp, 'utf8');
        fileCache.set(fp, content as string);
      } catch { /* file doesn't exist yet, that's OK */ }
    }
  }

  console.log(`[node] ${fileCache.size} files preloaded`);

  // Pre-load node_modules — walk up from cwd
  let nmSearch = ctx.cwd;
  while (nmSearch) {
    const nmDir = nmSearch === '/' ? '/node_modules' : nmSearch + '/node_modules';
    try {
      const entries = await ctx.fs.readdir(nmDir);
      for (const name of entries) {
        await preloadDir(ctx, fileCache, fileMtimes, nmDir + '/' + name, 0, 10);
      }
    } catch { /* no node_modules at this level */ }
    const parent = nmSearch.substring(0, nmSearch.lastIndexOf('/')) || '';
    if (parent === nmSearch || !parent) break;
    nmSearch = parent;
  }

  // Pre-load global node_modules
  try {
    const globalNmDir = '/usr/local/lib/node_modules';
    const globalEntries = await ctx.fs.readdir(globalNmDir);
    for (const name of globalEntries) {
      await preloadDir(ctx, fileCache, fileMtimes, globalNmDir + '/' + name, 0, 10);
    }
  } catch { /* no global node_modules */ }

  // If running a script file, ensure its project directory is fully loaded
  if (scriptPath) {
    let projectRoot = scriptPath.substring(0, scriptPath.lastIndexOf('/')) || ctx.cwd;
    let searchDir = projectRoot;
    while (searchDir && searchDir !== homeDir && searchDir !== '/') {
      try {
        await ctx.fs.stat(searchDir + '/package.json');
        projectRoot = searchDir;
        break;
      } catch {
        const parentDir = searchDir.substring(0, searchDir.lastIndexOf('/')) || '';
        if (parentDir === searchDir || !parentDir) break;
        searchDir = parentDir;
      }
    }
    await preloadDir(ctx, fileCache, fileMtimes, projectRoot, 0, 10);
  }
}
