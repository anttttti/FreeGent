// WASI poll_oneoff (preview1): readiness comes from the descriptors, clock subscriptions have deadlines, and a
// long wait can still be killed by the host (tasks/059). Units drive the runtime directly; the last block runs
// a hand-assembled guest in a Worker.
import { describe, it, expect, afterEach } from 'vitest';
import { WasiRT, FD, WASI_FILETYPE_REGULAR_FILE } from '../shiro/wasi-runtime';
import { nodeWorkerFactory } from './helpers/node-wasi-worker';
import { pollOnce, clockSubscription } from './helpers/wasm-assemble';
import { execWasi, setWasiWorkerFactory, EXIT_DEADLINE } from '../shiro/wasi-host';

const ESUCCESS = 0, EBADF = 8, EAGAIN = 6, EINVAL = 28, EFAULT = 21;
const IN = 0, OUT = 4096, NEV = 8192;

function setup() {
  const rt = new WasiRT({ fs: {} as any, cwd: '/', args: ['p'], env: {} });
  const memory = new WebAssembly.Memory({ initial: 1 });
  (rt as any).memory = memory;
  const wasi = (rt.getImports() as any).wasi_snapshot_preview1;
  const view = new DataView(memory.buffer);
  const sub = (i: number, userdata: bigint, tag: number, fn: (base: number) => void) => {
    const base = IN + i * 48;
    view.setBigUint64(base, userdata, true); view.setUint8(base + 8, tag); fn(base);
  };
  const fdSub = (i: number, userdata: bigint, tag: 1 | 2, fd: number) => sub(i, userdata, tag, b => view.setUint32(b + 16, fd, true));
  const clockSub = (i: number, userdata: bigint, id: number, timeout: bigint, absolute = false) => sub(i, userdata, 0, b => {
    view.setUint32(b + 16, id, true); view.setBigUint64(b + 24, timeout, true); view.setUint16(b + 40, absolute ? 1 : 0, true);
  });
  const poll = (n: number) => wasi.poll_oneoff(IN, OUT, n, NEV);
  const events = () => Array.from({ length: view.getUint32(NEV, true) }, (_, i) => {
    const b = OUT + i * 32;
    return { userdata: view.getBigUint64(b, true), error: view.getUint16(b + 8, true), type: view.getUint8(b + 10), nbytes: view.getBigUint64(b + 16, true), flags: view.getUint16(b + 24, true) };
  });
  const now = (id = 1) => { wasi.clock_time_get(id, 0n, 16384); return view.getBigUint64(16384, true); };
  return { rt, wasi, view, fdSub, clockSub, poll, events, now };
}
const file = (bytes: number, offset = 0) => { const f = new FD({ path: '/f', filetype: WASI_FILETYPE_REGULAR_FILE, data: new Uint8Array(bytes) }); f.offset = offset; return f; };

describe('poll_oneoff: descriptors', () => {
  it('reports a file as readable with the bytes that are left, and 0 at EOF', () => {
    const t = setup();
    (t.rt as any).fds.set(10, file(100, 30));
    (t.rt as any).fds.set(11, file(5, 5));
    t.fdSub(0, 1n, 1, 10); t.fdSub(1, 2n, 1, 11);
    expect(t.poll(2)).toBe(ESUCCESS);
    expect(t.events()).toEqual([
      { userdata: 1n, error: 0, type: 1, nbytes: 70n, flags: 0 },
      { userdata: 2n, error: 0, type: 1, nbytes: 0n, flags: 0 },
    ]);
  });

  it('answers an unknown descriptor with an EBADF event, not success', () => {
    const t = setup();
    t.fdSub(0, 9n, 1, 77);
    expect(t.poll(1)).toBe(ESUCCESS);
    expect(t.events()).toEqual([{ userdata: 9n, error: EBADF, type: 1, nbytes: 0n, flags: 0 }]);
  });

  it('a pipe is readable when it holds bytes, at EOF once its writers are gone, and not ready otherwise', () => {
    const t = setup();
    const state = { data: new Uint8Array(16), len: 0, readPos: 0, writers: 1 };
    const reader = new FD({ path: null, filetype: 0 }); reader.pipe = { state, end: 'r' };
    (t.rt as any).fds.set(20, reader);
    t.fdSub(0, 1n, 1, 20);
    expect(t.poll(1)).toBe(EAGAIN);               // empty, writer alive, no clock: nothing can ever make it ready
    state.len = 6; state.readPos = 2;
    expect(t.poll(1)).toBe(ESUCCESS);
    expect(t.events()).toEqual([{ userdata: 1n, error: 0, type: 1, nbytes: 4n, flags: 0 }]);
    state.readPos = 6; state.writers = 0;
    expect(t.poll(1)).toBe(ESUCCESS);
    expect(t.events()).toEqual([{ userdata: 1n, error: 0, type: 1, nbytes: 0n, flags: 1 }]);   // hangup
  });

  it('writes are ready on stdout and a writable file, and an error on a read-only descriptor', () => {
    const t = setup();
    (t.rt as any).fds.set(30, file(3));
    t.fdSub(0, 1n, 2, 1); t.fdSub(1, 2n, 2, 30); t.fdSub(2, 3n, 2, 0);
    expect(t.poll(3)).toBe(ESUCCESS);
    const [out, ro, stdin] = t.events();
    expect(out.error).toBe(0);
    expect(ro.error).toBe(EBADF);       // a plain FD is not writable
    expect(stdin.error).toBe(EBADF);    // stdin cannot be written
  });

  it('rejects an empty or out-of-range request', () => {
    const t = setup();
    expect(t.wasi.poll_oneoff(IN, OUT, 0, NEV)).toBe(EINVAL);
    expect(t.wasi.poll_oneoff(IN, OUT, 100000, NEV)).toBe(EFAULT);
    t.view.setUint8(IN + 8, 9);                                           // not a clock, fd_read or fd_write
    expect(t.wasi.poll_oneoff(IN, OUT, 1, NEV)).toBe(EINVAL);
  });
});

describe('poll_oneoff: clocks', () => {
  it('returns at once for a deadline that has passed, with the userdata of the subscription', () => {
    const t = setup();
    t.clockSub(0, 55n, 1, 0n);
    expect(t.poll(1)).toBe(ESUCCESS);
    expect(t.events()).toEqual([{ userdata: 55n, error: 0, type: 0, nbytes: 0n, flags: 0 }]);
    t.clockSub(0, 56n, 1, 1n, true);                                      // absolute, long past
    expect(t.poll(1)).toBe(ESUCCESS);
    expect(t.events()[0].userdata).toBe(56n);
  });

  it('waits out a relative timeout: the guest clock has moved on by at least that much afterwards', () => {
    const t = setup();
    const before = t.now(1);
    t.clockSub(0, 1n, 1, 750_000_000n);
    expect(t.poll(1)).toBe(ESUCCESS);
    expect(t.now(1) - before).toBeGreaterThanOrEqual(750_000_000n);
  });

  it('an absolute deadline in the future is waited for on its own clock', () => {
    const t = setup();
    const target = t.now(0) + 400_000_000n;
    t.clockSub(0, 3n, 0, target, true);
    expect(t.poll(1)).toBe(ESUCCESS);
    expect(t.now(0)).toBeGreaterThanOrEqual(target);
  });

  it('ready descriptors win over a long timer; the earlier of two timers fires first', () => {
    const t = setup();
    (t.rt as any).fds.set(10, file(10));
    t.clockSub(0, 1n, 1, 60_000_000_000n); t.fdSub(1, 2n, 1, 10);
    const before = t.now(1);
    expect(t.poll(2)).toBe(ESUCCESS);
    expect(t.events().map(e => e.userdata)).toEqual([2n]);
    expect(t.now(1) - before).toBeLessThan(1_000_000_000n);               // did not wait the minute

    t.clockSub(0, 10n, 1, 5_000_000_000n); t.clockSub(1, 11n, 1, 200_000_000n);
    expect(t.poll(2)).toBe(ESUCCESS);
    expect(t.events().map(e => e.userdata)).toEqual([11n]);
  });

  it('an unknown clock id is an EINVAL event', () => {
    const t = setup();
    t.clockSub(0, 1n, 99, 1_000n);
    expect(t.poll(1)).toBe(ESUCCESS);
    expect(t.events()[0].error).toBe(EINVAL);
  });
});

describe('poll_oneoff in a Worker', () => {
  afterEach(() => setWasiWorkerFactory(null));
  const run = async (bytes: Uint8Array, deadlineMs: number) => {
    let err = '';
    const code = await execWasi({
      fs: { readdir: async () => [], stat: async () => ({ type: 'dir', size: 0, mtime: new Date(0) }) } as any,
      cwd: '/', args: ['prog'], env: {}, onStdout: () => {}, onStderr: t => { err += t; },
    }, await WebAssembly.compile(bytes as unknown as BufferSource), { preloadRoot: '/', deadlineMs });
    return { code, err };
  };

  it('really waits for a short timer, then returns normally', async () => {
    setWasiWorkerFactory(await nodeWorkerFactory());
    const t0 = Date.now();
    const r = await run(pollOnce(clockSubscription(300_000_000n)), 20000);
    expect(r.code).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
  });

  it('a deadline interrupts a 10-second poll, while another program keeps running', async () => {
    setWasiWorkerFactory(await nodeWorkerFactory());
    const t0 = Date.now();
    const [slow, quick] = await Promise.all([
      run(pollOnce(clockSubscription(10_000_000_000n)), 400),
      run(pollOnce(clockSubscription(50_000_000n)), 20000),
    ]);
    expect(slow.code).toBe(EXIT_DEADLINE);
    expect(slow.err).toMatch(/still running after 0\.4s, killed/);
    expect(quick.code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(6000);
  });
});
