import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { xzCompress, xzDecompress } from '../shiro/commands/xz';
import { zstdCompress, zstdDecompress } from '../shiro/commands/zstd';
import { bzip2Compress, bzip2Decompress } from '../shiro/commands/bzip2';

// Deterministic ~6.7 KB text; fixtures below were produced by the real `zstd -19`, `xz -9`,
// `xz --check=crc32` and `bzip2 -9` on exactly this input.
function sample(): Uint8Array {
  const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega the of and to in is that for it as was with be by on not he'.split(' ');
  let x = 12345;
  let out = '';
  for (let i = 0; i < 1500; i++) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    out += words[(x >> 8) % words.length] + (Math.floor(x / 2 ** 20) % 9 === 0 ? '\n' : ' ');
  }
  return new TextEncoder().encode(out);
}
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));
const ZST = b64('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');
const XZ = b64('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');
const BZ2 = b64('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');
const XZ_CRC32 = b64('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');

const eq = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const concat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap(x => Array.from(x)));
function prng(n: number, seed = 1): Uint8Array {
  const r = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; r[i] = x >>> 24; }
  return r;
}
const have = (cmd: string) => spawnSync(cmd, ['--version']).status === 0;

const inputs: Record<string, Uint8Array> = {
  empty: new Uint8Array(0),
  oneByte: Uint8Array.of(65),
  text: sample(),
  zeros: new Uint8Array(300000),
  random: prng(70000),
  mixed: concat(sample(), prng(5000, 7), new Uint8Array(40000).fill(9), sample()),
  longRange: concat(prng(200000, 3), prng(200000, 3)),   // a match 200 KB back
};

describe('zstd', () => {
  it('decodes a real zstd -19 stream (Huffman literals + FSE sequences)', () => {
    expect(eq(zstdDecompress(ZST), sample())).toBe(true);
  });
  it('round-trips through its own compressor', () => {
    for (const [name, data] of Object.entries(inputs)) {
      const c = zstdCompress(data);
      expect(eq(zstdDecompress(c), data), name).toBe(true);
    }
  });
  it('actually compresses redundant data', () => {
    expect(zstdCompress(inputs.text).length).toBeLessThan(inputs.text.length * 0.5);
    expect(zstdCompress(inputs.zeros).length).toBeLessThan(100);
  });
  it('handles concatenated and skippable frames', () => {
    const skippable = Uint8Array.of(0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1, 2, 3);
    const out = zstdDecompress(concat(ZST, skippable, zstdCompress(Uint8Array.of(1, 2, 3))));
    expect(eq(out, concat(sample(), Uint8Array.of(1, 2, 3)))).toBe(true);
  });
  it('detects corruption', () => {
    const bad = ZST.slice();
    bad[bad.length - 1] ^= 0xff;
    expect(() => zstdDecompress(bad)).toThrow();
    expect(() => zstdDecompress(ZST.slice(0, ZST.length - 20))).toThrow();
    expect(() => zstdDecompress(Uint8Array.of(1, 2, 3, 4, 5))).toThrow(/not in zstd format/);
  });
  it.skipIf(!have('zstd'))('interoperates with the real zstd binary', () => {
    for (const [name, data] of Object.entries(inputs)) {
      const c = Buffer.from(zstdCompress(data));
      const back = execFileSync('zstd', ['-q', '-d', '-c'], { input: c, maxBuffer: 1 << 28 });
      expect(Buffer.compare(back, Buffer.from(data)), `real zstd reads ours: ${name}`).toBe(0);
      for (const lvl of ['-1', '-9', '-19']) {
        const real = execFileSync('zstd', ['-q', lvl, '-c'], { input: Buffer.from(data), maxBuffer: 1 << 28 });
        expect(eq(zstdDecompress(real), data), `we read zstd ${lvl}: ${name}`).toBe(true);
      }
    }
  });
});

describe('xz', () => {
  it('decodes real xz -9 (CRC64) and --check=crc32 streams', () => {
    expect(eq(xzDecompress(XZ), sample())).toBe(true);
    expect(eq(xzDecompress(XZ_CRC32), sample())).toBe(true);
  });
  it('round-trips through its own compressor', () => {
    for (const [name, data] of Object.entries(inputs)) {
      expect(eq(xzDecompress(xzCompress(data)), data), name).toBe(true);
    }
  });
  it('actually compresses redundant data', () => {
    expect(xzCompress(inputs.text).length).toBeLessThan(inputs.text.length * 0.5);
    expect(xzCompress(inputs.zeros).length).toBeLessThan(500);
  });
  it('handles concatenated streams and stream padding', () => {
    const out = xzDecompress(concat(XZ, new Uint8Array(8), xzCompress(Uint8Array.of(7, 8))));
    expect(eq(out, concat(sample(), Uint8Array.of(7, 8)))).toBe(true);
  });
  it('detects corruption', () => {
    const bad = XZ.slice();
    bad[40] ^= 0x55;
    expect(() => xzDecompress(bad)).toThrow();
    expect(() => xzDecompress(XZ.slice(0, XZ.length - 30))).toThrow();
    expect(() => xzDecompress(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13))).toThrow(/not recognized/);
    const crcBad = xzCompress(inputs.text);
    // flip a bit inside the stored CRC64 (just before the index)
    const idx = crcBad.length - 12 - 12 - 8;
    crcBad[idx] ^= 1;
    expect(() => xzDecompress(crcBad)).toThrow(/checksum mismatch|corrupt/);
  });
  it.skipIf(!have('xz'))('interoperates with the real xz binary', () => {
    for (const [name, data] of Object.entries(inputs)) {
      const c = Buffer.from(xzCompress(data));
      const back = execFileSync('xz', ['-q', '-d', '-c'], { input: c, maxBuffer: 1 << 28 });
      expect(Buffer.compare(back, Buffer.from(data)), `real xz reads ours: ${name}`).toBe(0);
      for (const lvl of ['-0', '-6', '-9']) {
        const real = execFileSync('xz', ['-q', lvl, '-c'], { input: Buffer.from(data), maxBuffer: 1 << 28 });
        expect(eq(xzDecompress(real), data), `we read xz ${lvl}: ${name}`).toBe(true);
      }
    }
  });
});

describe('bzip2', () => {
  it('decodes a real bzip2 -9 stream', () => {
    expect(eq(bzip2Decompress(BZ2), sample())).toBe(true);
  });
  it('round-trips through its own compressor', () => {
    for (const [name, data] of Object.entries(inputs)) {
      expect(eq(bzip2Decompress(bzip2Compress(data)), data), name).toBe(true);
    }
  });
  it('writes several blocks for large input and still round-trips', () => {
    const big = concat(inputs.random, inputs.text, inputs.longRange);   // > 100 KB: several blocks at level 1
    const c = bzip2Compress(big, 1);
    expect(eq(bzip2Decompress(c), big)).toBe(true);
  });
  it('actually compresses redundant data', () => {
    expect(bzip2Compress(inputs.text).length).toBeLessThan(inputs.text.length * 0.5);
    expect(bzip2Compress(inputs.zeros).length).toBeLessThan(100);
  });
  it('handles concatenated streams', () => {
    const out = bzip2Decompress(concat(BZ2, bzip2Compress(Uint8Array.of(1, 2, 3))));
    expect(eq(out, concat(sample(), Uint8Array.of(1, 2, 3)))).toBe(true);
  });
  it('detects corruption', () => {
    const bad = BZ2.slice();
    bad[bad.length - 30] ^= 0x40;
    expect(() => bzip2Decompress(bad)).toThrow();
    expect(() => bzip2Decompress(BZ2.slice(0, BZ2.length - 10))).toThrow();
    expect(() => bzip2Decompress(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8))).toThrow(/not in bzip2 format/);
  });
  it.skipIf(!have('bzip2'))('interoperates with the real bzip2 binary', () => {
    for (const [name, data] of Object.entries(inputs)) {
      const c = Buffer.from(bzip2Compress(data));
      const back = execFileSync('bzip2', ['-d', '-c'], { input: c, maxBuffer: 1 << 28 });
      expect(Buffer.compare(back, Buffer.from(data)), `real bzip2 reads ours: ${name}`).toBe(0);
      for (const lvl of ['-1', '-9']) {
        const real = execFileSync('bzip2', [lvl, '-c'], { input: Buffer.from(data), maxBuffer: 1 << 28 });
        expect(eq(bzip2Decompress(real), data), `we read bzip2 ${lvl}: ${name}`).toBe(true);
      }
    }
  });
});
