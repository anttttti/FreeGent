// shiro/utils/errors.ts — the one Node-style filesystem error constructor.

const ERRNO: Record<string, number> = {
  ENOENT: -2, EACCES: -13, EEXIST: -17, ENOTDIR: -20, EISDIR: -21, ENOTEMPTY: -39,
};

/** An Error with .code and .errno (and .syscall / .path when given), for Node.js and isomorphic-git compatibility. */
export function fsError(code: string, message: string, syscall?: string, path?: string): Error {
  const err = new Error(message) as Error & { code: string; errno: number; syscall?: string; path?: string };
  err.code = code;
  err.errno = ERRNO[code] ?? -1;
  if (syscall) err.syscall = syscall;
  if (path) err.path = path;
  return err;
}
