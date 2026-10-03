// CRC32 / CRC64-XZ / XXH64 for the xz and zstd container formats.

let crc32Table: Uint32Array | null = null;
export function crc32(data: Uint8Array, start = 0, end = data.length): number {
  if (!crc32Table) {
    crc32Table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32Table[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crc32Table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

let crc64Lo: Uint32Array | null = null;
let crc64Hi: Uint32Array | null = null;
/** CRC-64/XZ (ECMA-182 reflected); returns [lo, hi] 32-bit halves. */
export function crc64(data: Uint8Array, start = 0, end = data.length): [number, number] {
  if (!crc64Lo || !crc64Hi) {
    crc64Lo = new Uint32Array(256);
    crc64Hi = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let lo = i, hi = 0;
      for (let k = 0; k < 8; k++) {
        const bit = lo & 1;
        lo = ((lo >>> 1) | (hi << 31)) >>> 0;
        hi >>>= 1;
        if (bit) { lo = (lo ^ 0xd7870f42) >>> 0; hi = (hi ^ 0xc96c5795) >>> 0; }
      }
      crc64Lo[i] = lo;
      crc64Hi[i] = hi;
    }
  }
  let lo = 0xffffffff, hi = 0xffffffff;
  for (let i = start; i < end; i++) {
    const idx = (lo ^ data[i]) & 0xff;
    lo = (((lo >>> 8) | (hi << 24)) ^ crc64Lo[idx]) >>> 0;
    hi = ((hi >>> 8) ^ crc64Hi[idx]) >>> 0;
  }
  return [(lo ^ 0xffffffff) >>> 0, (hi ^ 0xffffffff) >>> 0];
}

const M64 = (1n << 64n) - 1n;
const P1 = 11400714785074694791n, P2 = 14029467366897019727n, P3 = 1609587929392839161n;
const P4 = 9650029242287828579n, P5 = 2870177450012600261n;
const rotl = (x: bigint, r: bigint) => ((x << r) | (x >> (64n - r))) & M64;
const round = (acc: bigint, v: bigint) => (rotl((acc + v * P2) & M64, 31n) * P1) & M64;
const merge = (h: bigint, v: bigint) => (((h ^ round(0n, v)) * P1) + P4) & M64;

/** XXH64 (seed 0). BigInt based: fine for checksums, slow for hundreds of MB. */
export function xxh64(d: Uint8Array): bigint {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const n = d.length;
  let p = 0;
  let h: bigint;
  if (n >= 32) {
    let v1 = (P1 + P2) & M64, v2 = P2, v3 = 0n, v4 = (0n - P1) & M64;
    for (; p <= n - 32; p += 32) {
      v1 = round(v1, dv.getBigUint64(p, true));
      v2 = round(v2, dv.getBigUint64(p + 8, true));
      v3 = round(v3, dv.getBigUint64(p + 16, true));
      v4 = round(v4, dv.getBigUint64(p + 24, true));
    }
    h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & M64;
    h = merge(h, v1); h = merge(h, v2); h = merge(h, v3); h = merge(h, v4);
  } else h = P5;
  h = (h + BigInt(n)) & M64;
  for (; p + 8 <= n; p += 8) {
    h ^= round(0n, dv.getBigUint64(p, true));
    h = (rotl(h, 27n) * P1 + P4) & M64;
  }
  if (p + 4 <= n) {
    h ^= (BigInt(dv.getUint32(p, true)) * P1) & M64;
    h = (rotl(h, 23n) * P2 + P3) & M64;
    p += 4;
  }
  for (; p < n; p++) {
    h ^= (BigInt(d[p]) * P5) & M64;
    h = (rotl(h, 11n) * P1) & M64;
  }
  h ^= h >> 33n; h = (h * P2) & M64;
  h ^= h >> 29n; h = (h * P3) & M64;
  h ^= h >> 32n;
  return h;
}
