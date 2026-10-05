/**
 * wasi-packages.ts — WASM package registry and cache for Shiro
 *
 * Manages a registry of WASM+WASI binaries that can be downloaded on demand,
 * cached in IndexedDB, and executed through the WASI runtime.
 *
 * Uses the same IndexedDB caching pattern as build.ts (esbuild-wasm).
 */

import { compileWasm } from './wasm-module';
import { ARTIFACT_PINS } from './wasi-artifact-pins';
import type { FileSystem } from './filesystem';
import type { Command, CommandContext } from './commands/index';

// ── Package manifest types ───────────────────────────────────────────

export interface WasmPackage {
  /** Package name (used as command name) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Version string */
  version: string;
  /** Download URL for the WASM binary or webc container */
  url: string;
  /** Size in bytes (approximate, for display) */
  size: number;
  /** Category for search/display */
  category: 'utility' | 'language' | 'tool' | 'game' | 'coreutil';
  /** Command aliases (alternative names this package provides) */
  aliases?: string[];
  /** Format of the download: 'wasm' (raw binary) or 'webc' (wasmer container) */
  format?: 'wasm' | 'webc';
  /** Multi-call binary (uutils coreutils): the first argument selects the applet. Aliases are
   *  `g<applet>` names, and their PATH stubs pre-select that applet. */
  multicall?: boolean;
  /** Separate atoms selected by a declared first-argument entrypoint. */
  family?: boolean;
  /** Family launchers may delegate declared commands to separately pinned packages. */
  entrypoints?: string[];
  /** Audited WASI SDK build initializes libc cwd from the authoritative PWD. */
  initializesCwd?: boolean;
  /** Defaults needed to locate immutable package resources; users may override them. */
  resourceEnvironment?: Record<string,string>;
  /** Explicit applet prefixes; aliases never infer argv by string manipulation. */
  commandArgs?: Record<string, string[]>;
  /** Exact upstream command when a compatibility alias has a different name. */
  commandTargets?: Record<string,string>;
}

// ── Package manifest ─────────────────────────────────────────────────
// URLs point to cdn.wasmer.io webc containers. WASM is extracted at download time.
// Verified working as of 2025-06.

const PACKAGE_MANIFEST: WasmPackage[] = [
  {name:'hexdump',description:'util-linux hexdump (upstream WASI CLI)',version:'2.37.2-fg1',url:'/shiro/wasm/hexdump-2.37.2.wasm',size:426420,category:'utility',format:'wasm',initializesCwd:true},
  {name:'rev',description:'util-linux rev (upstream WASI CLI)',version:'2.37.2-fg1',url:'/shiro/wasm/rev-2.37.2.wasm',size:303780,category:'utility',format:'wasm',initializesCwd:true},
  {name:'cal',description:'BSD calendar (upstream WASI CLI)',version:'12.1.7-fg1',url:'/shiro/wasm/cal-12.1.7.wasm',size:389040,category:'utility',format:'wasm',initializesCwd:true},
  {name:'bc',description:'GNU bc (upstream WASI CLI)',version:'1.07.1',url:'/shiro/wasm/bc-1.07.1.wasm',size:360751,category:'tool',format:'wasm',initializesCwd:true},
  {name:'dc',description:'GNU dc (upstream WASI CLI)',version:'1.07.1',url:'/shiro/wasm/dc-1.07.1.wasm',size:334804,category:'tool',format:'wasm',initializesCwd:true},

  // ── Fun / Demo ───────────────────────────────────────────────────
  {
    name: 'cowsay',
    description: 'Generate ASCII pictures of a cow with a message',
    version: '0.3.0-fg1',
    url: '/shiro/wasm/cowsay-0.3.0-fg1.wasm',
    size: 432352,
    category: 'utility',
    format: 'wasm',
  },
  {
    name: 'fortune',
    description: 'Random fortune cookie messages',
    version: '0.2.0',
    url: 'https://cdn.wasmer.io/webcimages/59c02fd68e98da2c445ee8e97098aff1038ef7aa237601b2a099e734a99ef49d.webc',
    size: 2_417_000,
    category: 'utility',
    format: 'webc',
  },
  {
    name: 'lolcat',
    description: 'Rainbows and unicorns in your terminal',
    version: '0.2.0',
    url: 'https://cdn.wasmer.io/webcimages/b867558fee3734d9c77a9bdc38abcfc0793bfbad0e901639a192641d5a34bdb7.webc',
    size: 2_131_000,
    category: 'utility',
    format: 'webc',
  },
  {
    name: 'figlet',
    resourceEnvironment: {FIGLET_FONTDIR:'/fonts'},
    description: 'Create large ASCII text banners',
    version: '0.0.1',
    url: 'https://cdn.wasmer.io/webcimages/9fc959de4ce58c6c2bc11b8cbaa0a1a471bcde84a0fe341cffc25a42251d91c9.webc',
    size: 769_000,
    category: 'utility',
    format: 'webc',
  },
  // ── Core Utilities ───────────────────────────────────────────────
  {
    name: 'coreutils',
    description: 'Upstream uutils coreutils multicall (WASI)',
    version: 'a6d1eb3835c0f808fa9678e4551df7377bcab8d3',
    url: 'https://uutils.org/wasm/uutils.wasm',
    size: 12_964_555,
    category: 'coreutil',
    aliases: ['gls', 'gcat', 'ghead', 'gtail', 'gwc', 'gsort', 'guniq', 'gbase64', 'ghashsum'],
    format: 'wasm',
    multicall: true,
    commandArgs: { gls:['ls'], gcat:['cat'], ghead:['head'], gtail:['tail'], gwc:['wc'], gsort:['sort'], guniq:['uniq'], gbase64:['base64'], ghashsum:['sha256sum'] },
  },
  {
    name: 'grep',
    description: 'Search files for patterns (GNU grep)',
    version: '3.12.0',
    url: 'https://cdn.wasmer.io/webcimages/42a2dd5452990c94a51036cfb5eb9574899beccb5ce8f83f75995f7ac5e0e1ca.webc',
    size: 365_000,
    category: 'coreutil',
    aliases: ['wasm-grep'],
    commandTargets: { 'wasm-grep':'grep' },
    format: 'webc',
  },
  {
    name: 'sed',
    description: 'Stream editor for text transformation (GNU sed)',
    version: '4.9.0',
    url: 'https://cdn.wasmer.io/webcimages/3fc12256be87f6b8b7810d68d642359a6220f63b39a2ea6ef7a2bb6d79ec1393.webc',
    size: 263_000,
    category: 'coreutil',
    aliases: ['wasm-sed'],
    commandTargets: { 'wasm-sed':'sed' },
    format: 'webc',
  },
  {
    name:'jq', description:'jq JSON processor (upstream WASI CLI)', version:'1.8.2', initializesCwd:true,
    url:'/shiro/wasm/jq-1.8.2.wasm',size: 1535250,category:'tool',format:'wasm',
  },
  {
    name:'zstd', description:'Zstandard reference CLI (WASI, single thread)', version:'1.4.8', initializesCwd:true,
    url:'/shiro/wasm/zstd-1.4.8.wasm', size: 950591, category:'utility', format:'wasm',
    aliases:['unzstd','zstdcat'], commandTargets:{unzstd:'zstd',zstdcat:'zstd'},
    commandArgs:{unzstd:['-d'],zstdcat:['-dc']},
  },
  // ── Languages ────────────────────────────────────────────────────
  {
    name: 'quickjs',
    description: 'QuickJS JavaScript engine (standalone)',
    version: '0.0.3',
    url: 'https://cdn.wasmer.io/webcimages/430237aeffc912f4cd0981eb03ebad42a71d6b62781bd0c01903cae7d21b5733.webc',
    size: 2_565_000,
    category: 'language',
    aliases: ['qjs'],
    commandTargets: { qjs:'quickjs' },
    format: 'webc',
  },
  {
    name: 'lua',
    initializesCwd: true,
    description: 'Lua scripting language interpreter (upstream WASI CLI)',
    version: '5.3.6',
    url: '/shiro/wasm/lua-5.3.6.wasm',
    size: 646508,
    category: 'language',
    format: 'wasm',
  },
  // ── Tools ────────────────────────────────────────────────────────
  {
    name: 'sqlite',
    description: 'SQLite database command-line shell',
    version: '0.2.2',
    url: 'https://cdn.wasmer.io/webcimages/435044351ae60f7fd07ff97c1cac083f1e46d43bd9bc811b249bb376ee328725.webc',
    size: 3_576_000,
    category: 'tool',
    aliases: ['sqlite3'],
    commandTargets: { sqlite3:'sqlite' },
    format: 'webc',
  },
  {
    name: 'viu',
    description: 'View images in the terminal (PNG, JPG, GIF, BMP)',
    version: '0.2.3',
    url: 'https://cdn.wasmer.io/webcimages/b988b51ee1a395853fa402f37d69d1b379c4441b3bfca7372876098e13d4e3e9.webc',
    size: 3_066_000,
    category: 'tool',
    format: 'webc',
  },
  {
    name: 'util-linux',
    family: true,
    description: 'Linux utilities: hexdump, cal, rev, col',
    version: '0.0.1',
    url: 'https://cdn.wasmer.io/webcimages/3af9902aebda64554afa9b05c8726d3d183ba5c1ac57d902637e3894f3187c98.webc',
    size: 543_000,
    category: 'utility',
    aliases: ['hexdump', 'rev'],
    entrypoints: ['hexdump', 'cal', 'rev'],
    format: 'webc',
  },
  // ── Shells ──────────────────────────────────────────────────────────
  {
    name: 'dash',
    description: 'Debian Almquist shell (POSIX-compliant, fast)',
    version: '1.0.19',
    url: 'https://cdn.wasmer.io/webcimages/c81513a53f11a2a23ea305fa008049d15fa1b5f52b696cedbf63554077ea5998.webc',
    size: 335_000,
    category: 'tool',
    format: 'webc',
  },
  {
    name: 'bash',
    description: 'GNU Bourne-Again Shell',
    version: '1.0.25',
    url: 'https://cdn.wasmer.io/webcimages/059606d132e2e6bc1afe3b432ee64dcb1b1b059815c8bb213cf3b24798ef21e1.webc',
    size: 1_200_000,
    category: 'tool',
    format: 'webc',
  },
  // ── Languages (additional) ──────────────────────────────────────────
  {
    name: 'ruby',
    description: 'Ruby programming language interpreter',
    version: '0.1.2',
    url: 'https://cdn.wasmer.io/webcimages/036c313a707ffc5b70c700a9ac44e07bb76efe2797ef7f69c8f5d38fc6a080fc.webc',
    size: 34_300_000,
    category: 'language',
    aliases: ['irb'],
    commandTargets: { irb:'ruby' },
    commandArgs: { irb:['-rirb', '-e', 'IRB.start', '--'] },
    format: 'webc',
  },
  {
    name: 'php',
    description: 'PHP 8.3 scripting language interpreter',
    version: '8.3.403',
    url: 'https://cdn.wasmer.io/webcimages/da8d3fcfcf02d2401787532c4af3fdaf5b680b05144a9591ca70b97131ee2f32.webc',
    size: 10_000_000,
    category: 'language',
    format: 'webc',
  },
  // ── Developer Tools ─────────────────────────────────────────────────
  {
    name: 'openssl',
    description: 'Cryptographic toolkit (md5, sha256, base64, encryption)',
    version: '0.2.0',
    url: 'https://cdn.wasmer.io/webcimages/ac3a7fa2a57d384fa9e4b30c935a99fa323193cd1b7421bb899dfc2864ec43cc.webc',
    size: 1_600_000,
    category: 'tool',
    format: 'webc',
  },
  {
    name: 'wabt',
    family: true,
    description: 'WebAssembly Binary Toolkit: wat2wasm, wasm2wat, wasm-validate',
    version: '1.0.37',
    url: 'https://cdn.wasmer.io/webcimages/28b90a71338d161324ec4187d7afeb08df0eb98181e7e51c83f3f3f9a4cd1522.webc',
    size: 3_400_000,
    category: 'tool',
    aliases: ['wat2wasm', 'wasm2wat', 'wasm-validate', 'wasm-strip'],
    format: 'webc',
  },
  {
    name: 'brotli',
    description: 'Brotli compression and decompression',
    version: '0.0.1',
    url: 'https://cdn.wasmer.io/webcimages/824ad12803f95ed9a963f0e68df7ab3f1b875387f84417390ec73df52b3b2fb0.webc',
    size: 707_000,
    category: 'tool',
    format: 'webc',
  },
  {
    name: 'uuid',
    description: 'Generate UUIDs (v1, v4)',
    version: '0.3.0',
    url: 'https://cdn.wasmer.io/webcimages/bcfcf285510b75a47156a46c8103593a44047acf892114c83344138a0dc0effc.webc',
    size: 2_400_000,
    category: 'utility',
    format: 'webc',
  },
  {
    name: 'qr2text',
    description: 'Generate QR codes as ASCII text',
    version: '0.0.1',
    url: 'https://cdn.wasmer.io/webcimages/3741fc7486de905f87bcf8829557260473b0b789c0ec362d9374fd36f4fb62c6.webc',
    size: 499_000,
    category: 'utility',
    format: 'webc',
  },
  {
    name: 'optipng',
    description: 'PNG optimizer — lossless image compression',
    version: '0.1.2',
    url: 'https://cdn.wasmer.io/webcimages/ee84c20006bd67d128c67877c9ccaa8ba669a7cbd94ab225fafa241c5552ba8e.webc',
    size: 231_000,
    category: 'tool',
    format: 'webc',
  },
];

// ── IndexedDB cache ──────────────────────────────────────────────────

const PKG_CACHE_DB = 'shiro-pkg-cache';
const PKG_CACHE_STORE = 'packages';
const PKG_META_STORE = 'metadata';
const PKG_DB_VERSION = 1;

export interface PackageCacheRequest {
  op:'get'|'put'|'delete'|'keys'|'load'; store:'packages'|'metadata'; key?:string; value?:unknown;
}
let cacheTransport: ((request:PackageCacheRequest)=>Promise<any>) | null = null;
/** The opaque frame delegates only this public-artifact cache to the page. */
export function setPackageCacheTransport(transport:typeof cacheTransport): void { cacheTransport = transport; }

/** Page-side boundary: fixed database/stores, reviewed artifact identities, verified bytes. */
export async function handlePackageCacheRequest(request:PackageCacheRequest): Promise<unknown> {
  if (!request || !['get','put','delete','keys','load'].includes(request.op) || !['packages','metadata'].includes(request.store)) throw new Error('Package cache operation not allowed');
  const allowedKeys = new Map(PACKAGE_MANIFEST.flatMap(pkg => [[pkg.name,pkg],[artifactKey(pkg),pkg]] as const));
  if (request.op === 'keys') return (await idbGetAllKeys(request.store)).filter(key=>allowedKeys.has(key));
  if (typeof request.key !== 'string' || !allowedKeys.has(request.key)) throw new Error('Package cache key not allowed');
  const pkg = allowedKeys.get(request.key)!;
  if (request.store === 'metadata' && request.key !== pkg.name) throw new Error('Package metadata key not allowed');
  switch (request.op) {
    case 'load': {
      if (request.store !== 'packages' || request.key !== artifactKey(pkg) || !pkg.url.startsWith('/shiro/wasm/')) throw new Error('Only reviewed local package assets can be loaded');
      const bytes = await loadLocalArtifact(pkg);
      await verifyArtifact(bytes,ARTIFACT_PINS[pkg.name]);
      return bytes;
    }
    case 'get': return idbGet(request.store,request.key);
    case 'delete': await idbDelete(request.store,request.key); return true;
    case 'put': {
      if (request.store === 'packages') {
        if (request.key !== artifactKey(pkg) || !(request.value instanceof ArrayBuffer)) throw new Error('Package cache requires complete pinned artifact bytes');
        await verifyArtifact(request.value,ARTIFACT_PINS[pkg.name]);
        await idbPut(request.store,request.key,request.value);
      } else {
        const value = request.value as any;
        if (!value || value.name !== pkg.name || value.version !== pkg.version || value.artifact !== artifactKey(pkg) || value.size !== ARTIFACT_PINS[pkg.name].length || !Number.isFinite(value.installedAt)) throw new Error('Invalid package metadata');
        await idbPut(request.store,request.key,{name:pkg.name,version:pkg.version,artifact:artifactKey(pkg),size:value.size,installedAt:value.installedAt});
      }
      return true;
    }
  }
}

function openPkgDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PKG_CACHE_DB, PKG_DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PKG_CACHE_STORE)) {
        db.createObjectStore(PKG_CACHE_STORE);
      }
      if (!db.objectStoreNames.contains(PKG_META_STORE)) {
        db.createObjectStore(PKG_META_STORE);
      }
    };
  });
}

async function idbGet<T>(store: string, key: string): Promise<T | null> {
  if (cacheTransport) return cacheTransport({op:'get',store:store as PackageCacheRequest['store'],key});
  try {
    const db = await openPkgDB();
    return new Promise((resolve) => {
      const tx = db.transaction(store, 'readonly');
      const s = tx.objectStore(store);
      const req = s.get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
    });
  } catch {
    return null;
  }
}

async function idbPut(store: string, key: string, value: any): Promise<void> {
  if (cacheTransport) {await cacheTransport({op:'put',store:store as PackageCacheRequest['store'],key,value}); return;}
  try {
    const db = await openPkgDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const s = tx.objectStore(store);
      const req = s.put(value, key);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => {db.close(); resolve();};
      tx.onabort = () => {db.close(); reject(tx.error);};
    });
  } catch {
    // Non-fatal — cache miss next time
  }
}

async function idbDelete(store: string, key: string): Promise<void> {
  if (cacheTransport) {await cacheTransport({op:'delete',store:store as PackageCacheRequest['store'],key}); return;}
  try {
    const db = await openPkgDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const s = tx.objectStore(store);
      const req = s.delete(key);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => {db.close(); resolve();};
      tx.onabort = () => {db.close(); reject(tx.error);};
    });
  } catch {
    // Non-fatal
  }
}

async function idbGetAllKeys(store: string): Promise<string[]> {
  if (cacheTransport) return cacheTransport({op:'keys',store:store as PackageCacheRequest['store']});
  try {
    const db = await openPkgDB();
    return new Promise((resolve) => {
      const tx = db.transaction(store, 'readonly');
      const s = tx.objectStore(store);
      const req = s.getAllKeys();
      req.onsuccess = () => resolve((req.result as string[]) || []);
      req.onerror = () => resolve([]);
      tx.oncomplete = () => db.close();
    });
  } catch {
    return [];
  }
}

// ── WebC extraction ─────────────────────────────────────────────────

/** Extract only a declared atom after the caller verified the complete container hash. */
export function extractWasmFromWebc(webc:ArrayBuffer, atom:{offset:number; length:number}): ArrayBuffer | null {
  if (!Number.isSafeInteger(atom.offset) || !Number.isSafeInteger(atom.length) || atom.offset < 0 || atom.length < 8 || atom.offset + atom.length > webc.byteLength) return null;
  const binary = webc.slice(atom.offset,atom.offset + atom.length);
  return WebAssembly.validate(binary) ? binary : null;
}

// ── Public API ───────────────────────────────────────────────────────

/** Get package metadata from manifest by name or alias */
export function findPackage(name: string): WasmPackage | undefined {
  return PACKAGE_MANIFEST.find(
    p => p.name === name || p.aliases?.includes(name)
  );
}

/** One package command mapping, shared by discovery, installation and execution. */
export function resolvePackageCommand(name: string): { package: WasmPackage; atom:string; argv0: string; leadingArgs: string[] } | undefined {
  const pkg = findPackage(name);
  if (!pkg) return undefined;
  if (pkg.family && name === pkg.name) return undefined;
  const pin = ARTIFACT_PINS[pkg.name];
  const target = pkg.commandTargets?.[name] ?? (pkg.commandArgs?.[name] && pkg.multicall ? pkg.name : name);
  const atom = pin.commands[target] ?? (target === pkg.name && pin.atoms[target] ? target : undefined);
  return atom ? { package:pkg, atom, argv0:target, leadingArgs:[...(pkg.commandArgs?.[name] ?? [])] } : undefined;
}

export async function writePackageStubs(fs: FileSystem, name: string): Promise<void> {
  const pkg = findPackage(name);
  if (!pkg) throw new Error(`Unknown package: ${name}`);
  await fs.mkdir('/usr/local/bin', { recursive:true });
  for (const command of [pkg.name, ...(pkg.aliases ?? [])]) {
    if (!resolvePackageCommand(command) && !(pkg.family && command === pkg.name)) continue;
    const path = `/usr/local/bin/${command}`;
    if (await fs.exists(path)) {
      const current = await fs.readFile(path,'utf8');
      if (typeof current !== 'string' || !current.startsWith('#!wasi-pkg ') || findPackage(current.split('\n')[0].slice(11).split(/\s+/)[0])?.name !== pkg.name) throw new Error(`Package stub conflicts with existing executable: ${path}`);
    }
    await fs.writeFile(path, `#!wasi-pkg ${command}\n`,{mode:0o755});
    await fs.chmod(path,0o755);
  }
}

export async function removePackageStubs(fs: FileSystem, name: string): Promise<void> {
  const pkg = findPackage(name);
  if (!pkg) throw new Error(`Unknown package: ${name}`);
  for (const command of [pkg.name, ...(pkg.aliases ?? [])]) {
    const path = `/usr/local/bin/${command}`;
    try {
      // Never delete a user's executable just because its filename matches an alias.
      const content = await fs.readFile(path, 'utf8');
      if (typeof content === 'string' && content.startsWith('#!wasi-pkg ') && findPackage(content.split('\n')[0].slice(11).split(/\s+/)[0])?.name === pkg.name) await fs.unlink(path);
    } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  }
}

/** Integrity is checked before any offsets are trusted, including cached artifacts. */
export async function verifyArtifact(raw:ArrayBuffer, pin:{length:number; sha256:string}): Promise<void> {
  if (raw.byteLength !== pin.length) throw new Error(`Artifact length mismatch: expected ${pin.length}, received ${raw.byteLength}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256',raw));
  const hex = Array.from(hash,b => b.toString(16).padStart(2,'0')).join('');
  if (hex !== pin.sha256) throw new Error('Artifact SHA-256 mismatch');
}

function artifactKey(pkg: WasmPackage): string { return `${pkg.format ?? 'wasm'}:${pkg.name}@${pkg.version}:${ARTIFACT_PINS[pkg.name].sha256}`; }
const binaries = new Map<string, ArrayBuffer>();
const downloads = new Map<string, Promise<ArrayBuffer>>();
const compiling = new Map<string, Promise<WebAssembly.Module>>();
const resources = new Map<string,[string,Uint8Array][]>();

/** Search packages by query string (matches name and description) */
export function searchPackages(query: string): WasmPackage[] {
  const q = query.toLowerCase();
  return PACKAGE_MANIFEST.filter(
    p => p.name.includes(q) || p.description.toLowerCase().includes(q) ||
         p.category.includes(q) || (p.aliases || []).some(a => a.includes(q))
  );
}

/** List all available packages */
export function listAvailable(): WasmPackage[] {
  return [...PACKAGE_MANIFEST];
}

/** Get the cached complete pinned artifact. Returns null if not cached. */
export async function getCachedPackage(name: string): Promise<ArrayBuffer | null> {
  const pkg = findPackage(name);
  if (!pkg) return null;
  const key = artifactKey(pkg);
  return binaries.get(key) ?? await idbGet<ArrayBuffer>(PKG_CACHE_STORE, key);
}

/** Download and cache the complete pinned artifact, including all atoms/resources. */
export async function downloadPackage(
  name: string,
  onProgress?: (msg: string) => void,
): Promise<ArrayBuffer> {
  const pkg = findPackage(name);
  if (!pkg) {
    throw new Error(`Package '${name}' not found in registry`);
  }

  const key = artifactKey(pkg);
  let pending = downloads.get(key);
  if (!pending) {
    pending = downloadArtifact(pkg, onProgress).finally(() => downloads.delete(key));
    downloads.set(key, pending);
  }
  return pending;
}

/** Trusted manifest paths only; the opaque frame requests bytes through the existing cache RPC. */
async function loadLocalArtifact(pkg:WasmPackage):Promise<ArrayBuffer> {
  if (cacheTransport) return cacheTransport({op:'load',store:'packages',key:artifactKey(pkg)});
  if ((globalThis as any).process?.versions?.node) {
    const fsModule = 'node:fs/promises';
    const {readFile} = await import(/* @vite-ignore */ fsModule);
    const data = await readFile(new URL('../public'+pkg.url,import.meta.url));
    return data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength);
  }
  const response = await fetch(new URL(pkg.url,document.baseURI));
  if (!response.ok) throw new Error(`${pkg.name}: local artifact HTTP ${response.status}`);
  return response.arrayBuffer();
}

async function downloadArtifact(pkg: WasmPackage, onProgress?: (msg:string) => void): Promise<ArrayBuffer> {
  // Check cache first
  const cached = await getCachedPackage(pkg.name);
  if (cached) {
    try { await verifyArtifact(cached, ARTIFACT_PINS[pkg.name]); }
    catch (e) {
      binaries.delete(artifactKey(pkg));
      await idbDelete(PKG_CACHE_STORE,artifactKey(pkg));
      await idbDelete(PKG_META_STORE,pkg.name);
      throw e;
    }
    binaries.set(artifactKey(pkg), cached);
    onProgress?.(`${pkg.name} (cached)`);
    return cached;
  }

  // Download
  const size = ARTIFACT_PINS[pkg.name].length;
  const sizeStr = size > 1_000_000 ? `${(size / 1_000_000).toFixed(1)}MB` : `${(size / 1_000).toFixed(0)}KB`;
  onProgress?.(`Downloading ${pkg.name} v${pkg.version} (${sizeStr})...`);

  let raw:ArrayBuffer;
  if (pkg.url.startsWith('/shiro/wasm/')) raw = await loadLocalArtifact(pkg);
  else {
    const resp = await fetch(pkg.url);
    if (!resp.ok) throw new Error(`Failed to download ${pkg.name}: ${resp.status} ${resp.statusText}`);
    raw = await resp.arrayBuffer();
  }

  await verifyArtifact(raw, ARTIFACT_PINS[pkg.name]);
  const binary = raw;

  // Cache for next time
  binaries.set(artifactKey(pkg), binary);
  await idbPut(PKG_CACHE_STORE, artifactKey(pkg), binary);
  await idbPut(PKG_META_STORE, pkg.name, {
    name: pkg.name,
    version: pkg.version,
    installedAt: Date.now(),
    size: binary.byteLength,
    artifact: artifactKey(pkg),
  });

  onProgress?.(`Installed ${pkg.name} v${pkg.version}`);
  return binary;
}

/** Get package binary (from cache or download) */
export async function getPackage(
  name: string,
  onProgress?: (msg: string) => void,
): Promise<ArrayBuffer> {
  const mapping = resolvePackageCommand(name);
  if (!mapping) throw new Error(`Package command has no declared entrypoint: ${name}`);
  const raw = await downloadPackage(mapping.package.name, onProgress);
  const atom = ARTIFACT_PINS[mapping.package.name].atoms[mapping.atom];
  const binary = extractWasmFromWebc(raw,atom);
  if (!binary) throw new Error(`Invalid or unsupported WASM atom: ${mapping.atom}`);
  await verifyArtifact(binary,atom);
  return binary;
}

/** List installed (cached) packages with metadata */
export async function listInstalled(): Promise<Array<{ name: string; version: string; installedAt: number; size: number }>> {
  const keys = await idbGetAllKeys(PKG_META_STORE);
  const results: Array<{ name: string; version: string; installedAt: number; size: number }> = [];
  for (const key of keys) {
    const meta = await idbGet<{ name: string; version: string; installedAt: number; size: number }>(PKG_META_STORE, key);
    if (meta && (meta as any).artifact === (findPackage(meta.name) ? artifactKey(findPackage(meta.name)!) : null)) results.push(meta);
  }
  return results;
}

/** Remove a package from cache */
export async function removePackage(name: string): Promise<void> {
  const pkg = findPackage(name);
  if (!pkg) throw new Error(`Unknown package: ${name}`);
  if (downloads.has(artifactKey(pkg)) || [...compiling.keys()].some(k => k.startsWith(artifactKey(pkg) + ':'))) throw new Error(`Package ${pkg.name} is currently loading`);
  clearModuleCache(pkg.name);
  binaries.delete(artifactKey(pkg));
  resources.delete(artifactKey(pkg));
  await idbDelete(PKG_CACHE_STORE, artifactKey(pkg));
  await idbDelete(PKG_CACHE_STORE, pkg.name); // discard legacy name-only records
  await idbDelete(PKG_META_STORE, pkg.name);
}

/** Check if a command name matches an available package */
export function isAvailableAsPackage(cmdName: string): WasmPackage | undefined {
  return findPackage(cmdName);
}

// ── Compiled module cache ─────────────────────────────────────────

const moduleCache: Map<string, WebAssembly.Module> = new Map();

/**
 * Get a compiled WebAssembly.Module for a package (from memory cache or compile).
 * Caches the compiled module in memory for subsequent runs — skips compilation.
 */
export async function getCompiledModule(
  name: string,
  onProgress?: (msg: string) => void,
): Promise<WebAssembly.Module> {
  const pkg = findPackage(name);
  if (!pkg) throw new Error(`Unknown package: ${name}`);
  const mapping = resolvePackageCommand(name);
  if (!mapping) throw new Error(`Package command has no declared entrypoint: ${name}`);
  const key = artifactKey(pkg) + ':' + mapping.atom;
  const cached = moduleCache.get(key);
  if (cached) return cached;
  let pending = compiling.get(key);
  if (!pending) {
    pending = (async () => {
      const binary = await getPackage(name, onProgress);
      const module = await compileWasm(binary);
      moduleCache.set(key, module);
      return module;
    })().finally(() => compiling.delete(key));
    compiling.set(key, pending);
  }
  return pending;
}

/** Clear the compiled module cache (e.g., after package removal) */
export function clearModuleCache(name?: string): void {
  if (name) {
    const pkg = findPackage(name);
    if (pkg) for (const key of moduleCache.keys()) if (key.startsWith(artifactKey(pkg) + ':')) moduleCache.delete(key);
  } else {
    moduleCache.clear();
  }
}

async function packageResources(name:string): Promise<[string,Uint8Array][]> {
  const pkg = findPackage(name)!;
  const key = artifactKey(pkg);
  let files = resources.get(key);
  if (!files) {
    const raw = await downloadPackage(pkg.name);
    files = Object.entries(ARTIFACT_PINS[pkg.name].resources).map(([path,slice]) => [path,new Uint8Array(raw.slice(slice.offset,slice.offset + slice.length))]);
    resources.set(key,files);
  }
  return files;
}

/** One execution adapter for catalog commands, lazy packages, and installed PATH stubs. */
export async function runPackageCommand(ctx:CommandContext, name:string, args=ctx.args): Promise<number> {
  const pkg = findPackage(name);
  if (pkg?.family && name === pkg.name) {
    const entrypoints = pkg.entrypoints ?? pkg.aliases ?? [];
    const [entry,...rest] = args;
    if (!entry || !entrypoints.includes(entry) || !resolvePackageCommand(entry)) {
      ctx.stderr += `${name}: expected an entrypoint: ${entrypoints.join(', ')}\n`;
      return 2;
    }
    name = entry;
    args = rest;
  }
  const mapping = resolvePackageCommand(name);
  if (!mapping) throw new Error(`Package command has no declared entrypoint: ${name}`);
  const module = await getCompiledModule(name, ctx.shell.onProgress);
  await writePackageStubs(ctx.fs, mapping.package.name);
  const resourceFiles = await packageResources(mapping.package.name);
  const preopens:Record<string,string> = {'/':'/'};
  if (!mapping.package.initializesCwd) {
    preopens['.'] = ctx.cwd;
    // Older libc versions treat "." as a logical root. Explicit directory
    // preopens keep absolute workspace/runtime/resource paths unambiguous.
    for (const name of await ctx.fs.readdir('/')) {
      const path = '/' + name;
      if ((await ctx.fs.stat(path)).isDirectory()) preopens[path] = path;
    }
    for (const [path] of resourceFiles) {
      const root = '/' + path.split('/')[1];
      preopens[root] = root;
    }
  }
  return ctx.shell.execWasmModule(module, {
    fs:ctx.fs, cwd:ctx.cwd, env:{...mapping.package.resourceEnvironment,...ctx.env,PWD:ctx.cwd}, resources:resourceFiles,
    args:[mapping.argv0, ...mapping.leadingArgs, ...args], stdin:ctx.stdin,
    onStdout:s => {ctx.stdout += s;}, onStderr:s => {ctx.stderr += s;},
    preopens, trace:(globalThis as any).__fgWasiTrace,
  });
}

export function packageCommand(name:string, target=name): Command {
  const pkg = findPackage(target);
  if (!pkg) throw new Error(`Unknown package command: ${target}`);
  return {name, description:pkg.description, route:'wasm', requirements:['Worker','complete filesystem snapshot'], exec:ctx => runPackageCommand(ctx,target)};
}

/** A package containing separate programs requires a declared subcommand, not an arbitrary atom. */
export function packageFamilyCommand(name:string):Command {
  const pkg = findPackage(name);
  if (!pkg?.family) throw new Error(`Unknown package family: ${name}`);
  return {...packageCommand(name),route:'adapter'};
}
