/**
 * wasi-runtime.ts — Standalone WASI runtime for Shiro
 *
 * Implements WASI preview1 (wasi_snapshot_preview1) system calls sufficient
 * to run WASM-compiled C/Rust/Go programs against Shiro's virtual filesystem.
 *
 * Design:
 *   - ShiroFS adapter bridges WASI fd operations to Shiro's async FileSystem
 *   - Streaming stdout/stderr callbacks (no buffering unless caller wants it)
 *   - Pre-opened directories (/home/user, /tmp) via preopens
 *   - Synchronous fd table with async pre-loading for files
 */

import type { FileSystem } from './filesystem';
import { bytesToText, textToBytes } from './utils/bytes';
import { memoryImports } from './wasm-module';

// ── WASI errno constants ─────────────────────────────────────────────

export const WASI_ESUCCESS      = 0;
export const WASI_E2BIG         = 1;
export const WASI_EACCES        = 2;
export const WASI_EADDRINUSE    = 3;
export const WASI_EBADF         = 8;
export const WASI_EEXIST        = 20;
export const WASI_EFAULT        = 21;
export const WASI_EINVAL        = 28;
export const WASI_EIO           = 29;
export const WASI_EISDIR        = 31;
export const WASI_ELOOP         = 32;
export const WASI_ENAMETOOLONG  = 37;
export const WASI_ENOENT        = 44;
export const WASI_ENOSYS        = 52;
export const WASI_ENOTDIR       = 54;
export const WASI_ENOTEMPTY     = 55;
export const WASI_EPERM         = 63;
export const WASI_EAGAIN        = 6;
export const WASI_ECHILD        = 12;
export const WASI_EOVERFLOW     = 61;
export const WASI_ESPIPE        = 70;
export const WASI_ENOTCAPABLE   = 76;

// ── WASI filetype constants ──────────────────────────────────────────

export const WASI_FILETYPE_UNKNOWN          = 0;
export const WASI_FILETYPE_BLOCK_DEVICE     = 1;
export const WASI_FILETYPE_CHARACTER_DEVICE = 2;
export const WASI_FILETYPE_DIRECTORY        = 3;
export const WASI_FILETYPE_REGULAR_FILE     = 4;
export const WASI_FILETYPE_SYMBOLIC_LINK    = 7;

// ── WASI fd flags / rights ───────────────────────────────────────────

export const WASI_FDFLAG_APPEND   = 1;
export const WASI_FDFLAG_DSYNC    = 2;
export const WASI_FDFLAG_NONBLOCK = 4;
export const WASI_FDFLAG_SYNC     = 16;

/** Every right bit defined by preview1 (0..28). Preopens and opened files advertise all of them so
 *  libc never refuses an open on capability grounds; real access control is the filesystem's. */
export const WASI_RIGHTS_ALL              = (1n << 29n) - 1n;
export const WASI_RIGHT_FD_READ             = 1n << 1n;
export const WASI_RIGHT_FD_WRITE            = 1n << 6n;
export const WASI_RIGHT_FD_SEEK             = 1n << 2n;
export const WASI_RIGHT_FD_TELL             = 1n << 5n;
export const WASI_RIGHT_FD_FILESTAT_GET     = 1n << 21n;
export const WASI_RIGHT_PATH_OPEN           = 1n << 8n;
export const WASI_RIGHT_PATH_CREATE_FILE    = 1n << 9n;
export const WASI_RIGHT_PATH_CREATE_DIR     = 1n << 10n;
export const WASI_RIGHT_PATH_READDIR        = 1n << 14n;

// oflags
export const WASI_O_CREAT     = 1;
export const WASI_O_DIRECTORY = 2;
export const WASI_O_EXCL      = 4;
export const WASI_O_TRUNC     = 8;

// whence
export const WASI_WHENCE_SET = 0;
export const WASI_WHENCE_CUR = 1;
export const WASI_WHENCE_END = 2;

// clock IDs
export const WASI_CLOCK_REALTIME  = 0;
export const WASI_CLOCK_MONOTONIC = 1;

// ── WasiExit — thrown to exit a WASM program ─────────────────────────

export class WasiExit extends Error {
  // @ts-ignore -- Error.code is string in @types/node; we use number here
  declare code: number;
  constructor(code: number) {
    super(`WASI exit with code ${code}`);
    this.name = 'WasiExit';
    this.code = code;
  }
}

/** Which argument pair (pointer, length) of a call is a path, for the debug trace. */
const PATH_ARGS: Record<string, [number, number]> = {
  path_open: [2, 3], path_open2: [2, 3], path_filestat_get: [2, 3], path_readlink: [2, 3],
  fd_prestat_dir_name: [1, 2], path_create_directory: [1, 2], path_unlink_file: [1, 2], path_remove_directory: [1, 2], chdir: [0, 1],
};

/** Stable pseudo inode number for a path (FNV-1a, 52 bits; never collides with the small stdio numbers). */
function inodeFor(path: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < path.length; i++) h = ((h ^ BigInt(path.charCodeAt(i))) * 0x100000001b3n) & 0xffffffffffffffffn;
  return (h & 0xfffffffffffffn) | 0x100000n;
}

/** A program asking to be replaced by another (exec): what to run, and what it sees. */
export interface ExecRequest {
  argv: string[]; env: Record<string, string>; cwd: string; stdin: string;
  /** a Worker run sends, so that the host sees them before the new program runs: its unflushed file changes ... */
  writes?: WasiWrites;
  /** ... and what it has cached, so that the host can report what the new program changed */
  known?: [string, number, number][];
  dirs?: string[];
}
/** Files and directory listings that changed behind a run's back (written by a program it exec'd). */
export interface FsUpdates {
  files: [string, Uint8Array | null, { type: string; size: number; mtime: number }][];
  dirs: [string, string[]][];
}
export interface ExecResult { stdout: string; stderr: string; code: number; updates?: FsUpdates }
/** Thrown out of a program that called exec: it ends there and the driver runs the new program. */
export class ExecSignal { constructor(public req: ExecRequest) {} }

// ── File descriptor abstraction ──────────────────────────────────────

/** In-memory byte pipe shared by the two ends created by fd_pipe. */
export interface PipeState { data: Uint8Array; len: number; readPos: number; writers: number }

export class FD {
  /** Absolute path in Shiro's virtual filesystem (null for stdio) */
  path: string | null;
  /** File type */
  filetype: number;
  /** Buffered content for regular files */
  data: Uint8Array;
  /** Current seek position */
  offset: number = 0;
  /** Whether this fd is writable */
  writable: boolean;
  /** Whether this fd is a preopen directory */
  preopen: string | null = null;
  /** Rights bitmask */
  rights: bigint;
  /** Whether this fd has been modified (needs writeback) */
  dirty: boolean = false;
  /** Open descriptors sharing this object (fd_dup); resources are released when it drops to 0 */
  refs: number = 1;
  /** O_APPEND: every write goes to the end */
  append = false;
  /** /dev/null, /dev/zero, /dev/urandom: no data of their own */
  device: 'null' | 'zero' | 'random' | null = null;
  /** Set on the two ends of a pipe (fd_pipe) */
  pipe: { state: PipeState; end: 'r' | 'w' } | null = null;

  constructor(opts: {
    path: string | null;
    filetype: number;
    data?: Uint8Array;
    writable?: boolean;
    preopen?: string;
    rights?: bigint;
  }) {
    this.path = opts.path;
    this.filetype = opts.filetype;
    this.data = opts.data || new Uint8Array(0);
    this.writable = opts.writable ?? false;
    this.preopen = opts.preopen ?? null;
    this.rights = opts.rights ?? 0n;
  }

  /** Read up to `len` bytes from current offset */
  read(len: number): Uint8Array {
    const slice = this.data.slice(this.offset, this.offset + len);
    this.offset += slice.length;
    return slice;
  }

  /** Write bytes at current offset, growing buffer if needed */
  write(bytes: Uint8Array): number {
    if (this.append) this.offset = this.data.length;
    const needed = this.offset + bytes.length;
    if (needed > this.data.length) {
      const grown = new Uint8Array(needed);
      grown.set(this.data);
      this.data = grown;
    }
    this.data.set(bytes, this.offset);
    this.offset += bytes.length;
    this.dirty = true;
    return bytes.length;
  }

  /** Seek to position */
  seek(offset: bigint, whence: number): bigint {
    let base: number;
    switch (whence) {
      case WASI_WHENCE_SET: base = 0; break;
      case WASI_WHENCE_CUR: base = this.offset; break;
      case WASI_WHENCE_END: base = this.data.length; break;
      default: base = 0;
    }
    this.offset = base + Number(offset);
    if (this.offset < 0) this.offset = 0;
    return BigInt(this.offset);
  }
}

// ── Path normalization ───────────────────────────────────────────────

export function normPath(p: string): string {
  const parts = p.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return '/' + stack.join('/');
}

// ── WasiRT: the WASI runtime ────────────────────────────────────────

export interface WasiConfig {
  /** Shiro filesystem instance */
  fs: FileSystem;
  /** Working directory */
  cwd: string;
  /** Program arguments (argv[0] = program name) */
  args: string[];
  /** Environment variables */
  env: Record<string, string>;
  /** Stdin data */
  stdin?: string;
  /** Callback for stdout writes */
  onStdout?: (data: string) => void;
  /** Callback for stderr writes */
  onStderr?: (data: string) => void;
  /** Run another program for exec(): provided by the host shell. Without it exec fails. */
  exec?: (req: ExecRequest) => Promise<ExecResult>;
  /** Names of the commands the host can run: shown to the program as executables under /usr/bin etc. */
  commands?: string[];
  /** Debug: called with one line per WASI/WASIX call ("name(args) = errno") */
  trace?: (line: string) => void;
  /** Pre-opened directories: map of guest path → host path */
  preopens?: Record<string, string>;
}

/** Plain-data snapshot of a program run (structured-cloneable, so it can go to a Worker). */
export interface WasiJob {
  cwd: string;
  args: string[];
  env: Record<string, string>;
  stdin: string;
  preopens?: Record<string, string>;
  files: [string, Uint8Array, { type: string; size: number; mtime: number }][];
  dirs: [string, string[]][];
  /** Limits of the memory the module imports, if any (see wasm-module.ts) */
  memory?: { initial: number; maximum: number | undefined };
  commands?: string[];
}

export interface WasiWrites {
  closedDirty: { path: string; data: Uint8Array }[];
  deferredOps: unknown[];
}

export class WasiRT {
  private fds: Map<number, FD> = new Map();
  private nextFd: number = 3;
  private stdinFd!: FD;
  private stdoutFd!: FD;
  private stderrFd!: FD;
  private config: WasiConfig;
  private stdoutBuf: string = '';
  private stderrBuf: string = '';
  private memory!: WebAssembly.Memory;
  private instance!: WebAssembly.Instance;

  constructor(config: WasiConfig) {
    this.config = config;

    // fd 0 = stdin
    // Program output is captured and input arrives from a pipe or file, so stdio is not a terminal:
    // report "unknown" (what a pipe is) rather than character device, or isatty() says yes and tools
    // such as brotli refuse to read or write. Bytes round-trip exactly (see utils/bytes.ts).
    const stdinData = textToBytes(config.stdin || '');
    this.stdinFd = new FD({
      path: null,
      filetype: WASI_FILETYPE_UNKNOWN,
      data: stdinData,
      writable: false,
      rights: WASI_RIGHT_FD_READ,
    });
    this.fds.set(0, this.stdinFd);

    // fd 1 = stdout, fd 2 = stderr. Writes are recognised by the FD object, not the number, so a
    // pipe dup2'd onto fd 1 (shell pipelines) gets the output instead.
    this.stdoutFd = new FD({ path: null, filetype: WASI_FILETYPE_UNKNOWN, writable: true, rights: WASI_RIGHT_FD_WRITE });
    this.fds.set(1, this.stdoutFd);
    this.stderrFd = new FD({ path: null, filetype: WASI_FILETYPE_UNKNOWN, writable: true, rights: WASI_RIGHT_FD_WRITE });
    this.fds.set(2, this.stderrFd);

    // Set up preopens (directories the WASM module can access)
    const preopens = config.preopens || { '/': '/', '.': config.cwd };
    for (const [guestPath, hostPath] of Object.entries(preopens)) {
      const fd = this.nextFd++;
      this.fds.set(fd, new FD({
        path: hostPath,
        filetype: WASI_FILETYPE_DIRECTORY,
        writable: true,
        preopen: guestPath,
        rights: WASI_RIGHTS_ALL,
      }));
    }
  }

  /** Get the stdout output collected so far */
  get stdout(): string { return this.stdoutBuf; }

  /** Get the stderr output collected so far */
  get stderr(): string { return this.stderrBuf; }

  /** Build the WASI import object for WebAssembly.instantiate */
  getImports(module?: WebAssembly.Module): WebAssembly.Imports {
    const preview1 = {
        args_get: this.args_get.bind(this),
        args_sizes_get: this.args_sizes_get.bind(this),
        environ_get: this.environ_get.bind(this),
        environ_sizes_get: this.environ_sizes_get.bind(this),
        clock_time_get: this.clock_time_get.bind(this),
        clock_res_get: this.clock_res_get.bind(this),
        fd_advise: this.fd_advise.bind(this),
        fd_allocate: this.fd_allocate.bind(this),
        fd_close: this.fd_close.bind(this),
        fd_datasync: this.fd_datasync.bind(this),
        fd_fdstat_get: this.fd_fdstat_get.bind(this),
        fd_fdstat_set_flags: this.fd_fdstat_set_flags.bind(this),
        fd_filestat_get: this.fd_filestat_get.bind(this),
        fd_filestat_set_size: this.fd_filestat_set_size.bind(this),
        fd_filestat_set_times: this.fd_filestat_set_times.bind(this),
        fd_pread: this.fd_pread.bind(this),
        fd_prestat_get: this.fd_prestat_get.bind(this),
        fd_prestat_dir_name: this.fd_prestat_dir_name.bind(this),
        fd_pwrite: this.fd_pwrite.bind(this),
        fd_read: this.fd_read.bind(this),
        fd_renumber: this.fd_renumber.bind(this),
        fd_readdir: this.fd_readdir.bind(this),
        fd_seek: this.fd_seek.bind(this),
        fd_sync: this.fd_sync.bind(this),
        fd_tell: this.fd_tell.bind(this),
        fd_write: this.fd_write.bind(this),
        path_create_directory: this.path_create_directory.bind(this),
        path_filestat_get: this.path_filestat_get.bind(this),
        path_filestat_set_times: this.path_filestat_set_times.bind(this),
        path_link: this.path_link.bind(this),
        path_open: this.path_open.bind(this),
        path_readlink: this.path_readlink.bind(this),
        path_remove_directory: this.path_remove_directory.bind(this),
        path_rename: this.path_rename.bind(this),
        path_symlink: this.path_symlink.bind(this),
        path_unlink_file: this.path_unlink_file.bind(this),
        poll_oneoff: this.poll_oneoff.bind(this),
        proc_exit: this.proc_exit.bind(this),
        proc_raise: this.proc_raise.bind(this),
        random_get: this.random_get.bind(this),
        sched_yield: this.sched_yield.bind(this),
        sock_accept: this.sock_accept.bind(this),
        sock_recv: this.sock_recv.bind(this),
        sock_send: this.sock_send.bind(this),
        sock_shutdown: this.sock_shutdown.bind(this),
    };
    // `wasi_unstable` is WASI snapshot 0, the pre-release API that older toolchains still emit.
    // Most calls match preview1; seek's whence numbering and the filestat layout do not.
    const unstable = {
      ...preview1,
      // snapshot 0: cur=0, end=1, set=2  ->  preview1: set=0, cur=1, end=2
      fd_seek: (fd: number, off: bigint, whence: number, ptr: number) => this.fd_seek(fd, off, [1, 2, 0][whence] ?? whence, ptr),
      fd_filestat_get: (fd: number, ptr: number) =>
        this.withFilestatLayout0(ptr, () => this.fd_filestat_get(fd, 0)),
      path_filestat_get: (dirFd: number, flags: number, pathPtr: number, pathLen: number, ptr: number) =>
        this.withFilestatLayout0(ptr, () => this.path_filestat_get(dirFd, flags, pathPtr, pathLen, 0)),
    };
    // WASIX (wasix_32v1) is preview1 plus POSIX-ish extensions; some toolchains import even the
    // basic calls from this namespace. Only the single-process subset can work here.
    const wasix: Record<string, Function> = { ...preview1, ...this.wasixCalls() };
    const imports: WebAssembly.Imports = { wasi_snapshot_preview1: preview1, wasi_unstable: unstable, wasix_32v1: wasix };
    if (module) {
      // imports not implemented above fail with ENOSYS instead of failing to instantiate
      for (const imp of WebAssembly.Module.imports(module)) {
        if (imp.kind !== 'function') continue;
        const ns = (imports[imp.module] ??= {}) as Record<string, Function>;
        ns[imp.name] ??= () => WASI_ENOSYS;
      }
      if (this.config.trace) {
        const trace = this.config.trace;
        for (const [nsName, ns] of Object.entries(imports)) {
          for (const [fname, fn] of Object.entries(ns)) {
            if (typeof fn !== 'function') continue;
            (ns as Record<string, unknown>)[fname] = (...a: unknown[]) => {
              try {
                const r = (fn as Function)(...a);
                const at = PATH_ARGS[fname];
                let path = '';
                if (at && this.memory) { try { path = ' "' + this.getString(a[at[0]] as number, a[at[1]] as number) + '"'; } catch { /* trace only */ } }
                trace(`${nsName === 'wasix_32v1' ? 'wasix.' : ''}${fname}(${a.map(v => (typeof v === 'bigint' ? v + 'n' : v)).join(',')})${path} = ${r}`);
                return r;
              } catch (e: any) { trace(`${fname}(${a.join(',')}) threw ${e?.name ?? e}`); throw e; }
            };
          }
        }
      }
      const mem = WebAssembly.Module.imports(module).find(i => i.kind === 'memory');
      if (mem) {
        const want = memoryImports.get(module);
        const initial = want?.initial ?? 256;
        // Linear memory is virtual: cap the maximum so a 4 GiB reservation cannot fail
        const memory = new WebAssembly.Memory({ initial, maximum: Math.min(want?.maximum ?? 16384, 16384) });
        ((imports[mem.module] ??= {}) as Record<string, unknown>)[mem.name] = memory;
        this.importedMemory = memory;
      }
    }
    return imports;
  }

  private importedMemory: WebAssembly.Memory | null = null;
  /** paths that were really preloaded from the filesystem (as opposed to the virtual command stubs) */
  private realFiles = new Set<string>();
  private slashRelativeToDotPreopen = false;
  private cwdPath = '/';

  /** True in a Worker, where there is no filesystem: file changes cross to the host as messages. */
  private remote = false;

  /** Take the file changes made so far, leaving none pending (they are about to be applied by the host). */
  private takePendingWrites(): WasiWrites {
    const w = this.takeWrites();
    this.closedDirtyFds = [];
    this.deferredOps = [];
    for (const f of this.fds.values()) f.dirty = false;
    return w;
  }

  private knownFiles(): [string, number, number][] {
    const out: [string, number, number][] = [];
    for (const [path, e] of this.fileCache) if (e.stat.type === 'file' && this.realFiles.has(path)) out.push([path, e.stat.size, e.stat.mtime]);
    return out;
  }

  /**
   * Host side: what changed in the filesystem among the files and directories a run has cached
   * (a program it exec'd may have created, rewritten or removed any of them).
   */
  async computeUpdates(known: [string, number, number][], dirs: string[]): Promise<FsUpdates> {
    const fs = this.config.fs;
    const updates: FsUpdates = { files: [], dirs: [] };
    const have = new Set(known.map(k => k[0]));
    let budget = 300;
    const send = async (path: string) => {
      const st = await fs.stat(path);
      if (st.type !== 'file' || st.size > (1 << 22) || budget-- <= 0) return;
      const raw = await fs.readFile(path);
      const data = typeof raw === 'string' ? textToBytes(raw) : raw;
      updates.files.push([path, data, { type: 'file', size: data.length, mtime: st.mtime.getTime() }]);
    };
    for (const [path, size, mtime] of known) {
      try {
        const st = await fs.stat(path);
        if (st.size !== size || st.mtime.getTime() !== mtime) await send(path);
      } catch { updates.files.push([path, null, { type: 'file', size: 0, mtime: 0 }]); }
    }
    for (const dir of dirs) {
      try {
        const names = await fs.readdir(dir);
        updates.dirs.push([dir, names]);
        for (const n of names) {                      // files that appeared
          const path = dir === '/' ? '/' + n : dir + '/' + n;
          if (!have.has(path)) { have.add(path); try { await send(path); } catch { /* vanished */ } }
        }
      } catch { /* the directory is gone */ }
    }
    return updates;
  }

  /** Worker side: take over what the host reports. */
  private applyUpdates(u: FsUpdates) {
    for (const [path, data, stat] of u.files) {
      const slash = path.lastIndexOf('/');
      const parent = slash <= 0 ? '/' : path.slice(0, slash);
      const name = path.slice(slash + 1);
      if (data === null) {
        this.fileCache.delete(path);
        const l = this.dirCache.get(parent);
        if (l) { const i = l.indexOf(name); if (i >= 0) l.splice(i, 1); }
      } else {
        this.fileCache.set(path, { data, stat });
        this.realFiles.add(path);
      }
    }
    for (const [dir, names] of u.dirs) {
      this.dirCache.set(dir, names);
      if (!this.fileCache.has(dir)) this.fileCache.set(dir, { data: new Uint8Array(0), stat: { type: 'dir', size: 0, mtime: Date.now() } });
    }
  }

  /** exec(): resolve the command, then end this program by throwing; the driver runs the replacement. */
  private execCall(namePtr: number, nameLen: number, argsPtr: number, argsLen: number, envPtr: number, envLen: number, _search: number, _pathLen: number): number {
    const name = this.getString(namePtr, nameLen);
    const list = (ptr: number, len: number) => (len ? this.getString(ptr, len).split(/\n|\0/).filter((x, i, a) => x !== '' || i < a.length - 1) : []);
    let argv = list(argsPtr, argsLen);
    if (argv.length === 0) argv = [name];
    const env: Record<string, string> = envLen ? {} : { ...this.config.env };
    for (const kv of list(envPtr, envLen)) { const eq = kv.indexOf('='); if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1); }
    // the name must be something the host can run: a known command, or a file that exists
    const base = name.slice(name.lastIndexOf('/') + 1);
    const known = (this.config.commands ?? []).includes(base) || this.fileCache.has(name.startsWith('/') ? name : normPath(this.cwdPath + '/' + name));
    if (!known) return WASI_ENOENT;
    argv = argv.slice();
    // a virtual /usr/bin/ls is just the host's `ls`; a real file (a package stub, a script) runs by path
    const inBin = /^\/(usr\/local\/bin|usr\/bin|bin)\/[^/]+$/.test(name);
    argv[0] = inBin && (this.config.commands ?? []).includes(base) && !this.realFiles.has(name) ? base : name;
    throw new ExecSignal({ argv, env, cwd: this.cwdPath, stdin: '' });
  }

  /** Show the host's commands as executables under /usr/bin, /bin and /usr/local/bin, so a program that searches PATH finds them. */
  installVirtualCommands() {
    const names = this.config.commands;
    if (!names?.length) return;
    for (const k of this.fileCache.keys()) this.realFiles.add(k);
    const now = 0;
    for (const dir of ['/usr/local/bin', '/usr/bin', '/bin']) {
      if (!this.fileCache.has(dir)) this.fileCache.set(dir, { data: new Uint8Array(0), stat: { type: 'dir', size: 0, mtime: now } });
      const entries = this.dirCache.get(dir) ?? [];
      for (const n of names) {
        const path = `${dir}/${n}`;
        if (this.fileCache.has(path)) continue;
        const data = new TextEncoder().encode(`#!shiro ${n}\n`);
        this.fileCache.set(path, { data, stat: { type: 'file', size: data.length, mtime: now } });
        if (!entries.includes(n)) entries.push(n);
      }
      this.dirCache.set(dir, entries);
    }
    for (const dir of ['/usr', '/usr/local']) if (!this.fileCache.has(dir)) this.fileCache.set(dir, { data: new Uint8Array(0), stat: { type: 'dir', size: 0, mtime: now } });
  }

  // ── setjmp/longjmp: WASIX stack_checkpoint / stack_restore on top of Binaryen asyncify ──
  //
  // A checkpoint unwinds the whole guest stack into a buffer (asyncify), saves a copy, and rewinds
  // straight back so the program carries on. A restore unwinds the current stack, loads the saved
  // copy into the buffer and rewinds into it, so execution resumes after the checkpoint call with
  // the restore value. asyncify does not save the shadow stack pointer, so it is kept alongside.
  private asyncifyData = 0;                      // address of the {pos, end} header + buffer
  private asyncifySize = 0;
  private snapshots = new Map<number, { stack: Uint8Array; sp: number }>();
  private nextSnapshot = 1;
  private pendingUnwind:
    | { kind: 'checkpoint'; snapPtr: number; sp: number }
    | { kind: 'restore'; snap: { stack: Uint8Array; sp: number }; val: bigint }
    | { kind: 'fork'; copyMemory: boolean }
    | null = null;
  private rewindValue = 0n;

  // ── processes: fork runs the child first, in this same instance, then resumes the parent ──
  //
  // proc_fork unwinds the program (asyncify) and snapshots its memory, globals and descriptor table.
  // The child is rewound from the fork point (it sees pid 0) and runs until it exits or execs, on its
  // own copy of the descriptor table; then memory and descriptors are put back and the parent is
  // rewound with the child's pid. Pipes are in-memory buffers, so a child that is run to completion
  // before its parent continues still feeds a pipe that the parent (or a later child) reads.
  private proc = { pid: 2, ppid: 1, children: new Map<number, number>() };
  private nextPid = 3;
  private forkResult = 0;

  private asyncifyExports() {
    const ex = this.instance.exports as Record<string, any>;
    if (!ex.asyncify_start_unwind || !ex.asyncify_stop_unwind || !ex.asyncify_start_rewind ||
        !ex.asyncify_stop_rewind || !ex.asyncify_get_state || !ex.__stack_pointer) return null;
    return ex;
  }

  private ensureAsyncifyBuffer() {
    if (this.asyncifyData) return;
    const pages = 32;                                      // 2 MiB of saved frames
    const old = this.memory.grow(pages);
    this.asyncifyData = old * 65536;
    this.asyncifySize = pages * 65536;
  }

  private beginUnwind(ex: Record<string, any>) {
    this.ensureAsyncifyBuffer();
    const view = this.getView();
    view.setUint32(this.asyncifyData, this.asyncifyData + 8, true);                    // current position
    view.setUint32(this.asyncifyData + 4, this.asyncifyData + this.asyncifySize, true); // end
    ex.asyncify_start_unwind(this.asyncifyData);
  }

  private stackCheckpoint(snapPtr: number, retPtr: number): number {
    const ex = this.asyncifyExports();
    if (!ex) return WASI_ENOSYS;
    if (ex.asyncify_get_state() === 2) {                  // rewound back to this call: resume
      ex.asyncify_stop_rewind();
      this.getView().setBigUint64(retPtr, this.rewindValue, true);
      this.rewindValue = 0n;
      return WASI_ESUCCESS;
    }
    this.pendingUnwind = { kind: 'checkpoint', snapPtr, sp: Number(ex.__stack_pointer.value) };
    this.beginUnwind(ex);
    return WASI_ESUCCESS;                                   // ignored while unwinding
  }

  private stackRestore(snapPtr: number, val: bigint): void {
    const ex = this.asyncifyExports();
    const id = Number(this.getView().getBigUint64(snapPtr, true));
    const snap = this.snapshots.get(id);
    if (!ex || !snap) throw new WasiExit(127);
    this.pendingUnwind = { kind: 'restore', snap, val };
    this.beginUnwind(ex);
  }

  /**
   * Call `_start`, and whenever the guest unwinds for a checkpoint, restore or fork, service it and
   * re-enter. Throws WasiExit / ExecSignal when the program (or the forked child) ends that way.
   */
  private async drive(start: Function): Promise<void> {
    start();
    const ex = this.asyncifyExports();
    while (ex && ex.asyncify_get_state() === 1 && this.pendingUnwind) {
      ex.asyncify_stop_unwind();
      const p = this.pendingUnwind;
      this.pendingUnwind = null;
      const view = this.getView();
      if (p.kind === 'checkpoint') {
        const end = view.getUint32(this.asyncifyData, true);
        const id = this.nextSnapshot++;
        this.snapshots.set(id, { stack: this.getU8().slice(this.asyncifyData + 8, end), sp: p.sp });
        this.snapshots.delete(id - 512);                    // bound the memory used by old snapshots
        view.setBigUint64(p.snapPtr, BigInt(id), true);
        this.rewindValue = 0n;
      } else if (p.kind === 'restore') {
        this.getU8().set(p.snap.stack, this.asyncifyData + 8);
        view.setUint32(this.asyncifyData, this.asyncifyData + 8 + p.snap.stack.length, true);
        ex.__stack_pointer.value = p.snap.sp;
        this.rewindValue = p.val;
      } else {
        await this.performFork(p.copyMemory, start, ex);
      }
      ex.asyncify_start_rewind(this.asyncifyData);
      start();
    }
  }

  /** Run the child to its end, then restore the parent so that it can be rewound with the child's pid. */
  private async performFork(copyMemory: boolean, start: Function, ex: Record<string, any>): Promise<void> {
    const bufEnd = this.getView().getUint32(this.asyncifyData, true);
    const bufSave = this.getU8().slice(this.asyncifyData, bufEnd);               // the parent's unwound stack
    const memSave = copyMemory ? this.getU8().slice() : null;
    const globals = { sp: ex.__stack_pointer.value, tls: ex.__tls_base?.value };
    const parent = { fds: this.fds, nextFd: this.nextFd, cwd: this.cwdPath, proc: this.proc };
    const pid = this.nextPid++;
    this.config.trace?.(`   (fork -> child pid ${pid})`);

    // the child: a copy of the descriptor table over the same open files
    this.fds = new Map(parent.fds);
    for (const f of this.fds.values()) f.refs++;
    this.proc = { pid, ppid: parent.proc.pid, children: new Map() };
    this.forkResult = 0;
    ex.asyncify_start_rewind(this.asyncifyData);
    let code = 0;
    try {
      await this.drive(start);
    } catch (e) {
      if (e instanceof WasiExit) code = e.code;
      else if (e instanceof ExecSignal) code = await this.performExec(e.req);
      else throw e;
    } finally {
      for (const f of this.fds.values()) this.releaseFd(f);                      // the child's descriptors close with it
      this.fds = parent.fds; this.nextFd = parent.nextFd; this.cwdPath = parent.cwd; this.proc = parent.proc;
    }
    // put the parent back as it was at the fork
    const mem = this.getU8();
    if (memSave) mem.set(memSave.subarray(0, Math.min(memSave.length, mem.length)));
    mem.set(bufSave, this.asyncifyData);
    ex.__stack_pointer.value = globals.sp;
    if (globals.tls !== undefined && ex.__tls_base) { try { ex.__tls_base.value = globals.tls; } catch { /* immutable */ } }
    this.proc.children.set(pid, code);
    this.forkResult = pid;
  }

  /** Replace the current program: run the requested command through the host and use its output and status. */
  private async performExec(req: ExecRequest): Promise<number> {
    if (!this.config.exec) { this.writeFd(this.fds.get(2) ?? this.stderrFd, textToBytes(`exec: cannot run ${req.argv[0]}\n`)); return 126; }
    // whatever the new program can read from stdin: the rest of fd 0
    const in0 = this.fds.get(0);
    let stdin = new Uint8Array(0);
    if (in0?.pipe) {
      const st = in0.pipe.state;
      stdin = st.data.slice(st.readPos, st.len);
      st.readPos = st.len;
    } else if (in0) {
      stdin = in0.data.slice(in0.offset);
      in0.offset = in0.data.length;
    }
    // the new program runs on the host: it has to see what this run has written, and this run has to
    // see what the program changes
    let res: ExecResult;
    if (this.remote) {
      res = await this.config.exec({ ...req, cwd: this.cwdPath, stdin: bytesToText(stdin), writes: this.takePendingWrites(), known: this.knownFiles(), dirs: [...this.dirCache.keys()] });
    } else {
      await this.flushAll();
      res = await this.config.exec({ ...req, cwd: this.cwdPath, stdin: bytesToText(stdin) });
      res.updates = await this.computeUpdates(this.knownFiles(), [...this.dirCache.keys()]);
    }
    if (res.updates) this.applyUpdates(res.updates);
    const out = this.fds.get(1), err = this.fds.get(2);
    if (res.stdout && out) this.writeFd(out, textToBytes(res.stdout));
    if (res.stderr && err) this.writeFd(err, textToBytes(res.stderr));
    return res.code;
  }

  /** WASIX extension calls (single process, single thread). Signatures from the wasix_32v1 ABI. */
  private wasixCalls(): Record<string, Function> {
    const u32 = (ptr: number, v: number) => this.getView().setUint32(ptr, v, true);
    const u8 = (ptr: number, v: number) => this.getView().setUint8(ptr, v);
    return {
      // ── process / signals
      callback_signal: (_ptr: number, _len: number) => {},
      thread_signal: (_tid: number, _sig: number) => WASI_ESUCCESS,
      thread_id: (ret: number) => { u32(ret, 1); return WASI_ESUCCESS; },
      thread_parallelism: (ret: number) => { u32(ret, 1); return WASI_ESUCCESS; },
      thread_exit: (code: number) => { throw new WasiExit(code); },
      proc_id: (ret: number) => { u32(ret, this.proc.pid); return WASI_ESUCCESS; },
      proc_parent: (pid: number, ret: number) => { u32(ret, pid === this.proc.pid ? this.proc.ppid : this.proc.pid); return WASI_ESUCCESS; },
      // fork: see performFork. The asyncify handshake is the same as for stack_checkpoint.
      proc_fork: (copyMemory: number, retPtr: number) => {
        const ex = this.asyncifyExports();
        if (!ex) return WASI_ENOSYS;
        if (ex.asyncify_get_state() === 2) {                 // rewound back to this call: resume as child (0) or parent (pid)
          ex.asyncify_stop_rewind();
          u32(retPtr, this.forkResult);
          return WASI_ESUCCESS;
        }
        this.pendingUnwind = { kind: 'fork', copyMemory: copyMemory !== 0 };
        this.beginUnwind(ex);
        return WASI_ESUCCESS;                                 // ignored while unwinding
      },
      // wait for a child: pid 0 means any
      proc_join: (pidPtr: number, _flags: number, statusPtr: number) => {
        // pidPtr is an option_pid { tag: u8 (0 = any child, 1 = this pid), pid: u32 at offset 4 }
        const view = this.getView();
        this.config.trace?.(`   (join request: tag ${view.getUint8(pidPtr)} pid ${view.getUint32(pidPtr + 4, true)} flags ${_flags}; children ${[...this.proc.children.keys()].join(',')})`);
        let pid = view.getUint8(pidPtr) ? view.getUint32(pidPtr + 4, true) : 0;
        if (pid === 0) { const first = this.proc.children.keys().next(); if (first.done) return WASI_ECHILD; pid = first.value; }
        const code = this.proc.children.get(pid);
        if (code === undefined) return WASI_ECHILD;
        this.proc.children.delete(pid);
        this.config.trace?.(`   (joined pid ${pid} status ${code}; pending ${[...this.proc.children.keys()].join(',')})`);
        view.setUint8(pidPtr, 1);
        view.setUint32(pidPtr + 4, pid, true);
        // join_status is a small struct (the guest's pointer is only 2-aligned): tag (1 = exited normally),
        // then the exit code, written where either a u8 (offset 1) or a u16 (offset 2) would read it
        view.setUint8(statusPtr, 1);
        view.setUint8(statusPtr + 1, code & 0xff);
        view.setUint16(statusPtr + 2, code & 0xff, true);
        view.setUint16(statusPtr + 4, 0, true);
        return WASI_ESUCCESS;
      },
      // exec: the command name, then the argument and environment lists, each one string joined with "\n"
      proc_exec: (namePtr: number, nameLen: number, argsPtr: number, argsLen: number) =>
        this.execCall(namePtr, nameLen, argsPtr, argsLen, 0, 0, 0, 0),
      proc_exec2: (namePtr: number, nameLen: number, argsPtr: number, argsLen: number, envPtr: number, envLen: number) =>
        this.execCall(namePtr, nameLen, argsPtr, argsLen, envPtr, envLen, 0, 0),
      proc_exec3: (namePtr: number, nameLen: number, argsPtr: number, argsLen: number, envPtr: number, envLen: number, search: number, pathLen: number) =>
        this.execCall(namePtr, nameLen, argsPtr, argsLen, envPtr, envLen, search, pathLen),
      proc_exit2: (code: number) => { throw new WasiExit(code); },
      proc_signal: (_pid: number, _sig: number) => WASI_ESUCCESS,
      proc_raise_interval: (_sig: number, _interval: bigint, _repeat: number) => WASI_ESUCCESS,
      proc_signals_sizes_get: (ret: number) => { u32(ret, 0); return WASI_ESUCCESS; },
      proc_signals_get: (_buf: number) => WASI_ESUCCESS,
      // setjmp / longjmp via asyncify (see runStart)
      stack_checkpoint: (snapPtr: number, retPtr: number) => this.stackCheckpoint(snapPtr, retPtr),
      stack_restore: (snapPtr: number, val: bigint) => this.stackRestore(snapPtr, val),
      // proc_spawn2, sock_*, resolve: ENOSYS (see above)

      // ── futex: nobody else can wake or be woken
      futex_wait: (ptr: number, expected: number, _timeout: number, ret: number) => {
        const cur = this.getView().getUint32(ptr, true);
        u8(ret, cur !== expected ? 1 : 0);   // value changed: "woken"; unchanged: timed out
        return WASI_ESUCCESS;
      },
      futex_wake: (_ptr: number, ret: number) => { u8(ret, 0); return WASI_ESUCCESS; },
      futex_wake_all: (_ptr: number, ret: number) => { u8(ret, 0); return WASI_ESUCCESS; },

      // ── cwd
      getcwd: (pathPtr: number, lenPtr: number) => {
        const bytes = new TextEncoder().encode(this.cwdPath);
        const view = this.getView();
        const max = view.getUint32(lenPtr, true);
        view.setUint32(lenPtr, bytes.length + 1, true);
        if (bytes.length + 1 > max) return WASI_EOVERFLOW;
        const mem = this.getU8();
        mem.set(bytes, pathPtr);
        mem[pathPtr + bytes.length] = 0;
        return WASI_ESUCCESS;
      },
      chdir: (pathPtr: number, pathLen: number) => {
        const raw = this.getString(pathPtr, pathLen);
        const abs = normPath(raw.startsWith('/') ? raw : this.cwdPath + '/' + raw);
        const cached = this.fileCache.get(abs);
        if (cached && cached.stat.type !== 'dir') return WASI_ENOTDIR;
        this.cwdPath = abs;
        return WASI_ESUCCESS;
      },

      // ── descriptors
      fd_dup: (fd: number, ret: number) => {
        const f = this.fds.get(fd);
        if (!f) return WASI_EBADF;
        const nfd = this.nextFd++;
        f.refs++;
        this.fds.set(nfd, f);
        u32(ret, nfd);
        return WASI_ESUCCESS;
      },
      fd_dup2: (fd: number, minFd: number, _cloexec: number, ret: number) => {
        const f = this.fds.get(fd);
        if (!f) return WASI_EBADF;
        let nfd = minFd;
        while (this.fds.has(nfd)) nfd++;          // lowest free descriptor >= minFd
        f.refs++;
        this.fds.set(nfd, f);
        if (nfd >= this.nextFd) this.nextFd = nfd + 1;
        u32(ret, nfd);
        return WASI_ESUCCESS;
      },
      fd_pipe: (rPtr: number, wPtr: number) => {
        const state: PipeState = { data: new Uint8Array(256), len: 0, readPos: 0, writers: 1 };
        const mk = (end: 'r' | 'w') => {
          const f = new FD({ path: null, filetype: WASI_FILETYPE_UNKNOWN, writable: end === 'w', rights: WASI_RIGHTS_ALL });
          f.pipe = { state, end };
          const nfd = this.nextFd++;
          this.fds.set(nfd, f);
          return nfd;
        };
        u32(rPtr, mk('r'));
        u32(wPtr, mk('w'));
        return WASI_ESUCCESS;
      },
      fd_fdflags_get: (fd: number, ret: number) => {
        if (!this.fds.has(fd)) return WASI_EBADF;
        this.getView().setUint16(ret, 0, true);
        return WASI_ESUCCESS;
      },
      fd_fdflags_set: (fd: number, _flags: number) => (this.fds.has(fd) ? WASI_ESUCCESS : WASI_EBADF),
      path_open2: (dirFd: number, dirFlags: number, pathPtr: number, pathLen: number, oflags: number,
                   rb: bigint, ri: bigint, fdFlags: number, _fdFlagsExt: number, ret: number) =>
        this.path_open(dirFd, dirFlags, pathPtr, pathLen, oflags, rb, ri, fdFlags, ret),

      // ── terminal: not a tty
      tty_get: (ptr: number) => {
        const view = this.getView();
        for (let i = 0; i < 24; i++) view.setUint8(ptr + i, 0);
        view.setUint32(ptr, 80, true);      // cols
        view.setUint32(ptr + 4, 24, true);  // rows
        return WASI_ESUCCESS;
      },
      tty_set: (_ptr: number) => WASI_ESUCCESS,
    };
  }

  /** While set, getView() returns this scratch view instead of wasm memory (used to translate struct layouts). */
  private viewOverride: DataView | null = null;

  /**
   * Run a preview1 call that fills a 64-byte filestat at offset 0 of a scratch buffer, then write the
   * snapshot-0 layout (56 bytes: nlink is u32 at 20, size at 24, times at 32/40/48) to guest memory.
   */
  private withFilestatLayout0(dstPtr: number, call: () => number): number {
    const scratch = new DataView(new ArrayBuffer(64));
    this.viewOverride = scratch;
    let r: number;
    try { r = call(); } finally { this.viewOverride = null; }
    if (r !== WASI_ESUCCESS) return r;
    const d = this.getView();
    d.setBigUint64(dstPtr + 0, scratch.getBigUint64(0, true), true);      // dev
    d.setBigUint64(dstPtr + 8, scratch.getBigUint64(8, true), true);      // ino
    d.setUint8(dstPtr + 16, scratch.getUint8(16));                         // filetype
    d.setUint32(dstPtr + 20, Number(scratch.getBigUint64(24, true)), true); // nlink
    d.setBigUint64(dstPtr + 24, scratch.getBigUint64(32, true), true);    // size
    d.setBigUint64(dstPtr + 32, scratch.getBigUint64(40, true), true);    // atim
    d.setBigUint64(dstPtr + 40, scratch.getBigUint64(48, true), true);    // mtim
    d.setBigUint64(dstPtr + 48, scratch.getBigUint64(56, true), true);    // ctim
    return WASI_ESUCCESS;
  }

  /** Decode captured stdio bytes, holding back an incomplete UTF-8 tail until the next write. */
  private stdioPending: Record<number, Uint8Array> = {};
  private emitStdio(fd: number, chunk: Uint8Array, final: boolean) {
    const prev = this.stdioPending[fd];
    let b = prev && prev.length ? new Uint8Array([...prev, ...chunk]) : chunk;
    let cut = b.length;
    if (!final) {
      // an incomplete multi-byte sequence at the end: lead byte within the last 3 bytes
      for (let k = 1; k <= Math.min(3, b.length); k++) {
        const c = b[b.length - k];
        if ((c & 0xc0) === 0x80) continue;                 // continuation byte, keep looking back
        const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
        if (need > k) cut = b.length - k;
        break;
      }
    }
    this.stdioPending[fd] = b.slice(cut);
    b = b.subarray(0, cut);
    if (!b.length) return;
    const text = bytesToText(b);
    if (fd === 1) { this.stdoutBuf += text; this.config.onStdout?.(text); }
    else { this.stderrBuf += text; this.config.onStderr?.(text); }
  }
  private flushStdio() {
    for (const fd of [1, 2]) if (this.stdioPending[fd]?.length) this.emitStdio(fd, new Uint8Array(0), true);
  }

  /** Run a compiled WASM module and write its file changes back. Returns the exit code. */
  async run(wasmModule: WebAssembly.Module): Promise<number> {
    try {
      return await this.runProgram(wasmModule);
    } finally {
      await this.flushAll();
    }
  }

  /**
   * Run the program without touching the filesystem: file changes stay in this object until
   * flushed (run) or handed over (takeWrites). Everything here is synchronous apart from instantiation,
   * which is what lets it move into a Worker (see wasi-host.ts).
   */
  async runProgram(wasmModule: WebAssembly.Module): Promise<number> {
    this.cwdPath = this.config.cwd || '/';
    this.installVirtualCommands();
    // Modern wasix-libc (it imports even fd_write from wasix_32v1, e.g. dash) starts with its cwd
    // at "/" and resolves `open("s.sh")` as path_open(<".">-preopen, "/s.sh"): a leading slash there
    // means "relative to that preopen". Older toolchains pass plain relative paths.
    this.slashRelativeToDotPreopen = WebAssembly.Module.imports(wasmModule)
      .some(i => i.module === 'wasix_32v1' && i.name === 'fd_write');
    const imports = this.getImports(wasmModule);
    this.instance = await WebAssembly.instantiate(wasmModule, imports);
    this.memory = this.importedMemory ?? this.instance.exports.memory as WebAssembly.Memory;

    try {
      const start = this.instance.exports._start as Function;
      if (!start) {
        throw new Error('WASM module has no _start export');
      }
      await this.drive(start);
      return 0;
    } catch (e: any) {
      if (e instanceof WasiExit) return e.code;
      if (e instanceof ExecSignal) return await this.performExec(e.req);
      throw e;
    } finally {
      this.flushStdio();
    }
  }

  // ── Moving a run into a Worker: plain-data state in, plain-data writes out ──

  /** Everything a Worker needs to run a program: the preloaded files and the process setup. */
  exportJob(memory?: { initial: number; maximum: number | undefined }): WasiJob {
    return {
      cwd: this.config.cwd,
      args: this.config.args,
      env: this.config.env,
      stdin: this.config.stdin ?? '',
      preopens: this.config.preopens,
      files: [...this.fileCache].map(([path, e]) => [path, e.data, e.stat] as WasiJob['files'][number]),
      dirs: [...this.dirCache],
      memory,
      commands: this.config.commands,
    };
  }

  /** A runtime over an exported job; it has no filesystem, so the files must all be in the job. */
  static fromJob(job: WasiJob, io: Pick<WasiConfig, 'onStdout' | 'onStderr' | 'trace' | 'exec'>): WasiRT {
    const noFs = new Proxy({}, { get: (_t, name) => () => { throw new Error(`filesystem not available in the worker (${String(name)})`); } }) as FileSystem;
    const rt = new WasiRT({ fs: noFs, cwd: job.cwd, args: job.args, env: job.env, stdin: job.stdin, preopens: job.preopens, commands: job.commands, ...io });
    for (const [path, data, stat] of job.files) rt.fileCache.set(path, { data, stat });
    for (const [path, names] of job.dirs) rt.dirCache.set(path, names);
    rt.remote = true;
    return rt;
  }

  /** File changes made by the run (written or created files, deferred mkdir/delete/rename). */
  takeWrites(): WasiWrites {
    const closedDirty = [...this.closedDirtyFds];
    for (const fd of this.fds.values()) {
      if (fd.dirty && fd.path) closedDirty.push({ path: fd.path, data: new Uint8Array(fd.data) });
    }
    return { closedDirty, deferredOps: [...this.deferredOps] };
  }

  /** Apply writes produced by another runtime (a Worker) to this one's filesystem. */
  async applyWrites(w: WasiWrites): Promise<void> {
    this.closedDirtyFds = w.closedDirty;
    this.deferredOps = w.deferredOps as typeof this.deferredOps;
    await this.flushAll();
  }

  // ── Helper: read C-string from WASM memory ────────────────────────

  private getString(ptr: number, len: number): string {
    const buf = new Uint8Array(this.memory.buffer, ptr, len).slice();
    return new TextDecoder().decode(buf);
  }

  private getView(): DataView {
    return this.viewOverride ?? new DataView(this.memory.buffer);
  }

  private getU8(): Uint8Array {
    return new Uint8Array(this.memory.buffer);
  }

  /** Is there something at this absolute path: a cached file or directory, or one of the /dev devices? */
  private pathKnown(abs: string): boolean {
    return this.fileCache.has(abs) || abs === '/dev' || /^\/dev\/(null|zero|full|random|urandom|stdin|stdout|stderr)$/.test(abs);
  }

  // ── Helper: resolve path relative to a directory fd ────────────────

  private resolveFdPath(dirFd: number, pathPtr: number, pathLen: number): string | null {
    const fd = this.fds.get(dirFd);
    if (!fd || fd.filetype !== WASI_FILETYPE_DIRECTORY) return null;

    const relPath = this.getString(pathPtr, pathLen);
    const basePath = fd.path || '/';
    if (relPath.startsWith('/')) {
      if (this.slashRelativeToDotPreopen && fd.preopen === '.') {
        // "/x" could be the cwd-relative name "x" (that libc starts at cwd "/") or a true absolute path:
        // it is the absolute one only when nothing by that cwd-relative name exists but the absolute path does
        const rel = normPath(basePath + relPath);
        const abs = normPath(relPath);
        return !this.pathKnown(rel) && this.pathKnown(abs) ? abs : rel;
      }
      return normPath(relPath);
    }
    return normPath(basePath + '/' + relPath);
  }

  // ── Helper: deferred operations queue ──────────────────────────────

  private deferredOps: Array<
    | { type: 'delete'; path: string }
    | { type: 'mkdir'; path: string }
    | { type: 'rmdir'; path: string }
    | { type: 'rename'; oldPath: string; newPath: string }
  > = [];

  /** Dirty file data from fds that were closed before flushAll — flushed in flushAll */
  private closedDirtyFds: Array<{ path: string; data: Uint8Array }> = [];

  // ── Helper: flush dirty fds and deferred ops back to filesystem ────

  private async flushAll(): Promise<void> {
    // Directories first: files written below may live inside them
    for (const op of this.deferredOps) {
      if (op.type !== 'mkdir') continue;
      try { await this.config.fs.mkdir(op.path, { recursive: true }); } catch { /* exists, or best effort */ }
    }
    this.deferredOps = this.deferredOps.filter(op => op.type !== 'mkdir');
    // Flush dirty file descriptors still open
    for (const [, fd] of this.fds) {
      if (fd.dirty && fd.path) {
        try {
          await this.config.fs.writeFile(fd.path, fd.data);
        } catch {
          // Best effort
        }
        fd.dirty = false;
      }
    }
    // Flush data from fds that were closed during execution
    for (const { path, data } of this.closedDirtyFds) {
      try {
        await this.config.fs.writeFile(path, data);
      } catch {
        // Best effort
      }
    }
    this.closedDirtyFds = [];

    // Execute deferred filesystem operations
    for (const op of this.deferredOps) {
      try {
        switch (op.type) {
          case 'delete':
            await this.config.fs.unlink(op.path);
            break;
          case 'rmdir':
            await this.config.fs.rmdir(op.path);
            break;
          case 'rename':
            // Read the data, write to new path, delete old path
            try {
              const data = await this.config.fs.readFile(op.oldPath);
              await this.config.fs.writeFile(op.newPath, data);
              await this.config.fs.unlink(op.oldPath);
            } catch {
              // Best effort
            }
            break;
        }
      } catch {
        // Best effort
      }
    }
    this.deferredOps = [];
  }

  // ── Helper: synchronous file preload (must be called before run for path_open) ──

  private fileCache: Map<string, { data: Uint8Array; stat: { type: string; size: number; mtime: number } }> = new Map();

  /** Pre-load a file from Shiro FS into memory for synchronous access */
  async preloadFile(path: string): Promise<{ data: Uint8Array; stat: { type: string; size: number; mtime: number } } | null> {
    if (this.fileCache.has(path)) return this.fileCache.get(path)!;
    try {
      const data = await this.config.fs.readFile(path) as Uint8Array;
      const stat = await this.config.fs.stat(path);
      const entry = {
        data,
        stat: {
          type: stat.type,
          size: stat.size,
          mtime: stat.mtime.getTime(),
        },
      };
      this.fileCache.set(path, entry);
      return entry;
    } catch {
      return null;
    }
  }

  /** Cache for preloaded directory listings: path → entry names */
  private dirCache: Map<string, string[]> = new Map();

  /** Pre-load directory listing and cache it for fd_readdir */
  async preloadDir(path: string): Promise<string[] | null> {
    if (this.dirCache.has(path)) return this.dirCache.get(path)!;
    try {
      const entries = await this.config.fs.readdir(path);
      this.dirCache.set(path, entries);
      // Also register the directory in fileCache so path_filestat_get works
      if (!this.fileCache.has(path)) {
        this.fileCache.set(path, {
          data: new Uint8Array(0),
          stat: { type: 'dir', size: 0, mtime: Date.now() },
        });
      }
      return entries;
    } catch {
      return null;
    }
  }

  /**
   * Recursively preload a directory tree for synchronous WASI access.
   * Caps at maxDepth levels and maxFiles total to avoid blowing up memory.
   */
  async preloadTree(rootPath: string, maxDepth: number = 3, maxFiles: number = 100): Promise<void> {
    // The directories above the root exist too (cd .., stat /, ls /): list them, without descending
    for (let dir = rootPath; dir !== '/' && dir !== ''; ) {
      const slash = dir.lastIndexOf('/');
      dir = slash <= 0 ? '/' : dir.slice(0, slash);
      await this.preloadDir(dir);
    }
    let fileCount = 0;
    const queue: Array<{ path: string; depth: number }> = [{ path: rootPath, depth: 0 }];

    while (queue.length > 0 && fileCount < maxFiles) {
      const { path: dirPath, depth } = queue.shift()!;
      const entries = await this.preloadDir(dirPath);
      if (!entries) continue;

      for (const name of entries) {
        if (fileCount >= maxFiles) break;
        const fullPath = dirPath === '/' ? `/${name}` : `${dirPath}/${name}`;
        try {
          const stat = await this.config.fs.stat(fullPath);
          if (stat.type === 'dir') {
            this.fileCache.set(fullPath, {
              data: new Uint8Array(0),
              stat: { type: 'dir', size: 0, mtime: stat.mtime.getTime() },
            });
            if (depth < maxDepth) {
              queue.push({ path: fullPath, depth: depth + 1 });
            }
          } else {
            await this.preloadFile(fullPath);
            fileCount++;
          }
        } catch {
          // Skip files we can't stat
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  WASI SYSCALL IMPLEMENTATIONS
  // ══════════════════════════════════════════════════════════════════

  // ── args ─────────────────────────────────────────────────────────

  private args_sizes_get(argcPtr: number, argvBufSizePtr: number): number {
    const view = this.getView();
    const args = this.config.args;
    view.setUint32(argcPtr, args.length, true);
    let totalSize = 0;
    for (const arg of args) {
      totalSize += new TextEncoder().encode(arg).length + 1; // +1 for null terminator
    }
    view.setUint32(argvBufSizePtr, totalSize, true);
    return WASI_ESUCCESS;
  }

  private args_get(argvPtr: number, argvBufPtr: number): number {
    const view = this.getView();
    const mem = this.getU8();
    let bufOffset = argvBufPtr;
    for (let i = 0; i < this.config.args.length; i++) {
      view.setUint32(argvPtr + i * 4, bufOffset, true);
      const encoded = new TextEncoder().encode(this.config.args[i]);
      mem.set(encoded, bufOffset);
      mem[bufOffset + encoded.length] = 0; // null terminator
      bufOffset += encoded.length + 1;
    }
    return WASI_ESUCCESS;
  }

  // ── environ ──────────────────────────────────────────────────────

  private environ_sizes_get(countPtr: number, bufSizePtr: number): number {
    const view = this.getView();
    const entries = Object.entries(this.config.env);
    view.setUint32(countPtr, entries.length, true);
    let totalSize = 0;
    for (const [key, value] of entries) {
      totalSize += new TextEncoder().encode(`${key}=${value}`).length + 1;
    }
    view.setUint32(bufSizePtr, totalSize, true);
    return WASI_ESUCCESS;
  }

  private environ_get(environPtr: number, environBufPtr: number): number {
    const view = this.getView();
    const mem = this.getU8();
    const entries = Object.entries(this.config.env);
    let bufOffset = environBufPtr;
    for (let i = 0; i < entries.length; i++) {
      view.setUint32(environPtr + i * 4, bufOffset, true);
      const encoded = new TextEncoder().encode(`${entries[i][0]}=${entries[i][1]}`);
      mem.set(encoded, bufOffset);
      mem[bufOffset + encoded.length] = 0;
      bufOffset += encoded.length + 1;
    }
    return WASI_ESUCCESS;
  }

  // ── clock ────────────────────────────────────────────────────────

  private clock_time_get(clockId: number, _precision: bigint, timePtr: number): number {
    const view = this.getView();
    let ns: bigint;
    if (clockId === WASI_CLOCK_REALTIME) {
      ns = BigInt(Date.now()) * 1_000_000n;
    } else {
      ns = BigInt(Math.round(performance.now() * 1e6));
    }
    view.setBigUint64(timePtr, ns, true);
    return WASI_ESUCCESS;
  }

  private clock_res_get(clockId: number, resPtr: number): number {
    const view = this.getView();
    // 1ms resolution
    view.setBigUint64(resPtr, 1_000_000n, true);
    return WASI_ESUCCESS;
  }

  // ── fd operations ────────────────────────────────────────────────

  /** Drop one reference to an open file; the last one closes it (writes back data, ends a pipe's writer). */
  private releaseFd(f: FD) {
    if (--f.refs > 0) return;                  // another descriptor (fd_dup, a forked process) still has it
    if (f.pipe?.end === 'w') f.pipe.state.writers--;
    // Preserve dirty data for flushing later (fd_close is sync, flush is async)
    if (f.dirty && f.path) {
      const data = new Uint8Array(f.data);
      this.closedDirtyFds.push({ path: f.path, data });
      this.fileCache.set(f.path, { data, stat: { type: 'file', size: data.length, mtime: Date.now() } });
    }
  }

  private fd_close(fd: number): number {
    const f = this.fds.get(fd);
    if (!f) return WASI_EBADF;
    this.fds.delete(fd);
    this.releaseFd(f);
    return WASI_ESUCCESS;
  }

  private fd_renumber(from: number, to: number): number {
    const f = this.fds.get(from);
    if (!f) return WASI_EBADF;
    if (from === to) return WASI_ESUCCESS;
    const old = this.fds.get(to);
    if (old) this.releaseFd(old);
    this.fds.set(to, f);
    this.fds.delete(from);
    return WASI_ESUCCESS;
  }

  private fd_fdstat_get(fd: number, bufPtr: number): number {
    const f = this.fds.get(fd);
    if (!f) return WASI_EBADF;
    const view = this.getView();
    view.setUint8(bufPtr, f.filetype);        // fs_filetype
    view.setUint16(bufPtr + 2, 0, true);      // fs_flags
    view.setBigUint64(bufPtr + 8, f.rights, true);  // fs_rights_base
    view.setBigUint64(bufPtr + 16, f.rights, true);  // fs_rights_inheriting
    return WASI_ESUCCESS;
  }

  private fd_fdstat_set_flags(_fd: number, _flags: number): number {
    return WASI_ESUCCESS; // no-op
  }

  private fd_filestat_get(fd: number, bufPtr: number): number {
    const f = this.fds.get(fd);
    if (!f) return WASI_EBADF;
    const view = this.getView();
    // filestat structure (64 bytes). dev/ino identify the file: tools such as grep compare them to
    // detect "input file is also the output", so distinct files must not share a number.
    view.setBigUint64(bufPtr + 0, f.path ? 1n : 2n, true);                       // dev
    view.setBigUint64(bufPtr + 8, f.path ? inodeFor(f.path) : BigInt(fd) + 1n, true);   // ino
    view.setUint8(bufPtr + 16, f.filetype);       // filetype
    view.setBigUint64(bufPtr + 24, 1n, true);    // nlink
    view.setBigUint64(bufPtr + 32, BigInt(f.data.length), true); // size
    const now = BigInt(Date.now()) * 1_000_000n;
    view.setBigUint64(bufPtr + 40, now, true);    // atim
    view.setBigUint64(bufPtr + 48, now, true);    // mtim
    view.setBigUint64(bufPtr + 56, now, true);    // ctim
    return WASI_ESUCCESS;
  }

  private fd_filestat_set_size(fd: number, size: bigint): number {
    const f = this.fds.get(fd);
    if (!f) return WASI_EBADF;
    const newSize = Number(size);
    if (newSize < f.data.length) {
      f.data = f.data.slice(0, newSize);
    } else if (newSize > f.data.length) {
      const grown = new Uint8Array(newSize);
      grown.set(f.data);
      f.data = grown;
    }
    f.dirty = true;
    return WASI_ESUCCESS;
  }

  private fd_filestat_set_times(_fd: number, _atim: bigint, _mtim: bigint, _flags: number): number {
    return WASI_ESUCCESS; // no-op for now
  }

  private fd_read(fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number): number {
    const f = this.fds.get(fd);
    if (!f) return WASI_EBADF;
    const view = this.getView();
    const mem = this.getU8();
    let totalRead = 0;

    for (let i = 0; i < iovsLen; i++) {
      const bufPtr = view.getUint32(iovsPtr + i * 8, true);
      const bufLen = view.getUint32(iovsPtr + i * 8 + 4, true);
      let chunk: Uint8Array;
      if (f.device) {
        chunk = f.device === 'null' ? new Uint8Array(0) : new Uint8Array(bufLen);
        if (f.device === 'random') (globalThis.crypto as Crypto | undefined)?.getRandomValues?.(chunk as Uint8Array<ArrayBuffer>);
      } else if (f.pipe) {
        const st = f.pipe.state;
        if (f.pipe.end !== 'r') return WASI_EBADF;
        const avail = st.len - st.readPos;
        if (avail === 0 && totalRead === 0 && st.writers > 0) return WASI_EAGAIN;   // nothing will ever arrive: single thread
        chunk = st.data.slice(st.readPos, st.readPos + Math.min(avail, bufLen));
        st.readPos += chunk.length;
      } else chunk = f.read(bufLen);
      mem.set(chunk, bufPtr);
      totalRead += chunk.length;
      if (chunk.length < bufLen) break; // EOF
    }

    view.setUint32(nreadPtr, totalRead, true);
    return WASI_ESUCCESS;
  }

  private fd_pread(fd: number, iovsPtr: number, iovsLen: number, offset: bigint, nreadPtr: number): number {
    const f = this.fds.get(fd);
    if (!f) return WASI_EBADF;
    const savedOffset = f.offset;
    f.offset = Number(offset);
    const result = this.fd_read(fd, iovsPtr, iovsLen, nreadPtr);
    f.offset = savedOffset;
    return result;
  }

  /** Write bytes to an open file as fd_write would: stdout/stderr stream out, pipes buffer, files grow. */
  private writeFd(f: FD, chunk: Uint8Array) {
    if (f.device) return;                          // /dev/null swallows it
    if (f === this.stdoutFd) { this.emitStdio(1, chunk, false); return; }
    if (f === this.stderrFd) { this.emitStdio(2, chunk, false); return; }
    if (f.pipe) {
      const st = f.pipe.state;
      if (st.len + chunk.length > st.data.length) {
        const grown = new Uint8Array(Math.max(st.data.length * 2, st.len + chunk.length, 256));
        grown.set(st.data.subarray(0, st.len));
        st.data = grown;
      }
      st.data.set(chunk, st.len);
      st.len += chunk.length;
      return;
    }
    f.write(chunk);
  }

  private fd_write(fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
    const f = this.fds.get(fd);
    if (!f) return WASI_EBADF;
    const view = this.getView();
    const mem = this.getU8();
    let totalWritten = 0;

    for (let i = 0; i < iovsLen; i++) {
      const bufPtr = view.getUint32(iovsPtr + i * 8, true);
      const bufLen = view.getUint32(iovsPtr + i * 8 + 4, true);
      const chunk = mem.slice(bufPtr, bufPtr + bufLen);

      if (f.pipe && f.pipe.end !== 'w') return WASI_EBADF;
      this.writeFd(f, chunk);
      totalWritten += bufLen;
    }

    view.setUint32(nwrittenPtr, totalWritten, true);
    return WASI_ESUCCESS;
  }

  private fd_pwrite(fd: number, iovsPtr: number, iovsLen: number, offset: bigint, nwrittenPtr: number): number {
    const f = this.fds.get(fd);
    if (!f) return WASI_EBADF;
    const savedOffset = f.offset;
    f.offset = Number(offset);
    const result = this.fd_write(fd, iovsPtr, iovsLen, nwrittenPtr);
    f.offset = savedOffset;
    return result;
  }

  private fd_seek(fd: number, offset: bigint, whence: number, newOffsetPtr: number): number {
    const f = this.fds.get(fd);
    if (!f) return WASI_EBADF;
    // Stdio is not seekable
    if (fd <= 2) return WASI_ESPIPE;
    const newOffset = f.seek(offset, whence);
    const view = this.getView();
    view.setBigUint64(newOffsetPtr, newOffset, true);
    return WASI_ESUCCESS;
  }

  private fd_tell(fd: number, offsetPtr: number): number {
    const f = this.fds.get(fd);
    if (!f) return WASI_EBADF;
    const view = this.getView();
    view.setBigUint64(offsetPtr, BigInt(f.offset), true);
    return WASI_ESUCCESS;
  }

  private fd_advise(_fd: number, _offset: bigint, _len: bigint, _advice: number): number {
    return WASI_ESUCCESS; // advisory only, no-op
  }

  private fd_allocate(_fd: number, _offset: bigint, _len: bigint): number {
    return WASI_ESUCCESS; // no-op — buffers grow dynamically
  }

  private fd_datasync(_fd: number): number {
    return WASI_ESUCCESS; // no-op
  }

  private fd_sync(_fd: number): number {
    return WASI_ESUCCESS; // no-op
  }

  // ── fd prestat (for pre-opened directories) ────────────────────────

  private fd_prestat_get(fd: number, bufPtr: number): number {
    const f = this.fds.get(fd);
    if (!f || f.preopen === null) return WASI_EBADF;
    const view = this.getView();
    view.setUint8(bufPtr, 0); // type = dir
    const nameLen = new TextEncoder().encode(f.preopen).length;
    view.setUint32(bufPtr + 4, nameLen, true);
    return WASI_ESUCCESS;
  }

  private fd_prestat_dir_name(fd: number, pathPtr: number, pathLen: number): number {
    const f = this.fds.get(fd);
    if (!f || f.preopen === null) return WASI_EBADF;
    const encoded = new TextEncoder().encode(f.preopen);
    const mem = this.getU8();
    mem.set(encoded.slice(0, pathLen), pathPtr);
    return WASI_ESUCCESS;
  }

  // ── fd_readdir ─────────────────────────────────────────────────────

  /**
   * Serialized dirent buffers per fd, built on first call from preloaded dirCache.
   * dirent layout (WASI preview1):
   *   d_next:   u64  (8 bytes) — cookie of next entry
   *   d_ino:    u64  (8 bytes) — inode (we use 0)
   *   d_namlen: u32  (4 bytes)
   *   d_type:   u8   (1 byte)  — WASI filetype
   *   padding:  3 bytes
   *   name:     d_namlen bytes (NOT null-terminated)
   * Total header = 24 bytes + name
   */
  private dirEntryBuf: Map<number, Uint8Array> = new Map();

  private fd_readdir(fd: number, bufPtr: number, bufLen: number, cookie: bigint, usedPtr: number): number {
    const f = this.fds.get(fd);
    if (!f || f.filetype !== WASI_FILETYPE_DIRECTORY) return WASI_EBADF;

    const dirPath = f.path || '/';

    // Build serialized entry buffer on first use or cookie 0
    if (!this.dirEntryBuf.has(fd)) {
      const entries = this.dirCache.get(dirPath) || [];
      const enc = new TextEncoder();
      // Calculate total size
      let totalSize = 0;
      const encodedNames: Uint8Array[] = [];
      for (const name of entries) {
        const nameBytes = enc.encode(name);
        encodedNames.push(nameBytes);
        totalSize += 24 + nameBytes.length;
      }
      // Serialize
      const buf = new Uint8Array(totalSize);
      const dv = new DataView(buf.buffer);
      let off = 0;
      for (let i = 0; i < entries.length; i++) {
        const nameBytes = encodedNames[i];
        const entryPath = dirPath === '/' ? `/${entries[i]}` : `${dirPath}/${entries[i]}`;
        const cached = this.fileCache.get(entryPath);
        const ftype = cached?.stat.type === 'dir' ? WASI_FILETYPE_DIRECTORY : WASI_FILETYPE_REGULAR_FILE;

        dv.setBigUint64(off, BigInt(i + 1), true);       // d_next
        dv.setBigUint64(off + 8, 0n, true);              // d_ino
        dv.setUint32(off + 16, nameBytes.length, true);  // d_namlen
        buf[off + 20] = ftype;                            // d_type
        // 3 bytes padding (already 0)
        buf.set(nameBytes, off + 24);
        off += 24 + nameBytes.length;
      }
      this.dirEntryBuf.set(fd, buf);
    }

    const serialized = this.dirEntryBuf.get(fd)!;
    const cookieNum = Number(cookie);
    const view = this.getView();
    const mem = this.getU8();

    // Find the byte offset for the given cookie (entry index)
    // We need to skip `cookie` entries to find the start offset
    const enc = new TextEncoder();
    const entries = this.dirCache.get(dirPath) || [];
    let byteOff = 0;
    for (let i = 0; i < cookieNum && i < entries.length; i++) {
      byteOff += 24 + enc.encode(entries[i]).length;
    }

    // Copy as much as fits into the output buffer
    const remaining = serialized.length - byteOff;
    const toCopy = Math.min(remaining, bufLen);
    if (toCopy > 0) {
      mem.set(serialized.subarray(byteOff, byteOff + toCopy), bufPtr);
    }
    view.setUint32(usedPtr, toCopy, true);

    return WASI_ESUCCESS;
  }

  // ── path operations ────────────────────────────────────────────────

  private path_open(
    dirFd: number, _dirFlags: number,
    pathPtr: number, pathLen: number,
    oflags: number, _fsRightsBase: bigint, _fsRightsInheriting: bigint,
    fdFlags: number, fdPtr: number,
  ): number {
    const absPath = this.resolveFdPath(dirFd, pathPtr, pathLen);
    if (!absPath) return WASI_EBADF;

    const creating = (oflags & WASI_O_CREAT) !== 0;
    const truncating = (oflags & WASI_O_TRUNC) !== 0;
    const wantDir = (oflags & WASI_O_DIRECTORY) !== 0;

    // /dev/stdin, /dev/stdout, /dev/stderr and the few data devices programs rely on
    if (absPath.startsWith('/dev/')) {
      const dev = absPath.slice(5);
      const std = dev === 'stdin' ? 0 : dev === 'stdout' ? 1 : dev === 'stderr' ? 2 : -1;
      const view = this.getView();
      if (std >= 0) {
        const f = this.fds.get(std);
        if (!f) return WASI_EBADF;
        f.refs++;
        const nfd = this.nextFd++;
        this.fds.set(nfd, f);
        view.setUint32(fdPtr, nfd, true);
        return WASI_ESUCCESS;
      }
      const kind = dev === 'null' ? 'null' : dev === 'zero' || dev === 'full' ? 'zero' : dev === 'random' || dev === 'urandom' ? 'random' : null;
      if (kind) {
        const f = new FD({ path: null, filetype: WASI_FILETYPE_CHARACTER_DEVICE, writable: true, rights: WASI_RIGHTS_ALL });
        f.device = kind;
        const nfd = this.nextFd++;
        this.fds.set(nfd, f);
        view.setUint32(fdPtr, nfd, true);
        return WASI_ESUCCESS;
      }
    }

    // Check preloaded cache
    const cached = this.fileCache.get(absPath);

    if (wantDir) {
      // Open as directory
      const newFd = this.nextFd++;
      this.fds.set(newFd, new FD({
        path: absPath,
        filetype: WASI_FILETYPE_DIRECTORY,
        writable: true,
        rights: WASI_RIGHTS_ALL,
      }));
      const view = this.getView();
      view.setUint32(fdPtr, newFd, true);
      return WASI_ESUCCESS;
    }

    if (cached) {
      const newFd = this.nextFd++;
      const data = truncating ? new Uint8Array(0) : new Uint8Array(cached.data);
      this.fds.set(newFd, new FD({
        path: absPath,
        filetype: WASI_FILETYPE_REGULAR_FILE,
        data,
        writable: true,
        rights: WASI_RIGHTS_ALL,
      }));
      if (truncating) {
        this.fds.get(newFd)!.dirty = true;
      }
      this.fds.get(newFd)!.append = (fdFlags & 1) !== 0;
      const view = this.getView();
      view.setUint32(fdPtr, newFd, true);
      return WASI_ESUCCESS;
    }

    if (creating) {
      // Create an empty file
      this.registerNew(absPath, 'file');
      const newFd = this.nextFd++;
      this.fds.set(newFd, new FD({
        path: absPath,
        filetype: WASI_FILETYPE_REGULAR_FILE,
        data: new Uint8Array(0),
        writable: true,
        rights: WASI_RIGHTS_ALL,
      }));
      this.fds.get(newFd)!.dirty = true;
      const view = this.getView();
      view.setUint32(fdPtr, newFd, true);
      return WASI_ESUCCESS;
    }

    return WASI_ENOENT;
  }

  /** Make a path known to later lookups in this run (the real filesystem is updated by flushAll). */
  private registerNew(absPath: string, type: 'dir' | 'file', data = new Uint8Array(0)) {
    this.fileCache.set(absPath, { data, stat: { type, size: data.length, mtime: Date.now() } });
    const slash = absPath.lastIndexOf('/');
    const parent = slash <= 0 ? '/' : absPath.slice(0, slash);
    const name = absPath.slice(slash + 1);
    const siblings = this.dirCache.get(parent);
    if (siblings && !siblings.includes(name)) siblings.push(name);
    if (type === 'dir' && !this.dirCache.has(absPath)) this.dirCache.set(absPath, []);
  }

  private path_create_directory(dirFd: number, pathPtr: number, pathLen: number): number {
    const absPath = this.resolveFdPath(dirFd, pathPtr, pathLen);
    if (!absPath) return WASI_EBADF;
    if (this.fileCache.has(absPath)) return WASI_EEXIST;
    const slash = absPath.lastIndexOf('/');
    const parent = this.fileCache.get(slash <= 0 ? '/' : absPath.slice(0, slash));
    if (parent && parent.stat.type !== 'dir') return WASI_ENOTDIR;
    this.deferredOps.push({ type: 'mkdir', path: absPath });
    this.registerNew(absPath, 'dir');
    return WASI_ESUCCESS;
  }

  private path_filestat_get(dirFd: number, _flags: number, pathPtr: number, pathLen: number, bufPtr: number): number {
    const absPath = this.resolveFdPath(dirFd, pathPtr, pathLen);
    if (!absPath) return WASI_EBADF;

    const cached = this.fileCache.get(absPath);
    const view = this.getView();

    if (!cached && /^\/dev\/(null|zero|full|random|urandom)$/.test(absPath)) {
      view.setBigUint64(bufPtr + 0, 3n, true);
      view.setBigUint64(bufPtr + 8, inodeFor(absPath), true);
      view.setUint8(bufPtr + 16, WASI_FILETYPE_CHARACTER_DEVICE);
      view.setBigUint64(bufPtr + 24, 1n, true);
      for (const off of [32, 40, 48, 56]) view.setBigUint64(bufPtr + off, 0n, true);
      return WASI_ESUCCESS;
    }
    if (!cached && (absPath === '/dev' || absPath === '/tmp') ) {
      view.setBigUint64(bufPtr + 0, 1n, true);
      view.setBigUint64(bufPtr + 8, inodeFor(absPath), true);
      view.setUint8(bufPtr + 16, WASI_FILETYPE_DIRECTORY);
      view.setBigUint64(bufPtr + 24, 1n, true);
      for (const off of [32, 40, 48, 56]) view.setBigUint64(bufPtr + off, 0n, true);
      return WASI_ESUCCESS;
    }

    if (cached) {
      const isDir = cached.stat.type === 'dir';
      view.setBigUint64(bufPtr + 0, 1n, true);     // dev
      view.setBigUint64(bufPtr + 8, inodeFor(absPath), true);   // ino
      view.setUint8(bufPtr + 16, isDir ? WASI_FILETYPE_DIRECTORY : WASI_FILETYPE_REGULAR_FILE);
      view.setBigUint64(bufPtr + 24, 1n, true);    // nlink
      view.setBigUint64(bufPtr + 32, BigInt(cached.stat.size), true);
      const mtim = BigInt(cached.stat.mtime) * 1_000_000n;
      view.setBigUint64(bufPtr + 40, mtim, true);
      view.setBigUint64(bufPtr + 48, mtim, true);
      view.setBigUint64(bufPtr + 56, mtim, true);
      return WASI_ESUCCESS;
    }

    return WASI_ENOENT;
  }

  private path_filestat_set_times(
    _dirFd: number, _flags: number,
    _pathPtr: number, _pathLen: number,
    _atim: bigint, _mtim: bigint, _fstFlags: number,
  ): number {
    return WASI_ESUCCESS; // no-op
  }

  private path_link(
    _oldDirFd: number, _oldFlags: number,
    _oldPathPtr: number, _oldPathLen: number,
    _newDirFd: number, _newPathPtr: number, _newPathLen: number,
  ): number {
    return WASI_ENOSYS; // not supported
  }

  private path_readlink(
    _dirFd: number, _pathPtr: number, _pathLen: number,
    _bufPtr: number, _bufLen: number, _usedPtr: number,
  ): number {
    return WASI_ENOSYS;
  }

  private path_remove_directory(dirFd: number, pathPtr: number, pathLen: number): number {
    const absPath = this.resolveFdPath(dirFd, pathPtr, pathLen);
    if (!absPath) return WASI_EBADF;
    this.deferredOps.push({ type: 'rmdir', path: absPath });
    // Remove from caches
    this.fileCache.delete(absPath);
    this.dirCache.delete(absPath);
    return WASI_ESUCCESS;
  }

  private path_rename(
    oldDirFd: number, oldPathPtr: number, oldPathLen: number,
    newDirFd: number, newPathPtr: number, newPathLen: number,
  ): number {
    const oldPath = this.resolveFdPath(oldDirFd, oldPathPtr, oldPathLen);
    const newPath = this.resolveFdPath(newDirFd, newPathPtr, newPathLen);
    if (!oldPath || !newPath) return WASI_EBADF;
    this.deferredOps.push({ type: 'rename', oldPath, newPath });
    // Update caches
    const cached = this.fileCache.get(oldPath);
    if (cached) {
      this.fileCache.set(newPath, cached);
      this.fileCache.delete(oldPath);
    }
    return WASI_ESUCCESS;
  }

  private path_symlink(_oldPathPtr: number, _oldPathLen: number, _dirFd: number, _newPathPtr: number, _newPathLen: number): number {
    return WASI_ENOSYS;
  }

  private path_unlink_file(dirFd: number, pathPtr: number, pathLen: number): number {
    const absPath = this.resolveFdPath(dirFd, pathPtr, pathLen);
    if (!absPath) return WASI_EBADF;
    this.deferredOps.push({ type: 'delete', path: absPath });
    // Remove from cache
    this.fileCache.delete(absPath);
    return WASI_ESUCCESS;
  }

  // ── process ────────────────────────────────────────────────────────

  private proc_exit(code: number): void {
    throw new WasiExit(code);
  }

  private proc_raise(_sig: number): number {
    return WASI_ENOSYS;
  }

  // ── random ─────────────────────────────────────────────────────────

  private random_get(bufPtr: number, bufLen: number): number {
    const buf = new Uint8Array(this.memory.buffer, bufPtr, bufLen);
    crypto.getRandomValues(buf);
    return WASI_ESUCCESS;
  }

  // ── scheduling ─────────────────────────────────────────────────────

  private sched_yield(): number {
    return WASI_ESUCCESS;
  }

  // ── poll ───────────────────────────────────────────────────────────

  private poll_oneoff(inPtr: number, outPtr: number, nsubscriptions: number, neventsPtr: number): number {
    // Minimal poll implementation: just report all subscriptions as ready
    const view = this.getView();
    const mem = this.getU8();

    for (let i = 0; i < nsubscriptions; i++) {
      const subBase = inPtr + i * 48;
      const eventBase = outPtr + i * 32;

      // Copy userdata from subscription to event
      const userdata = view.getBigUint64(subBase, true);
      view.setBigUint64(eventBase, userdata, true);
      // errno = success
      view.setUint16(eventBase + 8, WASI_ESUCCESS, true);
      // type = same as subscription type
      const subType = view.getUint8(subBase + 8);
      view.setUint8(eventBase + 10, subType);
      // For FD events, report available bytes
      if (subType === 1 || subType === 2) {
        view.setBigUint64(eventBase + 16, 65536n, true); // nbytes
        view.setUint16(eventBase + 24, 0, true); // flags
      }
    }

    view.setUint32(neventsPtr, nsubscriptions, true);
    return WASI_ESUCCESS;
  }

  // ── sockets (stubs) ────────────────────────────────────────────────

  private sock_accept(_fd: number, _flags: number, _fdPtr: number): number {
    return WASI_ENOSYS;
  }

  private sock_recv(_fd: number, _iovsPtr: number, _iovsLen: number, _flags: number, _nreadPtr: number, _flagsPtr: number): number {
    return WASI_ENOSYS;
  }

  private sock_send(_fd: number, _iovsPtr: number, _iovsLen: number, _flags: number, _nwrittenPtr: number): number {
    return WASI_ENOSYS;
  }

  private sock_shutdown(_fd: number, _how: number): number {
    return WASI_ENOSYS;
  }
}
