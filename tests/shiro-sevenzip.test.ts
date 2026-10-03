import { afterEach, describe, expect, it, vi } from 'vitest';
import { __setSevenZipForTest, sevenZipCmd } from '../shiro/commands/sevenzip';

class MockWasmFS {
  private files = new Map<string, Uint8Array>();
  private dirs = new Set(['/']);

  mkdir(path: string): void {
    if (this.dirs.has(path) || this.files.has(path)) throw new Error(`exists: ${path}`);
    this.dirs.add(path);
  }

  chdir(_path: string): void {}

  writeFile(path: string, bytes: Uint8Array): void {
    this.files.set(path, bytes.slice());
  }

  readFile(path: string): Uint8Array {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`ENOENT: ${path}`);
    return bytes.slice();
  }

  lstat(path: string) {
    if (!this.dirs.has(path) && !this.files.has(path)) throw new Error(`ENOENT: ${path}`);
    const isDirectory = this.dirs.has(path);
    return { isDirectory: () => isDirectory, isSymbolicLink: () => false };
  }

  stat(path: string) { return this.lstat(path); }

  readdir(path: string): string[] {
    if (!this.dirs.has(path)) throw new Error(`ENOTDIR: ${path}`);
    const prefix = path === '/' ? '/' : `${path}/`;
    const names = new Set<string>(['.', '..']);
    for (const entry of [...this.dirs, ...this.files.keys()]) {
      if (!entry.startsWith(prefix) || entry === path) continue;
      const child = entry.slice(prefix.length).split('/')[0];
      if (child) names.add(child);
    }
    return [...names];
  }

  unlink(path: string): void { this.files.delete(path); }

  rmdir(path: string): void {
    if (this.readdir(path).length > 2) throw new Error(`ENOTEMPTY: ${path}`);
    this.dirs.delete(path);
  }
}

function makeCtx(args: string[], files: Record<string, string | Uint8Array> = {}): any {
  const workspace = new Map<string, Uint8Array>(Object.entries(files).map(([path, content]) => [
    path.startsWith('/') ? path : `/workspace/${path}`,
    typeof content === 'string' ? new TextEncoder().encode(content) : content,
  ]));
  const isDir = (path: string) => path === '/workspace' || [...workspace.keys()].some(file => file.startsWith(`${path}/`));
  const stat = (path: string) => {
    if (workspace.has(path)) return { isDirectory: () => false, isSymbolicLink: () => false };
    if (isDir(path)) return { isDirectory: () => true, isSymbolicLink: () => false };
    throw new Error(`ENOENT: ${path}`);
  };
  return {
    args, cwd: '/workspace', env: {}, stdin: '', stdout: '', stderr: '', shell: {}, terminal: undefined,
    fs: {
      resolvePath: (path: string, cwd: string) => path.startsWith('/') ? path : `${cwd}/${path}`,
      lstat: async (path: string) => stat(path),
      stat: async (path: string) => stat(path),
      readdir: async (dir: string) => [...new Set([...workspace.keys()]
        .filter(path => path.startsWith(`${dir}/`))
        .map(path => path.slice(dir.length + 1).split('/')[0]))],
      readFile: async (path: string) => {
        const bytes = workspace.get(path);
        if (!bytes) throw new Error(`ENOENT: ${path}`);
        return bytes.slice();
      },
      writeFile: async (path: string, bytes: Uint8Array | string) => {
        workspace.set(path, typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes.slice());
      },
      mkdir: async () => {},
      unlink: async (path: string) => { workspace.delete(path); },
      rmdir: async () => {},
    },
    workspace,
  };
}

afterEach(() => __setSevenZipForTest(null));

describe('7z Shiro command integration', () => {
  it('stages workspace files, invokes the WASM CLI, and syncs archives back', async () => {
    const archive = Uint8Array.of(0x37, 0x7a, 0xbc, 0xaf);
    const calls: string[][] = [];
    let listedStagedArchive = false;

    const factory = async (options: any) => {
      const FS = new MockWasmFS();
      return {
        FS,
        callMain(args: string[]) {
          calls.push(args);
          if (args[0] === 'a') {
            FS.writeFile('/workspace/bundle.7z', archive);
            options.print('Everything is Ok');
          } else {
            listedStagedArchive = FS.readFile('/workspace/bundle.7z').every((b, i) => b === archive[i]);
            options.print('Listing archive: bundle.7z');
          }
          return 0;
        },
      };
    };
    __setSevenZipForTest(factory as any);

    const add = makeCtx(['a', 'bundle.7z', 'input.txt'], { 'input.txt': 'payload' });
    expect(await sevenZipCmd.exec(add)).toBe(0);
    expect(calls[0]).toEqual(['a', 'bundle.7z', 'input.txt']);
    expect([...add.workspace.get('/workspace/bundle.7z')!]).toEqual([...archive]);
    expect(add.stdout).toContain('Everything is Ok');

    const list = makeCtx(['l', 'bundle.7z'], { 'bundle.7z': archive });
    expect(await sevenZipCmd.exec(list)).toBe(0);
    expect(calls[1]).toEqual(['l', 'bundle.7z']);
    expect(listedStagedArchive).toBe(true);
    expect(list.stdout).toContain('Listing archive: bundle.7z');
  });
});
