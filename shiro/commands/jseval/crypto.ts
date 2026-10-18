// Synchronous hash implementations (Web Crypto is async-only, but Node's createHash is sync)

export function sha1sync(data: Uint8Array): Uint8Array {
  const bitLen = data.length * 8;
  const padLen = (((data.length + 8) >>> 6) + 1) << 6;
  const padded = new Uint8Array(padLen);
  padded.set(data);
  padded[data.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padLen - 4, bitLen, false);
  let [h0, h1, h2, h3, h4] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
  const rl = (v: number, n: number) => (v << n) | (v >>> (32 - n));
  const w = new Int32Array(80);
  for (let i = 0; i < padLen; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getInt32(i + j * 4, false);
    for (let j = 16; j < 80; j++) w[j] = rl(w[j-3] ^ w[j-8] ^ w[j-14] ^ w[j-16], 1);
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let j = 0; j < 80; j++) {
      let f: number, k: number;
      if (j < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      const t = (rl(a, 5) + f + e + k + w[j]) | 0;
      e = d; d = c; c = rl(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((v, i) => odv.setUint32(i * 4, v, false));
  return out;
}

export function fnvHash(data: Uint8Array, len: number): Uint8Array {
  let h0 = 0x811c9dc5 >>> 0, h1 = 0x6c62272e >>> 0;
  for (let i = 0; i < data.length; i++) {
    h0 = (h0 ^ data[i]) >>> 0; h0 = Math.imul(h0, 0x01000193) >>> 0;
    h1 = (h1 ^ data[i]) >>> 0; h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  const result = new Uint8Array(len);
  const dv = new DataView(result.buffer);
  dv.setUint32(0, h0); dv.setUint32(4, h1);
  dv.setUint32(8, h0 ^ 0xa5a5a5a5); dv.setUint32(12, h1 ^ 0x5a5a5a5a);
  if (len > 16) { dv.setUint32(16, h0 ^ h1); for (let i = 20; i < len; i += 4) if (i + 3 < len) dv.setUint32(i, h0 + i); }
  return result;
}
