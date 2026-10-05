// Hand-assembled WASI programs for tests (no toolchain, no network).

// ── tiny WebAssembly assembler ───────────────────────────────────────
const u8 = (...b: number[]) => b;
const str = (s: string) => [s.length, ...Buffer.from(s)];
const vec = (items: number[][]) => [items.length, ...items.flat()];
const section = (id: number, body: number[]) => [id, body.length, ...body];
const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const TYPE_VOID = [0x60, 0x00, 0x00];
const TYPE_FD_WRITE = [0x60, 0x04, 0x7f, 0x7f, 0x7f, 0x7f, 0x01, 0x7f];
const mod = (...sections: number[][]) => Uint8Array.from([...HEADER, ...sections.flat()]);
const memory = section(5, vec([[0x00, 0x01]]));

/** _start: loop forever */
export const spin = () => mod(
  section(1, vec([TYPE_VOID])), section(3, vec([[0]])), memory,
  section(7, vec([[...str('memory'), 2, 0], [...str('_start'), 0, 0]])),
  section(10, vec([[7, 0x00, 0x03, 0x40, 0x0c, 0x00, 0x0b, 0x0b]])),
);

/** _start: write "hi\n" to stdout through fd_write, then return */
export const hello = () => mod(
  section(1, vec([TYPE_FD_WRITE, TYPE_VOID])),
  section(2, vec([[...str('wasi_snapshot_preview1'), ...str('fd_write'), 0x00, 0x00]])),
  section(3, vec([[1]])), memory,
  section(7, vec([[...str('memory'), 2, 0], [...str('_start'), 0, 1]])),
  section(10, vec([[13, 0x00, 0x41, 1, 0x41, 0, 0x41, 1, 0x41, 20, 0x10, 0, 0x1a, 0x0b]])),
  // iovec {buf: 8, len: 3} at 0, "hi\n" at 8
  section(11, vec([[0x00, 0x41, 0, 0x0b, 11, 8, 0, 0, 0, 3, 0, 0, 0, 0x68, 0x69, 0x0a]])),
);

/** _start: unreachable */
export const trap = () => mod(
  section(1, vec([TYPE_VOID])), section(3, vec([[0]])), memory,
  section(7, vec([[...str('memory'), 2, 0], [...str('_start'), 0, 0]])),
  section(10, vec([[3, 0x00, 0x00, 0x0b]])),
);


const sleb = (n: number): number[] => {      // signed LEB128 for small non-negative constants
  const out: number[] = [];
  for (;;) { const b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40))) { out.push(b); return out; } out.push(b | 0x80); }
};

/** _start: one poll_oneoff(subscription at 0 -> events at 64, count at 128), then return. `subscription` is the 48-byte record. */
export const pollOnce = (subscription: number[]) => mod(
  section(1, vec([TYPE_FD_WRITE, TYPE_VOID])),
  section(2, vec([[...str('wasi_snapshot_preview1'), ...str('poll_oneoff'), 0x00, 0x00]])),
  section(3, vec([[1]])), memory,
  section(7, vec([[...str('memory'), 2, 0], [...str('_start'), 0, 1]])),
  (() => {
    const body = [0x00, 0x41, ...sleb(0), 0x41, ...sleb(64), 0x41, ...sleb(1), 0x41, ...sleb(128), 0x10, 0, 0x1a, 0x0b];
    return section(10, vec([[...sleb(body.length), ...body]]));
  })(),
  section(11, vec([[0x00, 0x41, 0, 0x0b, ...sleb(subscription.length), ...subscription]])),
);

/** A 48-byte preview1 clock subscription: userdata 7, `timeoutNs` on clock `clockId` (relative unless `absolute`). */
export const clockSubscription = (timeoutNs: bigint, clockId = 1, absolute = false): number[] => {
  const b = new Uint8Array(48), v = new DataView(b.buffer);
  v.setBigUint64(0, 7n, true); v.setUint8(8, 0);
  v.setUint32(16, clockId, true); v.setBigUint64(24, timeoutNs, true); v.setUint16(40, absolute ? 1 : 0, true);
  return [...b];
};
