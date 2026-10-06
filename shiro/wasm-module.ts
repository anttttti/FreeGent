/**
 * wasm-module.ts — compile WASM modules for the WASI runtime.
 *
 * WASIX toolchains build for threads: the module *imports* its memory as `env.memory`, declared
 * shared. Shared memory needs SharedArrayBuffer (cross-origin isolation), which a plain static
 * deployment doesn't have. The modules run here on a single thread, and atomic instructions are
 * valid on ordinary memory, so the import is rewritten to a non-shared memory and the futex calls are
 * implemented by the runtime. Limits of the imported memory are recorded so the runtime can create
 * a matching one.
 */

export interface MemoryImport { module: string; name: string; initial: number; maximum: number | undefined; wasShared: boolean }

/** Memory a compiled module expects the host to provide (set by compileWasm). */
// Browsers may refuse structured-cloning a compiled module into an opaque-origin worker.
export const moduleBytes = new WeakMap<WebAssembly.Module, Uint8Array>();
export const memoryImports = new WeakMap<WebAssembly.Module, MemoryImport>();

function leb(b: Uint8Array, p: number): [number, number] {
  let r = 0, s = 0, n = 0;
  for (;;) {
    if (p + n >= b.length) throw new Error('truncated wasm');
    const x = b[p + n++];
    r += (x & 0x7f) * 2 ** s;
    if (!(x & 0x80)) break;
    s += 7;
  }
  return [r, n];
}

/** Find the imported memory (if any) and whether its limits flag byte can be patched. */
function findMemoryImport(b: Uint8Array): (MemoryImport & { flagsPos: number }) | null {
  if (b.length < 8 || b[0] !== 0 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6d) return null;
  let p = 8;
  while (p < b.length) {
    const id = b[p++];
    const [size, n] = leb(b, p);
    p += n;
    if (id !== 2) { p += size; continue; }
    let q = p;
    const [count, c] = leb(b, q);
    q += c;
    const dec = new TextDecoder();
    for (let i = 0; i < count; i++) {
      let [len, a] = leb(b, q); q += a;
      const module = dec.decode(b.subarray(q, q + len)); q += len;
      [len, a] = leb(b, q); q += a;
      const name = dec.decode(b.subarray(q, q + len)); q += len;
      const kind = b[q++];
      if (kind === 0) q += leb(b, q)[1];                       // function: type index
      else if (kind === 1) { q++; const fl = b[q++]; q += leb(b, q)[1]; if (fl & 1) q += leb(b, q)[1]; }   // table
      else if (kind === 3) q += 2;                             // global
      else if (kind === 2) {                                   // memory
        const flagsPos = q;
        const fl = b[q++];
        const [initial, t1] = leb(b, q); q += t1;
        let maximum: number | undefined;
        if (fl & 1) { const [m, t2] = leb(b, q); maximum = m; q += t2; }
        return { module, name, initial, maximum, wasShared: (fl & 2) !== 0, flagsPos };
      } else return null;                                      // tag import etc.: not handled
    }
    return null;
  }
  return null;
}

/** Compile a module, rewriting a shared memory import into an ordinary one (see file header). */
export async function compileWasm(bytes: ArrayBuffer | Uint8Array): Promise<WebAssembly.Module> {
  let u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const info = findMemoryImport(u8);
  if (info?.wasShared) {
    u8 = u8.slice();                                           // never modify the caller's (cached) bytes
    u8[info.flagsPos] &= ~2;
  }
  const mod = await WebAssembly.compile(u8 as unknown as BufferSource);
  moduleBytes.set(mod, u8.slice());
  if (info) memoryImports.set(mod, { module: info.module, name: info.name, initial: info.initial, maximum: info.maximum, wasShared: info.wasShared });
  return mod;
}
