// Path canonicalization shared by realpath and readlink (GNU canonicalize_filename_mode).
import type { FileSystem } from '../filesystem';

export type CanonMode = 'existing' | 'missing-last' | 'missing-ok';

/**
 * Resolve `path` against `cwd`: `.`/`..`/repeated slashes removed and, unless `symlinks` is false,
 * every symlink along the way followed.
 *  existing:     every component must exist (realpath -e, readlink -e)
 *  missing-last: all but the last may not be missing (realpath, readlink -f)
 *  missing-ok:   nothing has to exist (-m)
 * Returns the absolute path, or null when the mode's rule is broken.
 */
export async function canonicalize(fs: FileSystem, cwd: string, path: string, mode: CanonMode, symlinks = true): Promise<string | null> {
  const todo = (path.startsWith('/') ? path : cwd.replace(/\/+$/, '') + '/' + path).split('/').filter(Boolean);
  const done: string[] = [];
  let hops = 0;
  const isDir = async (p: string) => { try { return (await fs.stat(p)).isDirectory(); } catch { return false; } };
  const exists = async (p: string) => { try { await fs.lstat(p); return true; } catch { return false; } };
  while (todo.length) {
    const part = todo.shift()!;
    if (part === '.') continue;
    if (part === '..') {
      if (mode === 'missing-ok' || !symlinks) { done.pop(); continue; }
      done.pop();
      continue;
    }
    const candidate = '/' + [...done, part].join('/');
    let target: string | null = null;
    if (symlinks) {
      try {
        if ((await fs.lstat(candidate)).isSymbolicLink()) target = await fs.readlink(candidate);
      } catch { /* not there */ }
    }
    if (target !== null) {
      if (++hops > 40) return null;                       // too many levels of symbolic links
      if (target.startsWith('/')) done.length = 0;
      todo.unshift(...target.split('/').filter(Boolean));
      continue;
    }
    const found = await exists(candidate);
    const last = todo.length === 0;
    if (!found) {
      if (mode === 'existing' || (mode === 'missing-last' && !last)) return null;
    } else if (!last && !(await isDir(candidate))) {
      if (mode !== 'missing-ok') return null;             // a file in the middle of the path
    }
    done.push(part);
  }
  return '/' + done.join('/');
}

/** `path` relative to `base` (both absolute and canonical). */
export function relativeTo(path: string, base: string): string {
  const p = path.split('/').filter(Boolean), b = base.split('/').filter(Boolean);
  let i = 0;
  while (i < p.length && i < b.length && p[i] === b[i]) i++;
  const rel = [...b.slice(i).map(() => '..'), ...p.slice(i)].join('/');
  return rel || '.';
}
