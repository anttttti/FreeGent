/**
 * xz / unxz / xzcat — .xz container with LZMA2, pure TypeScript.
 *
 * Decoder: concatenated streams, multiple blocks, LZMA2 (all chunk types), CRC32 / CRC64 / SHA-256 checks
 * (no check, or any other check type, is refused rather than skipped), and the Delta and x86 / PowerPC /
 * ARM / ARM Thumb / SPARC BCJ filters. Not supported: IA-64, ARM64 and RISC-V filters (refused by name).
 * Encoder: LZMA with a hash-chain match finder (literal / match / rep0 / short-rep), single block,
 * CRC64 check. Output is standard .xz that any decoder reads.
 */
import type { Command } from './index';
import { makeCodecCommands, concatBytes } from './codec-cli';
import { crc32, crc64, sha256 } from './checksums';

const XZ_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];
const FOOTER_MAGIC = [0x59, 0x5a];
const CHECK_SIZES = [0, 4, 4, 4, 8, 8, 8, 16, 16, 16, 32, 32, 32, 64, 64, 64];

// ── LZMA probability model (shared by decoder and encoder) ──────────

const PROB_INIT = 1024;
const LEN_SIZE = 2 + 16 * 8 + 16 * 8 + 256;   // choice, choice2, low[16][8], mid[16][8], high[256]

class LzmaModel {
  isMatch = new Uint16Array(12 << 4);
  isRep = new Uint16Array(12);
  isRepG0 = new Uint16Array(12);
  isRepG1 = new Uint16Array(12);
  isRepG2 = new Uint16Array(12);
  isRep0Long = new Uint16Array(12 << 4);
  posSlot = new Uint16Array(4 << 6);
  posSpecial = new Uint16Array(115);
  align = new Uint16Array(16);
  len = new Uint16Array(LEN_SIZE);
  repLen = new Uint16Array(LEN_SIZE);
  literal: Uint16Array;
  state = 0;
  rep0 = 0; rep1 = 0; rep2 = 0; rep3 = 0;
  constructor(public lc: number, public lp: number, public pb: number) {
    this.literal = new Uint16Array(0x300 << (lc + lp));
    this.reset();
  }
  reset() {
    for (const a of [this.isMatch, this.isRep, this.isRepG0, this.isRepG1, this.isRepG2, this.isRep0Long,
      this.posSlot, this.posSpecial, this.align, this.len, this.repLen, this.literal]) a.fill(PROB_INIT);
    this.state = 0;
    this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
  }
}

// ── range decoder ───────────────────────────────────────────────────

class RangeDecoder {
  range = 0xffffffff;
  code = 0;
  pos: number;
  constructor(private d: Uint8Array, start: number, private end: number) {
    if (end - start < 5 || d[start] !== 0) throw new Error('corrupt LZMA data');
    this.code = ((d[start + 1] << 24) | (d[start + 2] << 16) | (d[start + 3] << 8) | d[start + 4]) >>> 0;
    this.pos = start + 5;
  }
  private norm() {
    if (this.range < 0x1000000) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | (this.pos < this.end ? this.d[this.pos] : 0)) >>> 0;
      this.pos++;
    }
  }
  bit(probs: Uint16Array, i: number): number {
    const p = probs[i];
    const bound = (this.range >>> 11) * p;
    let b: number;
    if (this.code < bound) { this.range = bound; probs[i] = p + ((2048 - p) >> 5); b = 0; }
    else { this.range -= bound; this.code -= bound; probs[i] = p - (p >> 5); b = 1; }
    this.norm();
    return b;
  }
  direct(n: number): number {
    let r = 0;
    for (let i = 0; i < n; i++) {
      this.range >>>= 1;
      let b = 0;
      if (this.code >= this.range) { this.code -= this.range; b = 1; }
      r = r * 2 + b;
      this.norm();
    }
    return r;
  }
  tree(probs: Uint16Array, base: number, nbits: number): number {
    let m = 1;
    for (let i = 0; i < nbits; i++) m = (m << 1) + this.bit(probs, base + m);
    return m - (1 << nbits);
  }
  revTree(probs: Uint16Array, base: number, nbits: number): number {
    let m = 1, sym = 0;
    for (let i = 0; i < nbits; i++) { const b = this.bit(probs, base + m); m = (m << 1) + b; sym |= b << i; }
    return sym;
  }
  get overrun() { return this.pos > this.end; }
}

class OutBuf {
  buf: Uint8Array;
  len = 0;
  constructor(hint: number) { this.buf = new Uint8Array(Math.max(1024, hint)); }
  ensure(extra: number) {
    if (this.len + extra <= this.buf.length) return;
    let n = this.buf.length * 2;
    while (n < this.len + extra) n *= 2;
    const nb = new Uint8Array(n);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }
}

function decodeLen(rc: RangeDecoder, probs: Uint16Array, posState: number): number {
  if (!rc.bit(probs, 0)) return rc.tree(probs, 2 + (posState << 3), 3);
  if (!rc.bit(probs, 1)) return 8 + rc.tree(probs, 2 + 128 + (posState << 3), 3);
  return 16 + rc.tree(probs, 2 + 256, 8);
}

function decodeDistance(rc: RangeDecoder, m: LzmaModel, len: number): number {
  const lenState = len < 3 ? len : 3;
  const slot = rc.tree(m.posSlot, lenState << 6, 6);
  if (slot < 4) return slot;
  const numDirect = (slot >> 1) - 1;
  let dist = (2 | (slot & 1)) * 2 ** numDirect;
  if (slot < 14) dist += rc.revTree(m.posSpecial, dist - slot - 1, numDirect);
  else {
    dist += rc.direct(numDirect - 4) * 16;
    dist += rc.revTree(m.align, 0, 4);
  }
  return dist;
}

/** Decode exactly `unpack` bytes of LZMA data from [start,end) appending to `out`. */
function lzmaDecodeChunk(m: LzmaModel, rc: RangeDecoder, out: OutBuf, dictStart: number, unpack: number) {
  const pbMask = (1 << m.pb) - 1, lpMask = (1 << m.lp) - 1, lc = m.lc;
  out.ensure(unpack);
  const buf = out.buf;
  const target = out.len + unpack;
  let o = out.len;
  let { state, rep0, rep1, rep2, rep3 } = m;
  while (o < target) {
    const pos = o - dictStart;
    const posState = pos & pbMask;
    if (!rc.bit(m.isMatch, (state << 4) + posState)) {
      const prev = pos > 0 ? buf[o - 1] : 0;
      const base = 0x300 * (((pos & lpMask) << lc) + (prev >> (8 - lc)));
      let sym = 1;
      if (state >= 7) {
        if (rep0 >= pos) throw new Error('corrupt LZMA data');
        let mb = buf[o - rep0 - 1];
        do {
          const matchBit = (mb >> 7) & 1;
          mb <<= 1;
          const b = rc.bit(m.literal, base + ((1 + matchBit) << 8) + sym);
          sym = (sym << 1) | b;
          if (matchBit !== b) break;
        } while (sym < 0x100);
      }
      while (sym < 0x100) sym = (sym << 1) | rc.bit(m.literal, base + sym);
      buf[o++] = sym & 0xff;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }
    let len: number;
    if (!rc.bit(m.isRep, state)) {
      rep3 = rep2; rep2 = rep1; rep1 = rep0;
      len = decodeLen(rc, m.len, posState);
      state = state < 7 ? 7 : 10;
      rep0 = decodeDistance(rc, m, len);
      if (rep0 === 0xffffffff) throw new Error('unexpected end marker in LZMA2 data');
    } else {
      if (pos === 0) throw new Error('corrupt LZMA data');
      if (!rc.bit(m.isRepG0, state)) {
        if (!rc.bit(m.isRep0Long, (state << 4) + posState)) {
          if (rep0 >= pos) throw new Error('corrupt LZMA data');
          state = state < 7 ? 9 : 11;
          buf[o] = buf[o - rep0 - 1];
          o++;
          continue;
        }
      } else {
        let dist: number;
        if (!rc.bit(m.isRepG1, state)) dist = rep1;
        else {
          if (!rc.bit(m.isRepG2, state)) dist = rep2;
          else { dist = rep3; rep3 = rep2; }
          rep2 = rep1;
        }
        rep1 = rep0; rep0 = dist;
      }
      len = decodeLen(rc, m.repLen, posState);
      state = state < 7 ? 8 : 11;
    }
    len += 2;
    if (rep0 >= pos) throw new Error('corrupt LZMA data (distance beyond dictionary)');
    if (o + len > target) throw new Error('corrupt LZMA data (match crosses chunk end)');
    const from = o - rep0 - 1;
    if (rep0 + 1 >= len) buf.copyWithin(o, from, from + len);
    else for (let k = 0; k < len; k++) buf[o + k] = buf[from + k];
    o += len;
  }
  if (rc.overrun) throw new Error('corrupt LZMA data (truncated)');
  Object.assign(m, { state, rep0, rep1, rep2, rep3 });
  out.len = o;
}

/** Decode an LZMA2 stream starting at `pos`; appends to `out`, returns the position after the end marker. */
function lzma2Decode(d: Uint8Array, pos: number, out: OutBuf): number {
  let model: LzmaModel | null = null;
  let dictStart = out.len;
  let needDictReset = true, needProps = true;
  for (;;) {
    if (pos >= d.length) throw new Error('unexpected end of input');
    const control = d[pos++];
    if (control === 0) return pos;
    if (control < 0x80) {
      if (control > 2) throw new Error('corrupt LZMA2 data (bad control byte)');
      if (control === 1) { needDictReset = false; needProps = true; dictStart = out.len; }
      else if (needDictReset) throw new Error('corrupt LZMA2 data (missing dictionary reset)');
      const size = ((d[pos] << 8) | d[pos + 1]) + 1;
      pos += 2;
      if (pos + size > d.length) throw new Error('unexpected end of input');
      out.ensure(size);
      out.buf.set(d.subarray(pos, pos + size), out.len);
      out.len += size;
      pos += size;
      continue;
    }
    const unpack = ((control & 0x1f) << 16) + ((d[pos] << 8) | d[pos + 1]) + 1;
    const packed = ((d[pos + 2] << 8) | d[pos + 3]) + 1;
    pos += 4;
    const mode = (control >> 5) & 3;
    if (mode === 3) { needDictReset = false; dictStart = out.len; }
    else if (needDictReset) throw new Error('corrupt LZMA2 data (missing dictionary reset)');
    if (mode >= 2) {
      const props = d[pos++];
      if (props >= 225) throw new Error('corrupt LZMA2 data (bad properties)');
      const lc = props % 9, rest = Math.floor(props / 9), lp = rest % 5, pb = Math.floor(rest / 5);
      if (lc + lp > 4) throw new Error('corrupt LZMA2 data (bad properties)');
      model = new LzmaModel(lc, lp, pb);
      needProps = false;
    } else if (needProps || !model) throw new Error('corrupt LZMA2 data (missing properties)');
    else if (mode === 1) model.reset();
    if (pos + packed > d.length) throw new Error('unexpected end of input');
    lzmaDecodeChunk(model, new RangeDecoder(d, pos, pos + packed), out, dictStart, unpack);
    pos += packed;
  }
}

// ── .xz container: decoder ──────────────────────────────────────────

function readVarint(d: Uint8Array, p: number): { v: number; p: number } {
  let v = 0, shift = 0;
  for (let i = 0; i < 9; i++) {
    if (p >= d.length) throw new Error('unexpected end of input');
    const b = d[p++];
    v += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return { v, p };
    shift += 7;
  }
  throw new Error('corrupt xz data (bad varint)');
}

const u32le = (d: Uint8Array, p: number) => (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0;

// ── Block filters (decoder side) ──────────────────────────────────────────────
// A block's filter chain is stored in encoding order, LZMA2 last. Decoding runs LZMA2 first and then
// undoes the others from the last to the first; each inverse works in place on the block's bytes.
// The BCJ filters turn the absolute branch targets a compressor sees back into the relative ones in
// the program (liblzma simple/*.c); the whole block is in memory, so there is no state to carry.

const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const put32be = (b: Uint8Array, i: number, v: number) => { b[i] = v >>> 24; b[i + 1] = v >>> 16; b[i + 2] = v >>> 8; b[i + 3] = v; };

/** Start offset a BCJ filter was told to assume: no property bytes means 0, else a 4-byte value aligned to the instruction size. */
function bcjStart(id: number, props: Uint8Array): number {
  if (props.length === 0) return 0;
  if (props.length !== 4) throw new Error('corrupt xz data (bad BCJ filter properties)');
  const start = (props[0] | (props[1] << 8) | (props[2] << 16) | (props[3] << 24)) >>> 0;
  const align = id === 0x04 ? 1 : id === 0x08 ? 2 : 4;
  if (start % align) throw new Error('corrupt xz data (unaligned BCJ start offset)');
  return start;
}

function x86Inverse(buf: Uint8Array, start: number): void {
  const ALLOWED = [true, true, true, false, true, false, false, false];
  const BIT = [0, 1, 2, 2, 3, 3, 3, 3];
  const ms = (b: number) => b === 0 || b === 0xff;
  let prevMask = 0, prevPos = (start - 5) >>> 0;
  if (buf.length < 5) return;
  const limit = buf.length - 5;
  let i = 0;
  while (i <= limit) {
    let b = buf[i];
    if (b !== 0xe8 && b !== 0xe9) { i++; continue; }
    const offset = (start + i - prevPos) >>> 0;
    prevPos = (start + i) >>> 0;
    if (offset > 5) prevMask = 0;
    else for (let k = 0; k < offset; k++) { prevMask &= 0x77; prevMask <<= 1; }
    b = buf[i + 4];
    if (ms(b) && ALLOWED[(prevMask >>> 1) & 7] && (prevMask >>> 1) < 0x10) {
      let src = (((b << 24) | (buf[i + 3] << 16) | (buf[i + 2] << 8) | buf[i + 1]) >>> 0);
      let dest: number;
      for (;;) {
        dest = (src - (start + i + 5)) >>> 0;
        if (prevMask === 0) break;
        const k = BIT[prevMask >>> 1];
        b = (dest >>> (24 - k * 8)) & 0xff;
        if (!ms(b)) break;
        src = (dest ^ ((1 << (32 - k * 8)) - 1)) >>> 0;
      }
      buf[i + 4] = ~(((dest >>> 24) & 1) - 1) & 0xff;
      buf[i + 3] = dest >>> 16; buf[i + 2] = dest >>> 8; buf[i + 1] = dest;
      i += 5;
      prevMask = 0;
    } else {
      i++;
      prevMask |= 1;
      if (ms(buf[i + 3])) prevMask |= 0x10;
    }
  }
}

function filterInverse(id: number, props: Uint8Array): (buf: Uint8Array) => void {
  switch (id) {
    case 0x03: {                                         // Delta: out[i] = in[i] + out[i - distance]
      if (props.length !== 1) throw new Error('corrupt xz data (bad Delta filter properties)');
      const dist = props[0] + 1;
      return buf => { for (let i = dist; i < buf.length; i++) buf[i] = (buf[i] + buf[i - dist]) & 0xff; };
    }
    case 0x04: { const s = bcjStart(id, props); return buf => x86Inverse(buf, s); }
    case 0x05: {                                         // PowerPC (big-endian `bl`)
      const s = bcjStart(id, props);
      return buf => {
        for (let i = 0; i + 4 <= buf.length; i += 4) {
          if ((buf[i] >>> 2) !== 0x12 || (buf[i + 3] & 3) !== 1) continue;
          const src = (((buf[i] & 3) << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | (buf[i + 3] & ~3)) >>> 0;
          const dest = (src - (s + i)) >>> 0;
          buf[i] = 0x48 | ((dest >>> 24) & 3); buf[i + 1] = dest >>> 16; buf[i + 2] = dest >>> 8;
          buf[i + 3] = (buf[i + 3] & 3) | (dest & 0xfc);
        }
      };
    }
    case 0x07: {                                         // ARM (`bl`, condition always)
      const s = bcjStart(id, props);
      return buf => {
        for (let i = 0; i + 4 <= buf.length; i += 4) {
          if (buf[i + 3] !== 0xeb) continue;
          const src = ((buf[i + 2] << 16) | (buf[i + 1] << 8) | buf[i]) << 2;
          const dest = ((src - (s + i + 8)) >>> 2) >>> 0;
          buf[i + 2] = dest >>> 16; buf[i + 1] = dest >>> 8; buf[i] = dest;
        }
      };
    }
    case 0x08: {                                         // ARM Thumb (`bl` pair)
      const s = bcjStart(id, props);
      return buf => {
        for (let i = 0; i + 4 <= buf.length; i += 2) {
          if ((buf[i + 1] & 0xf8) !== 0xf0 || (buf[i + 3] & 0xf8) !== 0xf8) continue;
          const src = ((((buf[i + 1] & 7) << 19) | (buf[i] << 11) | ((buf[i + 3] & 7) << 8) | buf[i + 2]) << 1) >>> 0;
          const dest = ((src - (s + i + 4)) >>> 1) >>> 0;
          buf[i + 1] = 0xf0 | ((dest >>> 19) & 7); buf[i] = dest >>> 11;
          buf[i + 3] = 0xf8 | ((dest >>> 8) & 7); buf[i + 2] = dest;
          i += 2;
        }
      };
    }
    case 0x09: {                                         // SPARC (`call`)
      const s = bcjStart(id, props);
      return buf => {
        for (let i = 0; i + 4 <= buf.length; i += 4) {
          if (!((buf[i] === 0x40 && (buf[i + 1] & 0xc0) === 0) || (buf[i] === 0x7f && (buf[i + 1] & 0xc0) === 0xc0))) continue;
          const src = (u32be(buf, i) << 2) >>> 0;
          let dest = ((src - (s + i)) >>> 2) >>> 0;
          dest = ((((0 - ((dest >>> 22) & 1)) << 22) & 0x3fffffff) | (dest & 0x3fffff) | 0x40000000) >>> 0;
          put32be(buf, i, dest);
        }
      };
    }
    case 0x06: throw new Error('unsupported xz filter IA-64 (BCJ)');
    case 0x0a: throw new Error('unsupported xz filter ARM64 (BCJ)');
    case 0x0b: throw new Error('unsupported xz filter RISC-V (BCJ)');
    default: throw new Error(`unsupported xz filter 0x${id.toString(16)}`);
  }
}

export function xzDecompress(data: Uint8Array): Uint8Array {
  const n = data.length;
  const out = new OutBuf(n * 4);
  let p = 0;
  let streams = 0;
  while (p < n) {
    // stream padding between concatenated streams
    if (streams > 0) {
      while (p + 4 <= n && u32le(data, p) === 0) p += 4;
      if (p >= n) break;
    }
    if (n - p < 12 || XZ_MAGIC.some((b, i) => data[p + i] !== b)) {
      throw new Error(streams ? 'trailing garbage after xz stream' : 'File format not recognized');
    }
    const flagsHi = data[p + 6], flagsLo = data[p + 7];
    if (flagsHi !== 0 || (flagsLo & 0xf0)) throw new Error('unsupported xz stream flags');
    if (crc32(data, p + 6, p + 8) !== u32le(data, p + 8)) throw new Error('corrupt xz data (stream header CRC mismatch)');
    const checkType = flagsLo & 0x0f;
    // Type 0 is "no check", by the encoder's choice. Any other type that is not verified here would be
    // accepted as if it had been, so it is refused: 1 CRC32, 4 CRC64 and 10 SHA-256 are the ones in use.
    if (checkType !== 0 && checkType !== 1 && checkType !== 4 && checkType !== 10)
      throw new Error(`unsupported xz integrity check type ${checkType}`);
    const checkSize = CHECK_SIZES[checkType];
    p += 12;
    let blocks = 0;
    for (;;) {
      if (p >= n) throw new Error('unexpected end of input');
      const hsByte = data[p];
      if (hsByte === 0) break;                          // index indicator
      const blockStart = p;
      const hsize = (hsByte + 1) * 4;
      if (p + hsize > n) throw new Error('unexpected end of input');
      if (crc32(data, p, p + hsize - 4) !== u32le(data, p + hsize - 4)) throw new Error('corrupt xz data (block header CRC mismatch)');
      const bflags = data[p + 1];
      let hp = p + 2;
      if (bflags & 0x40) hp = readVarint(data, hp).p;
      if (bflags & 0x80) hp = readVarint(data, hp).p;
      const nFilters = (bflags & 3) + 1;
      const chain: Array<{ id: number; props: Uint8Array }> = [];
      for (let f = 0; f < nFilters; f++) {
        const id = readVarint(data, hp); hp = id.p;
        const ps = readVarint(data, hp); hp = ps.p;
        if (hp + ps.v > p + hsize - 4) throw new Error('corrupt xz data (filter properties overrun the block header)');
        chain.push({ id: id.v, props: data.subarray(hp, hp + ps.v) }); hp += ps.v;
      }
      if (chain[nFilters - 1].id !== 0x21) throw new Error('corrupt xz data (no LZMA2 filter)');
      // LZMA2 ends the chain; every filter before it is a transform undone after decoding, last first.
      const transforms = chain.slice(0, -1).map(f => filterInverse(f.id, f.props));
      p += hsize;
      const dataStart = p;
      const outStart = out.len;
      p = lzma2Decode(data, p, out);
      p += (4 - ((p - dataStart) & 3)) & 3;              // block padding
      if (p + checkSize > n) throw new Error('unexpected end of input');
      const block = out.buf.subarray(outStart, out.len);
      for (let t = transforms.length - 1; t >= 0; t--) transforms[t](block);
      if (checkType === 1) {
        if (crc32(block) !== u32le(data, p)) throw new Error('checksum mismatch (CRC32)');
      } else if (checkType === 4) {
        const [lo, hi] = crc64(block);
        if (lo !== u32le(data, p) || hi !== u32le(data, p + 4)) throw new Error('checksum mismatch (CRC64)');
      } else if (checkType === 10) {
        const digest = sha256(block);
        for (let i = 0; i < 32; i++) if (digest[i] !== data[p + i]) throw new Error('checksum mismatch (SHA-256)');
      }
      p += checkSize;
      blocks++;
      void blockStart;
    }
    // index
    const indexStart = p;
    p++;
    const count = readVarint(data, p); p = count.p;
    if (count.v !== blocks) throw new Error('corrupt xz data (index does not match blocks)');
    for (let i = 0; i < count.v * 2; i++) p = readVarint(data, p).p;
    p += (4 - ((p - indexStart) & 3)) & 3;
    if (p + 4 > n) throw new Error('unexpected end of input');
    if (crc32(data, indexStart, p) !== u32le(data, p)) throw new Error('corrupt xz data (index CRC mismatch)');
    p += 4;
    // footer
    if (p + 12 > n) throw new Error('unexpected end of input');
    if (FOOTER_MAGIC.some((b, i) => data[p + 10 + i] !== b)) throw new Error('corrupt xz data (bad footer)');
    if (crc32(data, p + 4, p + 10) !== u32le(data, p)) throw new Error('corrupt xz data (footer CRC mismatch)');
    p += 12;
    streams++;
  }
  if (streams === 0) throw new Error('File format not recognized');
  return out.buf.slice(0, out.len);
}

// ── LZMA encoder ────────────────────────────────────────────────────

class RangeEncoder {
  low = 0;
  range = 0xffffffff;
  cache = 0;
  cacheSize = 1;
  out: Uint8Array = new Uint8Array(1 << 16);
  len = 0;
  private put(b: number) {
    if (this.len === this.out.length) { const nb = new Uint8Array(this.out.length * 2); nb.set(this.out); this.out = nb; }
    this.out[this.len++] = b;
  }
  private shiftLow() {
    const lo = this.low % 4294967296;
    if (lo < 0xff000000 || this.low >= 4294967296) {
      const carry = this.low >= 4294967296 ? 1 : 0;
      let temp = this.cache;
      do { this.put((temp + carry) & 0xff); temp = 0xff; } while (--this.cacheSize !== 0);
      this.cache = (lo >>> 24) & 0xff;
    }
    this.cacheSize++;
    this.low = (lo & 0x00ffffff) * 256;
  }
  bit(probs: Uint16Array, i: number, bit: number) {
    const p = probs[i];
    const bound = (this.range >>> 11) * p;
    if (bit === 0) { this.range = bound; probs[i] = p + ((2048 - p) >> 5); }
    else { this.low += bound; this.range -= bound; probs[i] = p - (p >> 5); }
    while (this.range < 0x1000000) { this.range = (this.range << 8) >>> 0; this.shiftLow(); }
  }
  direct(value: number, n: number) {
    for (let i = n - 1; i >= 0; i--) {
      this.range >>>= 1;
      if (Math.floor(value / 2 ** i) & 1) this.low += this.range;
      while (this.range < 0x1000000) { this.range = (this.range << 8) >>> 0; this.shiftLow(); }
    }
  }
  tree(probs: Uint16Array, base: number, nbits: number, sym: number) {
    let m = 1;
    for (let i = nbits - 1; i >= 0; i--) { const b = (sym >> i) & 1; this.bit(probs, base + m, b); m = (m << 1) | b; }
  }
  revTree(probs: Uint16Array, base: number, nbits: number, sym: number) {
    let m = 1;
    for (let i = 0; i < nbits; i++) { const b = sym & 1; sym >>= 1; this.bit(probs, base + m, b); m = (m << 1) | b; }
  }
  finish(): Uint8Array {
    for (let i = 0; i < 5; i++) this.shiftLow();
    return this.out.subarray(0, this.len);
  }
}

function encodeLen(rc: RangeEncoder, probs: Uint16Array, len: number, posState: number) {
  if (len < 8) { rc.bit(probs, 0, 0); rc.tree(probs, 2 + (posState << 3), 3, len); }
  else if (len < 16) { rc.bit(probs, 0, 1); rc.bit(probs, 1, 0); rc.tree(probs, 2 + 128 + (posState << 3), 3, len - 8); }
  else { rc.bit(probs, 0, 1); rc.bit(probs, 1, 1); rc.tree(probs, 2 + 256, 8, len - 16); }
}

function encodeDistance(rc: RangeEncoder, m: LzmaModel, dist: number, len: number) {
  const lenState = len < 3 ? len : 3;
  let slot: number;
  if (dist < 4) slot = dist;
  else { const nb = 31 - Math.clz32(dist); slot = (nb << 1) | ((dist >>> (nb - 1)) & 1); }
  rc.tree(m.posSlot, lenState << 6, 6, slot);
  if (slot < 4) return;
  const footer = (slot >> 1) - 1;
  const base = (2 | (slot & 1)) * 2 ** footer;
  const reduced = dist - base;
  if (slot < 14) rc.revTree(m.posSpecial, base - slot - 1, footer, reduced);
  else {
    rc.direct(Math.floor(reduced / 16), footer - 4);
    rc.revTree(m.align, 0, 4, reduced & 15);
  }
}

const LC = 3, LP = 0, PB = 2;
const PROPS_BYTE = (PB * 5 + LP) * 9 + LC;
const DICT_BYTE = 22;                       // 8 MiB: (2 | 0) << (22 / 2 + 11)
const DICT_SIZE = 8 << 20;
const CHUNK_UNPACKED = 1 << 16;
const MAX_MATCH = 273;

function lzma2Encode(data: Uint8Array, level: number): Uint8Array {
  const n = data.length;
  const parts: Uint8Array[] = [];
  const model = new LzmaModel(LC, LP, PB);
  const depth = Math.max(4, Math.min(128, level * 8));
  const head = new Int32Array(1 << 16).fill(-1);
  const prev = new Int32Array(Math.max(n, 1)).fill(-1);
  const hash3 = (i: number) => (Math.imul(data[i] | (data[i + 1] << 8) | (data[i + 2] << 16), 2654435761) >>> 16);
  let hashed = 0;
  const insertTo = (upto: number) => {
    for (; hashed < upto; hashed++) {
      if (hashed + 3 > n) continue;
      const h = hash3(hashed);
      prev[hashed] = head[h];
      head[h] = hashed;
    }
  };
  let dictReset = true, needProps = true, needReset = false;

  for (let start = 0; start < n; start += CHUNK_UNPACKED) {
    const end = Math.min(n, start + CHUNK_UNPACKED);
    const mode = dictReset ? 3 : needProps ? 2 : needReset ? 1 : 0;
    if (mode >= 1) model.reset();
    const rc = new RangeEncoder();
    let { state, rep0, rep1, rep2, rep3 } = model;
    let pos = start;
    while (pos < end) {
      insertTo(pos);
      const posState = pos & ((1 << PB) - 1);
      const maxLen = Math.min(MAX_MATCH, end - pos);
      // rep0 candidate
      let repLen = 0;
      if (pos > 0 && rep0 < pos) {
        const src = pos - rep0 - 1;
        while (repLen < maxLen && data[src + repLen] === data[pos + repLen]) repLen++;
      }
      // best new match
      let bestLen = 0, bestDist = 0;
      if (maxLen >= 3 && pos + 3 <= n) {
        let cand = head[hash3(pos)];
        for (let t = 0; cand >= 0 && t < depth; t++, cand = prev[cand]) {
          if (cand >= pos) continue;
          const d = pos - cand;
          if (d > DICT_SIZE) break;
          if (bestLen > 0 && data[cand + bestLen] !== data[pos + bestLen]) continue;
          let l = 0;
          while (l < maxLen && data[cand + l] === data[pos + l]) l++;
          if (l > bestLen) { bestLen = l; bestDist = d - 1; if (l === maxLen) break; }
        }
        if (bestLen === 3 && bestDist >= 4096) bestLen = 0;
      }
      const ctxIdx = (state << 4) + posState;
      if (repLen >= 2 && repLen + 1 >= bestLen) {
        rc.bit(model.isMatch, ctxIdx, 1);
        rc.bit(model.isRep, state, 1);
        rc.bit(model.isRepG0, state, 0);
        rc.bit(model.isRep0Long, ctxIdx, 1);
        encodeLen(rc, model.repLen, repLen - 2, posState);
        state = state < 7 ? 8 : 11;
        pos += repLen;
      } else if (bestLen >= 3) {
        rc.bit(model.isMatch, ctxIdx, 1);
        rc.bit(model.isRep, state, 0);
        encodeLen(rc, model.len, bestLen - 2, posState);
        encodeDistance(rc, model, bestDist, bestLen - 2);
        rep3 = rep2; rep2 = rep1; rep1 = rep0; rep0 = bestDist;
        state = state < 7 ? 7 : 10;
        pos += bestLen;
      } else if (pos > 0 && rep0 < pos && data[pos - rep0 - 1] === data[pos]) {
        rc.bit(model.isMatch, ctxIdx, 1);
        rc.bit(model.isRep, state, 1);
        rc.bit(model.isRepG0, state, 0);
        rc.bit(model.isRep0Long, ctxIdx, 0);
        state = state < 7 ? 9 : 11;
        pos += 1;
      } else {
        rc.bit(model.isMatch, ctxIdx, 0);
        const prevByte = pos > 0 ? data[pos - 1] : 0;
        const base = 0x300 * (((pos & ((1 << LP) - 1)) << LC) + (prevByte >> (8 - LC)));
        const byte = data[pos];
        let sym = 1;
        if (state >= 7) {
          const mb = data[pos - rep0 - 1];
          let i = 7;
          for (; i >= 0; i--) {
            const matchBit = (mb >> i) & 1, b = (byte >> i) & 1;
            rc.bit(model.literal, base + ((1 + matchBit) << 8) + sym, b);
            sym = (sym << 1) | b;
            if (matchBit !== b) { i--; break; }
          }
          for (; i >= 0; i--) { const b = (byte >> i) & 1; rc.bit(model.literal, base + sym, b); sym = (sym << 1) | b; }
        } else {
          for (let i = 7; i >= 0; i--) { const b = (byte >> i) & 1; rc.bit(model.literal, base + sym, b); sym = (sym << 1) | b; }
        }
        state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        pos += 1;
      }
    }
    insertTo(end);
    Object.assign(model, { state, rep0, rep1, rep2, rep3 });
    const packed = rc.finish();
    const unpack = end - start;
    if (packed.length < unpack && packed.length <= 65536) {
      const hdr = [0x80 | (mode << 5) | ((unpack - 1) >> 16), ((unpack - 1) >> 8) & 255, (unpack - 1) & 255, ((packed.length - 1) >> 8) & 255, (packed.length - 1) & 255];
      if (mode >= 2) hdr.push(PROPS_BYTE);
      parts.push(Uint8Array.from(hdr), packed);
      dictReset = needProps = needReset = false;
    } else {
      // incompressible chunk: store it; the decoder then needs a state reset (and props after a dict reset)
      parts.push(Uint8Array.of(dictReset ? 1 : 2, ((unpack - 1) >> 8) & 255, (unpack - 1) & 255), data.subarray(start, end));
      if (dictReset) needProps = true;
      dictReset = false;
      needReset = true;
    }
  }
  parts.push(Uint8Array.of(0));
  return concatBytes(parts);
}

// ── .xz container: encoder ──────────────────────────────────────────

function varint(v: number): number[] {
  const r: number[] = [];
  while (v >= 0x80) { r.push((v % 128) | 0x80); v = Math.floor(v / 128); }
  r.push(v);
  return r;
}
const le32 = (v: number) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];

export function xzCompress(data: Uint8Array, level = 6): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.from(XZ_MAGIC)];
  const flags = [0x00, 0x04];                            // CRC64
  parts.push(Uint8Array.from(flags), Uint8Array.from(le32(crc32(Uint8Array.from(flags)))));

  const records: number[] = [];
  let blocks = 0;
  if (data.length > 0) {
    const hdr = [0x02, 0x00, 0x21, 0x01, DICT_BYTE, 0, 0, 0];
    const body = lzma2Encode(data, level);
    parts.push(Uint8Array.from([...hdr, ...le32(crc32(Uint8Array.from(hdr)))]), body, new Uint8Array((4 - (body.length & 3)) & 3));
    const [lo, hi] = crc64(data);
    parts.push(Uint8Array.from([...le32(lo), ...le32(hi)]));
    records.push(...varint(hdr.length + 4 + body.length + 8), ...varint(data.length));
    blocks = 1;
  }
  const index = [0x00, ...varint(blocks), ...records];
  while (index.length & 3) index.push(0);
  parts.push(Uint8Array.from([...index, ...le32(crc32(Uint8Array.from(index)))]));
  const backward = le32((index.length + 4) / 4 - 1);
  parts.push(Uint8Array.from([...le32(crc32(Uint8Array.from([...backward, ...flags]))), ...backward, ...flags, ...FOOTER_MAGIC]));
  return concatBytes(parts);
}

// ── commands ────────────────────────────────────────────────────────

const cmds = makeCodecCommands(
  { name: 'xz', suffixes: ['.xz', '.txz'], compress: (d, l) => xzCompress(d, l), decompress: xzDecompress },
  [{ name: 'unxz', prepend: ['-d'] }, { name: 'xzcat', prepend: ['-dc'] }],
);
export const xzCmd: Command = cmds[0];
export const unxzCmd: Command = cmds[1];
export const xzcatCmd: Command = cmds[2];
