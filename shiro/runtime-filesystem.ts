/** Shared filesystem primitives for Emscripten and Pyodide adapters. */
import type { FileSystem } from './filesystem.js';
import { textToBytes } from './utils/bytes.js';

/** Stage a complete requested tree, with explicit resource limits and link errors. */
export async function stageRuntimePath(
  FS:any, source:FileSystem, root:string,
  options:{mapPath?:(path:string)=>string; files?:Map<string,Uint8Array>; dirs?:Set<string>; visited?:Set<string>; allowMissing?:boolean} = {},
): Promise<boolean> {
  const files = options.files ?? new Map<string,Uint8Array>();
  const dirs = options.dirs ?? new Set<string>();
  const visited = options.visited ?? new Set<string>();
  const mapPath = options.mapPath ?? ((path:string) => path);
  let bytes = [...files.values()].reduce((total,data)=>total + data.length,0);
  const queue = [root];
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index];
    if (visited.has(path)) continue;
    let stat;
    try {stat = await source.lstat(path);} catch(error:any) {
      if (index === 0 && options.allowMissing && (error.code === 'ENOENT' || error.errno === 44 || /^ENOENT:/.test(error.message ?? ''))) return false;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Cannot stage symbolic link: ${path}`);
    if (visited.size >= 50_000) throw new Error(`Runtime snapshot exceeds file/directory limit: ${path}`);
    visited.add(path);
    const target = mapPath(path);
    if (stat.isDirectory()) {
      ensureRuntimeDir(FS,target); dirs.add(path);
      for (const name of await source.readdir(path)) queue.push(path.replace(/\/$/,'') + '/' + name);
    } else {
      if (bytes + stat.size > 256 * 1024 * 1024) throw new Error(`Runtime snapshot exceeds byte limit: ${path}`);
      const raw = await source.readFile(path);
      const data = typeof raw === 'string' ? textToBytes(raw) : raw;
      bytes += data.length;
      if (bytes > 256 * 1024 * 1024) throw new Error(`Runtime snapshot exceeds byte limit: ${path}`);
      ensureRuntimeDir(FS,target.slice(0,target.lastIndexOf('/')) || '/');
      FS.writeFile(target,data); files.set(path,data.slice());
    }
  }
  return true;
}

export function runtimeIsDirectory(FS:any, stat:any): boolean {
  return typeof stat.isDirectory === 'function' ? stat.isDirectory() : FS.isDir(stat.mode);
}

export function runtimeIsLink(FS:any, stat:any): boolean {
  return typeof stat.isSymbolicLink === 'function' ? stat.isSymbolicLink() : !!FS.isLink?.(stat.mode);
}

export function ensureRuntimeDir(FS:any, path:string): void {
  let current = '';
  for (const part of path.split('/').filter(Boolean)) {
    current += '/' + part;
    let stat:any;
    try {stat = FS.lstat(current);} catch (error:any) {
      if (error.errno !== 44 && !/ENOENT/.test(error.message ?? '')) throw error;
      FS.mkdir(current); continue;
    }
    if (!runtimeIsDirectory(FS,stat)) throw new Error(`ENOTDIR: ${current}`);
  }
}

/** Absolute file paths and exact bytes. Missing roots may be explicitly allowed. */
export function snapshotRuntimeFiles(FS:any, root:string, out=new Map<string,Uint8Array>(), allowMissingRoot=false): Map<string,Uint8Array> {
  let names:string[];
  try {names = FS.readdir(root);} catch (error:any) {
    if (allowMissingRoot && (error.errno === 44 || /ENOENT/.test(error.message ?? ''))) return out;
    throw error;
  }
  for (const name of names) {
    if (name === '.' || name === '..') continue;
    const path = root.replace(/\/$/,'') + '/' + name;
    const stat = FS.lstat(path);
    if (runtimeIsLink(FS,stat)) throw new Error(`Cannot synchronize symbolic link: ${path}`);
    if (runtimeIsDirectory(FS,stat)) snapshotRuntimeFiles(FS,path,out);
    else if (!FS.isFile || FS.isFile(stat.mode)) out.set(path,new Uint8Array(FS.readFile(path)));
  }
  return out;
}

export function clearRuntimeDir(FS:any, root:string): void {
  const cwd = FS.cwd?.();
  if (cwd === root || cwd?.startsWith(root.replace(/\/$/,'') + '/')) FS.chdir('/');
  let names:string[];
  try {names = FS.readdir(root);} catch (error:any) {
    if (error.errno === 44 || /ENOENT/.test(error.message ?? '')) return;
    throw error;
  }
  for (const name of names) {
    if (name === '.' || name === '..') continue;
    const path = root.replace(/\/$/,'') + '/' + name;
    const stat = FS.lstat(path);
    if (runtimeIsDirectory(FS,stat) && !runtimeIsLink(FS,stat)) {clearRuntimeDir(FS,path); FS.rmdir(path);}
    else FS.unlink(path);
  }
}
