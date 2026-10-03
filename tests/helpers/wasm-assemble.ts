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

