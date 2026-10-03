// execWasi: WASM programs run in a Worker with a deadline (shiro/wasi-host.ts).
// The modules are assembled by hand, so nothing here needs the network.
import { describe, it, expect, afterEach } from 'vitest';
import { nodeWorkerFactory } from './helpers/node-wasi-worker';
import { spin, hello, trap } from './helpers/wasm-assemble';
import { execWasi, setWasiWorkerFactory, EXIT_DEADLINE } from '../shiro/wasi-host';
import { WasiRT } from '../shiro/wasi-runtime';

const compile = (b: Uint8Array) => WebAssembly.compile(b as unknown as BufferSource);
const run = async (b: Uint8Array, opts: Parameters<typeof execWasi>[2] = {}) => {
  let out = '', err = '';
  const code = await execWasi({
    fs: {} as any, cwd: '/', args: ['prog'], env: {},
    onStdout: t => { out += t; }, onStderr: t => { err += t; },
  }, await compile(b), { preloadRoot: '/', ...opts });
  return { code, out, err };
};

afterEach(() => setWasiWorkerFactory(null));

describe('execWasi in a Worker', () => {
  it('runs a program and streams its output', async () => {
    setWasiWorkerFactory(await nodeWorkerFactory());
    expect(await run(hello())).toEqual({ code: 0, out: 'hi\n', err: '' });
  });

  it('kills a program that never returns, and the caller keeps running', async () => {
    setWasiWorkerFactory(await nodeWorkerFactory());
    const t0 = Date.now();
    const r = await run(spin(), { deadlineMs: 300 });
    expect(r.code).toBe(EXIT_DEADLINE);
    expect(r.err).toMatch(/still running after 0\.3s, killed/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('does not kill a program that finishes before the deadline', async () => {
    setWasiWorkerFactory(await nodeWorkerFactory());
    expect((await run(hello(), { deadlineMs: 20000 })).code).toBe(0);
  });

  it('reports a trapping program as an error', async () => {
    setWasiWorkerFactory(await nodeWorkerFactory());
    await expect(run(trap())).rejects.toThrow(/unreachable/);
  });

  it('runs concurrently: a slow program does not block another', async () => {
    setWasiWorkerFactory(await nodeWorkerFactory());
    const [a, b] = await Promise.all([run(spin(), { deadlineMs: 400 }), run(hello())]);
    expect(a.code).toBe(EXIT_DEADLINE);
    expect(b).toEqual({ code: 0, out: 'hi\n', err: '' });
  });
});

describe('execWasi without a Worker', () => {
  it('falls back to running in-thread', async () => {
    setWasiWorkerFactory(null);
    expect(await run(hello())).toEqual({ code: 0, out: 'hi\n', err: '' });
  });
});

describe('exec: keeping the program and the host filesystem in step', () => {
  // a tiny filesystem: path -> [content, mtime ms]; directories are the keys of `dirs`
  const files = new Map<string, [string, number]>([['/w/same', ['abc', 1000]], ['/w/edited', ['new content', 5000]], ['/w/fresh', ['made by the command', 7000]]]);
  const dirs = new Map<string, string[]>([['/w', ['same', 'edited', 'fresh']]]);
  const fs: any = {
    stat: async (p: string) => {
      const f = files.get(p);
      if (!f) throw new Error('ENOENT');
      return { type: 'file', size: f[0].length, mtime: new Date(f[1]) };
    },
    readFile: async (p: string) => new TextEncoder().encode(files.get(p)![0]),
    readdir: async (p: string) => { const d = dirs.get(p); if (!d) throw new Error('ENOENT'); return d; },
  };
  const rt = new WasiRT({ fs, cwd: '/w', args: [], env: {} });
  const text = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);

  it('reports files that changed, appeared or disappeared among those the program has cached', async () => {
    const known: [string, number, number][] = [['/w/same', 3, 1000], ['/w/edited', 3, 1000], ['/w/removed', 5, 1000]];
    const u = await rt.computeUpdates(known, ['/w']);
    const byPath = Object.fromEntries(u.files.map(([p, d]) => [p, text(d)]));
    expect(byPath['/w/edited']).toBe('new content');         // size and mtime differ
    expect(byPath['/w/fresh']).toBe('made by the command');  // listed in a cached directory, not known yet
    expect(byPath['/w/removed']).toBeNull();                 // gone
    expect('/w/same' in byPath).toBe(false);                 // untouched: nothing to send
    expect(u.dirs).toEqual([['/w', ['same', 'edited', 'fresh']]]);
  });

  it('sends nothing when nothing changed', async () => {
    const u = await rt.computeUpdates([['/w/same', 3, 1000], ['/w/edited', 11, 5000], ['/w/fresh', 19, 7000]], ['/w']);
    expect(u.files).toEqual([]);
  });
});
