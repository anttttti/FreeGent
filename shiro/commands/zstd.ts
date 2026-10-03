/**
 * zstd / unzstd / zstdcat — Zstandard (RFC 8878), pure TypeScript.
 *
 * Decoder: complete for single and multi-frame streams (raw/RLE/compressed blocks, Huffman and
 * FSE entropy coding, repeat offsets, content checksum). Dictionaries are not supported.
 * Encoder: LZ77 matching (hash chains) with sequences coded through the predefined FSE tables
 * and raw literals; incompressible blocks are stored. Output is standard zstd that any decoder reads.
 */
import type { Command } from './index';
import { makeCodecCommands, concatBytes } from './codec-cli';
import { xxh64 } from './checksums';

const ZSTD_MAGIC = 0xfd2fb528;
const BLOCK_MAX = 1 << 17;
const CHECKSUM_LIMIT = 32 << 20;   // BigInt XXH64 is slow; skip it on very large frames

// ── FSE ─────────────────────────────────────────────────────────────

interface FSETable { al: number; sym: Uint8Array; nb: Uint8Array; base: Int32Array }

function buildFSE(counts: ArrayLike<number>, al: number): FSETable {
  const size = 1 << al;
  const sym = new Uint8Array(size), nb = new Uint8Array(size), base = new Int32Array(size);
  const next = new Int32Array(counts.length);
  let high = size - 1;
  for (let s = 0; s < counts.length; s++) {
    if (counts[s] === -1) { sym[high--] = s; next[s] = 1; } else next[s] = counts[s];
  }
  const step = (size >> 1) + (size >> 3) + 3, mask = size - 1;
  let pos = 0;
  for (let s = 0; s < counts.length; s++) {
    for (let i = 0; i < counts[s]; i++) {
      sym[pos] = s;
      do { pos = (pos + step) & mask; } while (pos > high);
    }
  }
  if (pos !== 0) throw new Error('corrupt FSE table');
  for (let st = 0; st < size; st++) {
    const ns = next[sym[st]]++;
    const bits = al - (31 - Math.clz32(ns));
    nb[st] = bits;
    base[st] = (ns << bits) - size;
  }
  return { al, sym, nb, base };
}

function readFSEDescription(d: Uint8Array, start: number, end: number, maxSym: number, maxAL: number): { counts: number[]; al: number; pos: number } {
  let bit = 0;
  const peek = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const p = bit + i;
      const byte = start + (p >> 3) < end ? d[start + (p >> 3)] : 0;
      v |= ((byte >> (p & 7)) & 1) << i;
    }
    return v;
  };
  const al = 5 + peek(4);
  bit += 4;
  if (al > maxAL) throw new Error('corrupt FSE accuracy log');
  let remaining = (1 << al) + 1, threshold = 1 << al, nbBits = al + 1;
  const counts: number[] = [];
  let sym = 0, prev0 = false;
  while (remaining > 1 && sym <= maxSym) {
    if (prev0) {
      let n0 = sym;
      for (;;) { const r = peek(2); bit += 2; n0 += r; if (r !== 3) break; }
      while (sym < n0) counts[sym++] = 0;
      if (sym > maxSym) break;
    }
    const max = (2 * threshold - 1) - remaining;
    const v = peek(nbBits);
    let count: number;
    if ((v & (threshold - 1)) < max) { count = v & (threshold - 1); bit += nbBits - 1; }
    else { count = v & (2 * threshold - 1); if (count >= threshold) count -= max; bit += nbBits; }
    count--;
    remaining -= count < 0 ? -count : count;
    counts[sym++] = count;
    prev0 = count === 0;
    while (remaining < threshold) { nbBits--; threshold >>= 1; }
  }
  if (remaining !== 1) throw new Error('corrupt FSE table description');
  if (start + ((bit + 7) >> 3) > end) throw new Error('truncated FSE table');
  return { counts, al, pos: start + ((bit + 7) >> 3) };
}

// ── backward bit reader (bits are consumed from the end of the stream) ──

class BackBits {
  pos: number;   // unread data bits; the next read takes the bits just below this index
  constructor(private d: Uint8Array, private start: number, end: number) {
    const last = end > start ? d[end - 1] : 0;
    if (!last) throw new Error('corrupt bitstream: missing end mark');
    this.pos = (end - 1 - start) * 8 + (31 - Math.clz32(last));
  }
  private bits(p: number, n: number): number {
    let v = 0;
    for (let i = 0; i < n;) {
      const q = p + i;
      const take = Math.min(8 - (q & 7), n - i);
      v += ((this.d[this.start + (q >> 3)] >> (q & 7)) & ((1 << take) - 1)) * 2 ** i;
      i += take;
    }
    return v;
  }
  peekAt(p: number, n: number): number {
    if (n === 0) return 0;
    if (p >= 0) return this.bits(p, n);
    const k = n + p;
    return k <= 0 ? 0 : this.bits(0, k) * 2 ** -p;
  }
  read(n: number): number { if (n === 0) return 0; this.pos -= n; return this.peekAt(this.pos, n); }
  peek(n: number): number { return this.peekAt(this.pos - n, n); }
  get overflow() { return this.pos < 0; }
}

// ── Huffman ─────────────────────────────────────────────────────────

interface HufTable { maxBits: number; sym: Uint8Array; nb: Uint8Array }

function decodeFSEWeights(d: Uint8Array, start: number, end: number): number[] {
  const desc = readFSEDescription(d, start, end, 12, 6);
  const t = buildFSE(desc.counts, desc.al);
  const bb = new BackBits(d, desc.pos, end);
  let s1 = bb.read(t.al), s2 = bb.read(t.al);
  const out: number[] = [];
  for (;;) {
    out.push(t.sym[s1]);
    s1 = t.base[s1] + bb.read(t.nb[s1]);
    if (bb.overflow) { out.push(t.sym[s2]); break; }
    out.push(t.sym[s2]);
    s2 = t.base[s2] + bb.read(t.nb[s2]);
    if (bb.overflow) { out.push(t.sym[s1]); break; }
    if (out.length > 255) throw new Error('corrupt Huffman weights');
  }
  return out;
}

function readHuffmanTree(d: Uint8Array, pos: number, end: number): { table: HufTable; pos: number } {
  const hb = d[pos++];
  let weights: number[];
  if (hb >= 128) {
    const n = hb - 127;
    weights = [];
    for (let i = 0; i < n; i++) { const b = d[pos + (i >> 1)]; weights.push(i & 1 ? b & 15 : b >> 4); }
    pos += (n + 1) >> 1;
  } else {
    weights = decodeFSEWeights(d, pos, pos + hb);
    pos += hb;
  }
  if (pos > end) throw new Error('truncated Huffman tree');
  let sum = 0;
  for (const w of weights) if (w > 0) sum += 1 << (w - 1);
  if (sum === 0) throw new Error('corrupt Huffman tree');
  const maxBits = 32 - Math.clz32(sum);        // 2^maxBits > sum
  if (maxBits > 11) throw new Error('corrupt Huffman tree');
  const rest = (1 << maxBits) - sum;
  if (rest & (rest - 1)) throw new Error('corrupt Huffman tree');
  weights.push(32 - Math.clz32(rest));          // implied last weight
  const sym = new Uint8Array(1 << maxBits), nb = new Uint8Array(1 << maxBits);
  let p = 0;
  for (let w = 1; w <= maxBits; w++) {
    for (let s = 0; s < weights.length; s++) {
      if (weights[s] !== w) continue;
      const len = 1 << (w - 1);
      sym.fill(s, p, p + len);
      nb.fill(maxBits + 1 - w, p, p + len);
      p += len;
    }
  }
  return { table: { maxBits, sym, nb }, pos };
}

function huffDecode(t: HufTable, d: Uint8Array, start: number, end: number, out: Uint8Array, o: number, count: number) {
  const bb = new BackBits(d, start, end);
  for (let i = 0; i < count; i++) {
    const idx = bb.peek(t.maxBits);
    out[o + i] = t.sym[idx];
    bb.pos -= t.nb[idx];
  }
  if (bb.pos !== 0) throw new Error('corrupt Huffman stream');
}

// ── sequence tables ─────────────────────────────────────────────────

const LL_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
const LL_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const ML_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771, 65539];
const ML_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const LL_DEFAULT = [4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1];
const ML_DEFAULT = [1, 4, 3, 2, 2, 2, 2, 2, 2, ...new Array(37).fill(1), ...new Array(7).fill(-1)];
const OF_DEFAULT = [1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1];

let predefined: { ll: FSETable; ml: FSETable; of: FSETable } | null = null;
function getPredefined() {
  return predefined ??= { ll: buildFSE(LL_DEFAULT, 6), ml: buildFSE(ML_DEFAULT, 6), of: buildFSE(OF_DEFAULT, 5) };
}

// ── decoder ─────────────────────────────────────────────────────────

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

interface FrameState {
  huf: HufTable | null;
  ll: FSETable | null; of: FSETable | null; ml: FSETable | null;
  rep: [number, number, number];
}

function tableForMode(mode: number, d: Uint8Array, pos: number, end: number, maxSym: number, maxAL: number, def: FSETable, prev: FSETable | null): { t: FSETable; pos: number } {
  switch (mode) {
    case 0: return { t: def, pos };
    case 1: {
      if (pos >= end) throw new Error('truncated block');
      return { t: { al: 0, sym: Uint8Array.of(d[pos]), nb: Uint8Array.of(0), base: Int32Array.of(0) }, pos: pos + 1 };
    }
    case 2: {
      const r = readFSEDescription(d, pos, end, maxSym, maxAL);
      return { t: buildFSE(r.counts, r.al), pos: r.pos };
    }
    default:
      if (!prev) throw new Error('corrupt block: repeat table without previous table');
      return { t: prev, pos };
  }
}

function decodeCompressedBlock(d: Uint8Array, start: number, end: number, out: OutBuf, frameStart: number, st: FrameState) {
  let pos = start;
  // ── literals section
  const b0 = d[pos];
  const litType = b0 & 3, sizeFmt = (b0 >> 2) & 3;
  let regen: number, csize = 0, hdr: number;
  if (litType <= 1) {
    if (sizeFmt === 0 || sizeFmt === 2) { regen = b0 >> 3; hdr = 1; }
    else if (sizeFmt === 1) { regen = (b0 >> 4) | (d[pos + 1] << 4); hdr = 2; }
    else { regen = (b0 >> 4) | (d[pos + 1] << 4) | (d[pos + 2] << 12); hdr = 3; }
  } else {
    hdr = sizeFmt <= 1 ? 3 : sizeFmt === 2 ? 4 : 5;
    const bitsEach = sizeFmt <= 1 ? 10 : sizeFmt === 2 ? 14 : 18;
    let w = 0;
    for (let i = 0; i < hdr; i++) w += d[pos + i] * 2 ** (8 * i);
    regen = Math.floor(w / 16) % 2 ** bitsEach;
    csize = Math.floor(w / 2 ** (4 + bitsEach)) % 2 ** bitsEach;
  }
  pos += hdr;
  let literals: Uint8Array;
  if (litType === 0) {
    if (pos + regen > end) throw new Error('truncated literals');
    literals = d.subarray(pos, pos + regen);
    pos += regen;
  } else if (litType === 1) {
    literals = new Uint8Array(regen).fill(d[pos]);
    pos += 1;
  } else {
    const litEnd = pos + csize;
    if (litEnd > end) throw new Error('truncated literals');
    let hp = pos;
    if (litType === 2) {
      const r = readHuffmanTree(d, pos, litEnd);
      st.huf = r.table;
      hp = r.pos;
    } else if (!st.huf) throw new Error('corrupt block: treeless literals without a Huffman table');
    literals = new Uint8Array(regen);
    const fourStreams = sizeFmt !== 0;
    if (!fourStreams) huffDecode(st.huf, d, hp, litEnd, literals, 0, regen);
    else {
      const s1 = d[hp] | (d[hp + 1] << 8), s2 = d[hp + 2] | (d[hp + 3] << 8), s3 = d[hp + 4] | (d[hp + 5] << 8);
      const a = hp + 6, b = a + s1, c = b + s2, e = c + s3;
      if (e > litEnd) throw new Error('corrupt literal streams');
      const seg = (regen + 3) >> 2;
      huffDecode(st.huf, d, a, b, literals, 0, seg);
      huffDecode(st.huf, d, b, c, literals, seg, seg);
      huffDecode(st.huf, d, c, e, literals, 2 * seg, seg);
      huffDecode(st.huf, d, e, litEnd, literals, 3 * seg, regen - 3 * seg);
    }
    pos = litEnd;
  }

  // ── sequences section
  let nbSeq = d[pos++];
  if (nbSeq === 0) {
    out.ensure(literals.length);
    out.buf.set(literals, out.len);
    out.len += literals.length;
    if (pos !== end) throw new Error('corrupt block: trailing bytes');
    return;
  }
  if (nbSeq >= 128) {
    if (nbSeq < 255) nbSeq = ((nbSeq - 128) << 8) + d[pos++];
    else { nbSeq = d[pos] + (d[pos + 1] << 8) + 0x7f00; pos += 2; }
  }
  const modes = d[pos++];
  const pre = getPredefined();
  let r = tableForMode((modes >> 6) & 3, d, pos, end, 35, 9, pre.ll, st.ll); st.ll = r.t; pos = r.pos;
  r = tableForMode((modes >> 4) & 3, d, pos, end, 31, 8, pre.of, st.of); st.of = r.t; pos = r.pos;
  r = tableForMode((modes >> 2) & 3, d, pos, end, 52, 9, pre.ml, st.ml); st.ml = r.t; pos = r.pos;
  const ll = st.ll!, of = st.of!, ml = st.ml!;

  const bb = new BackBits(d, pos, end);
  let sLL = bb.read(ll.al), sOF = bb.read(of.al), sML = bb.read(ml.al);
  let lp = 0;
  let [r0, r1, r2] = st.rep;
  for (let i = 0; i < nbSeq; i++) {
    const ofCode = of.sym[sOF], mlCode = ml.sym[sML], llCode = ll.sym[sLL];
    if (mlCode > 52 || llCode > 35) throw new Error('corrupt sequence code');
    let offVal = 2 ** ofCode + bb.read(ofCode);
    const mLen = ML_BASE[mlCode] + bb.read(ML_BITS[mlCode]);
    const lLen = LL_BASE[llCode] + bb.read(LL_BITS[llCode]);
    if (i < nbSeq - 1) {
      sLL = ll.base[sLL] + bb.read(ll.nb[sLL]);
      sML = ml.base[sML] + bb.read(ml.nb[sML]);
      sOF = of.base[sOF] + bb.read(of.nb[sOF]);
    }
    if (bb.overflow) throw new Error('corrupt sequence bitstream');

    let offset: number;
    if (offVal > 3) { offset = offVal - 3; r2 = r1; r1 = r0; r0 = offset; }
    else {
      let idx = offVal;
      if (lLen === 0) idx++;
      if (idx === 1) offset = r0;
      else if (idx === 2) { offset = r1; r1 = r0; r0 = offset; }
      else if (idx === 3) { offset = r2; r2 = r1; r1 = r0; r0 = offset; }
      else { offset = r0 - 1; if (offset <= 0) throw new Error('corrupt repeat offset'); r2 = r1; r1 = r0; r0 = offset; }
    }
    if (lp + lLen > literals.length) throw new Error('corrupt sequence: literals overrun');
    out.ensure(lLen + mLen);
    out.buf.set(literals.subarray(lp, lp + lLen), out.len);
    out.len += lLen;
    lp += lLen;
    if (offset > out.len - frameStart) throw new Error('corrupt sequence: offset beyond window');
    const buf = out.buf;
    let o = out.len;
    const from = o - offset;
    if (offset >= mLen) buf.copyWithin(o, from, from + mLen);
    else for (let k = 0; k < mLen; k++) buf[o + k] = buf[from + k];
    out.len = o + mLen;
  }
  st.rep = [r0, r1, r2];
  const tail = literals.length - lp;
  out.ensure(tail);
  out.buf.set(literals.subarray(lp), out.len);
  out.len += tail;
}

export function zstdDecompress(data: Uint8Array): Uint8Array {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const n = data.length;
  if (n < 4) throw new Error('not in zstd format');
  const out = new OutBuf(n * 4);
  let p = 0;
  let sawFrame = false;
  while (p < n) {
    if (p + 4 > n) throw new Error('truncated input');
    const magic = dv.getUint32(p, true);
    if ((magic & 0xfffffff0) === 0x184d2a50) {          // skippable frame
      if (p + 8 > n) throw new Error('truncated input');
      p += 8 + dv.getUint32(p + 4, true);
      sawFrame = true;
      continue;
    }
    if (magic !== ZSTD_MAGIC) throw new Error(sawFrame ? 'trailing garbage after zstd frame' : 'not in zstd format');
    p += 4;
    const fhd = data[p++];
    if (fhd & 8) throw new Error('corrupt frame header (reserved bit set)');
    const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, cksum = (fhd >> 2) & 1, dictFlag = fhd & 3;
    if (!single) p++;                                    // window descriptor
    const dictLen = [0, 1, 2, 4][dictFlag];
    let dictId = 0;
    for (let i = 0; i < dictLen; i++) dictId += data[p + i] * 2 ** (8 * i);
    p += dictLen;
    if (dictId !== 0) throw new Error('frame needs a dictionary (not supported)');
    const fcsLen = [single ? 1 : 0, 2, 4, 8][fcsFlag];
    let fcs = -1;
    if (fcsLen) {
      fcs = 0;
      for (let i = 0; i < fcsLen; i++) fcs += data[p + i] * 2 ** (8 * i);
      if (fcsLen === 2) fcs += 256;
    }
    p += fcsLen;
    if (fcs > 0 && fcs < 2 ** 31) out.ensure(Math.min(fcs, 1 << 30));
    const frameStart = out.len;
    const st: FrameState = { huf: null, ll: null, of: null, ml: null, rep: [1, 4, 8] };
    for (let last = false; !last;) {
      if (p + 3 > n) throw new Error('truncated input');
      const bh = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16);
      p += 3;
      last = (bh & 1) === 1;
      const type = (bh >> 1) & 3, size = bh >> 3;
      if (type === 0) {
        if (p + size > n) throw new Error('truncated input');
        out.ensure(size);
        out.buf.set(data.subarray(p, p + size), out.len);
        out.len += size;
        p += size;
      } else if (type === 1) {
        if (p >= n) throw new Error('truncated input');
        out.ensure(size);
        out.buf.fill(data[p], out.len, out.len + size);
        out.len += size;
        p += 1;
      } else if (type === 2) {
        if (size > BLOCK_MAX || p + size > n) throw new Error(p + size > n ? 'truncated input' : 'corrupt block size');
        decodeCompressedBlock(data, p, p + size, out, frameStart, st);
        p += size;
      } else throw new Error('corrupt block type');
    }
    if (fcs >= 0 && out.len - frameStart !== fcs) throw new Error('frame content size mismatch');
    if (cksum) {
      if (p + 4 > n) throw new Error('truncated input');
      const produced = out.len - frameStart;
      if (produced <= CHECKSUM_LIMIT) {
        const want = dv.getUint32(p, true);
        const got = Number(xxh64(out.buf.subarray(frameStart, out.len)) & 0xffffffffn);
        if (want !== got) throw new Error('checksum mismatch (corrupt data)');
      }
      p += 4;
    }
    sawFrame = true;
  }
  return out.buf.slice(0, out.len);
}

// ── encoder ─────────────────────────────────────────────────────────

class BitWriter {
  private bytes: number[] = [];
  private acc = 0;
  private nbits = 0;
  write(v: number, n: number) {
    while (n > 0) {
      const take = Math.min(n, 8 - this.nbits);
      this.acc |= (v % (1 << take)) << this.nbits;
      v = Math.floor(v / (1 << take));
      this.nbits += take;
      n -= take;
      if (this.nbits === 8) { this.bytes.push(this.acc); this.acc = 0; this.nbits = 0; }
    }
  }
  finish(): number[] {
    this.write(1, 1);                       // end mark
    if (this.nbits) { this.bytes.push(this.acc); this.acc = 0; this.nbits = 0; }
    return this.bytes;
  }
}

interface EncTable { t: FSETable; byState: Map<number, number[]> }
function encTable(t: FSETable): EncTable {
  const byState = new Map<number, number[]>();
  for (let s = 0; s < t.sym.length; s++) {
    const l = byState.get(t.sym[s]);
    if (l) l.push(s); else byState.set(t.sym[s], [s]);
  }
  for (const l of byState.values()) l.sort((a, b) => t.base[a] - t.base[b]);
  return { t, byState };
}
/** Pick the decoder state that emits `symbol` and can step to `next`; returns [state, bits, nbBits]. */
function encStep(e: EncTable, symbol: number, next: number | null): [number, number, number] {
  const list = e.byState.get(symbol);
  if (!list) throw new Error('internal: symbol missing from FSE table');
  if (next === null) return [list[0], 0, 0];
  for (const x of list) {
    const b = e.t.base[x];
    if (next >= b && next < b + (1 << e.t.nb[x])) return [x, next - b, e.t.nb[x]];
  }
  throw new Error('internal: no FSE state transition');
}

const codeFor = (value: number, base: number[]) => {
  let lo = 0, hi = base.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (base[mid] <= value) lo = mid; else hi = mid - 1; }
  return lo;
};

interface Seq { ll: number; ml: number; off: number }

function encodeSequences(seqs: Seq[]): number[] {
  const pre = getPredefined();
  const eLL = encTable(pre.ll), eML = encTable(pre.ml), eOF = encTable(pre.of);
  const n = seqs.length;
  const llc = seqs.map(s => codeFor(s.ll, LL_BASE));
  const mlc = seqs.map(s => codeFor(s.ml, ML_BASE));
  const ofv = seqs.map(s => s.off + 3);
  const ofc = ofv.map(v => 31 - Math.clz32(v));
  const bw = new BitWriter();
  let nLL: number | null = null, nML: number | null = null, nOF: number | null = null;
  for (let i = n - 1; i >= 0; i--) {
    const [xLL, bLL, nbLL] = encStep(eLL, llc[i], nLL);
    const [xML, bML, nbML] = encStep(eML, mlc[i], nML);
    const [xOF, bOF, nbOF] = encStep(eOF, ofc[i], nOF);
    if (i < n - 1) { bw.write(bOF, nbOF); bw.write(bML, nbML); bw.write(bLL, nbLL); }
    bw.write(seqs[i].ll - LL_BASE[llc[i]], LL_BITS[llc[i]]);
    bw.write(seqs[i].ml - ML_BASE[mlc[i]], ML_BITS[mlc[i]]);
    bw.write(ofv[i] - 2 ** ofc[i], ofc[i]);
    nLL = xLL; nML = xML; nOF = xOF;
  }
  bw.write(nML!, pre.ml.al);
  bw.write(nOF!, pre.of.al);
  bw.write(nLL!, pre.ll.al);
  return bw.finish();
}

function hash4(d: Uint8Array, i: number): number {
  return (Math.imul((d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)), 2654435761) >>> 15);
}

function compressBlock(data: Uint8Array, bs: number, be: number, head: Int32Array, prev: Int32Array, depth: number, hashedUpTo: { v: number }): Uint8Array | null {
  const seqs: Seq[] = [];
  const lits: number[] = [];
  let litStart = bs;
  let i = bs;
  const insert = (upto: number) => {
    for (let k = hashedUpTo.v; k < upto && k + 4 <= data.length; k++) {
      const h = hash4(data, k);
      prev[k] = head[h];
      head[h] = k;
    }
    if (upto > hashedUpTo.v) hashedUpTo.v = upto;
  };
  insert(bs);
  while (i < be) {
    let bestLen = 0, bestOff = 0;
    if (i + 4 <= be) {
      let cand = head[hash4(data, i)];
      const maxLen = be - i;
      for (let tries = 0; cand >= 0 && tries < depth; tries++, cand = prev[cand]) {
        if (cand >= i) continue;
        if (data[cand + bestLen] !== data[i + bestLen] && bestLen > 0) continue;
        let l = 0;
        while (l < maxLen && data[cand + l] === data[i + l]) l++;
        if (l > bestLen) { bestLen = l; bestOff = i - cand; if (l === maxLen) break; }
      }
    }
    if (bestLen >= 4) {
      for (let k = litStart; k < i; k++) lits.push(data[k]);
      seqs.push({ ll: i - litStart, ml: bestLen, off: bestOff });
      i += bestLen;
      litStart = i;
      insert(i);
    } else {
      i++;
      insert(i);
    }
  }
  insert(be);
  for (let k = litStart; k < be; k++) lits.push(data[k]);
  if (seqs.length === 0) return null;

  const out: number[] = [];
  const ls = lits.length;
  if (ls < 32) out.push(ls << 3);
  else if (ls < 4096) out.push(4 | ((ls & 15) << 4), ls >> 4);
  else out.push(12 | ((ls & 15) << 4), (ls >> 4) & 255, ls >> 12);
  for (const b of lits) out.push(b);
  const ns = seqs.length;
  if (ns < 128) out.push(ns);
  else if (ns < 0x7f00) out.push((ns >> 8) + 128, ns & 255);
  else out.push(255, (ns - 0x7f00) & 255, (ns - 0x7f00) >> 8);
  out.push(0);                                          // all three tables predefined
  for (const b of encodeSequences(seqs)) out.push(b);
  return Uint8Array.from(out);
}

export function zstdCompress(data: Uint8Array, level = 3): Uint8Array {
  const n = data.length;
  const parts: Uint8Array[] = [];
  const header: number[] = [0x28, 0xb5, 0x2f, 0xfd];
  const useChecksum = n <= CHECKSUM_LIMIT;
  const fcsFlag = n < 256 ? 0 : n < 65792 ? 1 : n < 2 ** 32 ? 2 : 3;
  header.push((fcsFlag << 6) | 0x20 | (useChecksum ? 4 : 0));   // single segment: window = content size
  const fcsLen = [1, 2, 4, 8][fcsFlag];
  let fv = fcsFlag === 1 ? n - 256 : n;
  for (let i = 0; i < fcsLen; i++) { header.push(fv % 256); fv = Math.floor(fv / 256); }
  parts.push(Uint8Array.from(header));

  const depth = Math.max(4, Math.min(64, level * 8));
  const head = new Int32Array(1 << 17).fill(-1);
  const prev = new Int32Array(Math.max(n, 1)).fill(-1);
  const hashed = { v: 0 };
  const blockHeader = (last: boolean, type: number, size: number) => {
    const v = (last ? 1 : 0) | (type << 1) | (size << 3);
    return Uint8Array.of(v & 255, (v >> 8) & 255, (v >> 16) & 255);
  };
  if (n === 0) parts.push(blockHeader(true, 0, 0));
  for (let bs = 0; bs < n; bs += BLOCK_MAX) {
    const be = Math.min(n, bs + BLOCK_MAX);
    const size = be - bs;
    const last = be === n;
    let rle = true;
    for (let k = bs + 1; k < be && rle; k++) if (data[k] !== data[bs]) rle = false;
    if (rle) {
      parts.push(blockHeader(last, 1, size), Uint8Array.of(data[bs]));
      continue;
    }
    const comp = compressBlock(data, bs, be, head, prev, depth, hashed);
    if (comp && comp.length < size) {
      parts.push(blockHeader(last, 2, comp.length), comp);
    } else {
      parts.push(blockHeader(last, 0, size), data.subarray(bs, be));
    }
  }
  if (useChecksum) {
    const h = Number(xxh64(data) & 0xffffffffn);
    parts.push(Uint8Array.of(h & 255, (h >>> 8) & 255, (h >>> 16) & 255, (h >>> 24) & 255));
  }
  return concatBytes(parts);
}

// ── commands ────────────────────────────────────────────────────────

const cmds = makeCodecCommands(
  { name: 'zstd', suffixes: ['.zst', '.zstd'], keepSource: true, compress: (d, l) => zstdCompress(d, l > 19 ? 19 : l), decompress: zstdDecompress },
  [{ name: 'unzstd', prepend: ['-d'] }, { name: 'zstdcat', prepend: ['-dc'] }],
);
export const zstdCmd: Command = cmds[0];
export const unzstdCmd: Command = cmds[1];
export const zstdcatCmd: Command = cmds[2];
