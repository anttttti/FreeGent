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

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 (FIPS 180-4), synchronous: the xz SHA-256 integrity check is verified while decoding, where an
 *  async crypto.subtle digest cannot be awaited. Returns the 32-byte digest. */
export function sha256(data: Uint8Array, start = 0, end = data.length): Uint8Array {
  const length = end - start;
  const total = (length + 9 + 63) & ~63;
  const buf = new Uint8Array(total);
  buf.set(data.subarray(start, end));
  buf[length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, Math.floor((length * 8) / 0x100000000));
  view.setUint32(total - 4, (length * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}

