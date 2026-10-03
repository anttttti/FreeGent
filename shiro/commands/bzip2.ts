/**
 * bzip2 / bunzip2 / bzcat — the bzip2 format (BWT + MTF + Huffman), pure TypeScript.
 *
 * Decoder: multiple blocks and concatenated streams, block and stream CRC checks (randomised
 * blocks, which bzip2 stopped producing in 0.9.5, are not supported). Encoder: standard blocks of
 * 100k..900k, a cyclic-rotation sort in O(n log n), up to 6 Huffman tables refined four times.
 * Output is standard bzip2 that any decoder reads.
 */
import type { Command } from './index';
import { makeCodecCommands } from './codec-cli';

// ── CRC (MSB first, polynomial 0x04c11db7) ───────────────────────────

let crcTable: Uint32Array | null = null;
function bzCrc(data: Uint8Array, start = 0, end = data.length): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i << 24;
      for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ data[i]) & 0xff]) >>> 0;
  return (~crc) >>> 0;
}
const combine = (combined: number, block: number) => ((((combined << 1) | (combined >>> 31)) ^ block) >>> 0);

// ── bit I/O ──────────────────────────────────────────────────────────

class BitReader {
  private pos = 0;
  private acc = 0;       // the bits not yet consumed, as a plain number (never more than 31 bits)
  private nbits = 0;
  constructor(private d: Uint8Array) {}
  /** n (<= 24) bits, most significant first */
  bits(n: number): number {
    while (this.nbits < n) {
      if (this.pos >= this.d.length) throw new Error('unexpected end of data');
      this.acc = this.acc * 256 + this.d[this.pos++];
      this.nbits += 8;
    }
    const shift = 2 ** (this.nbits - n);
    const v = Math.floor(this.acc / shift);
    this.acc -= v * shift;
    this.nbits -= n;
    return v;
  }
  bit(): number { return this.bits(1); }
  u32(): number { return this.bits(16) * 65536 + this.bits(16); }
  alignByte() { this.acc = 0; this.nbits = 0; }
  get bitsLeft() { return (this.d.length - this.pos) * 8 + this.nbits; }
}

class BitWriter {
  private out: number[] = [];
  private acc = 0;
  private n = 0;
  write(value: number, count: number) {
    for (let i = count - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((Math.floor(value / 2 ** i)) & 1);
      if (++this.n === 8) { this.out.push(this.acc); this.acc = 0; this.n = 0; }
    }
  }
  finish(): Uint8Array {
    if (this.n) this.out.push((this.acc << (8 - this.n)) & 0xff);
    return Uint8Array.from(this.out);
  }
}

// ── Huffman ──────────────────────────────────────────────────────────

const MAX_CODE_LEN = 17;
const GROUP_SIZE = 50;

interface DecTable { minLen: number; limit: Int32Array; base: Int32Array; perm: Int32Array }

function makeDecTable(lengths: number[], alphaSize: number): DecTable {
  let minLen = 32, maxLen = 0;
  for (let i = 0; i < alphaSize; i++) { if (lengths[i] > maxLen) maxLen = lengths[i]; if (lengths[i] < minLen) minLen = lengths[i]; }
  const perm = new Int32Array(alphaSize);
  let pp = 0;
  for (let l = minLen; l <= maxLen; l++) for (let s = 0; s < alphaSize; s++) if (lengths[s] === l) perm[pp++] = s;
  const base = new Int32Array(24), limit = new Int32Array(24).fill(-1);
  const count = new Int32Array(24);
  for (let i = 0; i < alphaSize; i++) count[lengths[i]]++;
  let vec = 0, idx = 0;
  for (let l = minLen; l <= maxLen; l++) {
    base[l] = idx - vec;                   // perm index = code + base[len]
    vec += count[l];
    idx += count[l];
    limit[l] = vec - 1;
    vec <<= 1;
  }
  return { minLen, limit, base, perm };
}

function decodeSymbol(br: BitReader, t: DecTable): number {
  let len = t.minLen;
  let code = br.bits(len);
  for (;;) {
    if (code <= t.limit[len]) {
      const idx = code + t.base[len];
      if (idx < 0 || idx >= t.perm.length) throw new Error('corrupt Huffman code');
      return t.perm[idx];
    }
    if (++len > 20) throw new Error('corrupt Huffman code');
    code = code * 2 + br.bit();
  }
}

/** Huffman code lengths (<= MAX_CODE_LEN) for the given frequencies; every symbol gets a code. */
function codeLengths(freq: number[], alphaSize: number): number[] {
  const f = freq.slice(0, alphaSize).map(x => Math.max(1, x));
  for (;;) {
    // heap-free two-queue Huffman over sorted weights
    interface Node { w: number; left: number; right: number }
    const nodes: Node[] = f.map(w => ({ w, left: -1, right: -1 }));
    const order = nodes.map((_, i) => i).sort((a, b) => nodes[a].w - nodes[b].w || a - b);
    const q1 = order.slice();
    const q2: number[] = [];
    let i1 = 0, i2 = 0;
    const take = () => {
      if (i2 >= q2.length || (i1 < q1.length && nodes[q1[i1]].w <= nodes[q2[i2]].w)) return q1[i1++];
      return q2[i2++];
    };
    while ((q1.length - i1) + (q2.length - i2) > 1) {
      const a = take(), b = take();
      nodes.push({ w: nodes[a].w + nodes[b].w, left: a, right: b });
      q2.push(nodes.length - 1);
    }
    const lens = new Array(alphaSize).fill(0);
    let tooLong = false;
    const walk = (n: number, d: number) => {
      if (nodes[n].left < 0) { lens[n] = Math.max(d, 1); if (d > MAX_CODE_LEN) tooLong = true; return; }
      walk(nodes[n].left, d + 1);
      walk(nodes[n].right, d + 1);
    };
    walk(nodes.length - 1, 0);
    if (!tooLong) return lens;
    for (let i = 0; i < f.length; i++) f[i] = 1 + (f[i] >> 1);   // flatten the distribution and retry
  }
}

// ── block transform ──────────────────────────────────────────────────

/** Sort the cyclic rotations of s; returns the starting indices in sorted order. */
function sortRotations(s: Uint8Array): Int32Array {
  const n = s.length;
  let p = new Int32Array(n), c = new Int32Array(n);
  const cnt = new Int32Array(Math.max(256, n) + 1);
  for (let i = 0; i < n; i++) cnt[s[i]]++;
  for (let i = 1; i < 256; i++) cnt[i] += cnt[i - 1];
  for (let i = n - 1; i >= 0; i--) p[--cnt[s[i]]] = i;
  c[p[0]] = 0;
  let classes = 1;
  for (let i = 1; i < n; i++) { if (s[p[i]] !== s[p[i - 1]]) classes++; c[p[i]] = classes - 1; }
  let pn = new Int32Array(n), cn = new Int32Array(n);
  for (let h = 1; h < n && classes < n; h <<= 1) {
    for (let i = 0; i < n; i++) { const v = p[i] - h; pn[i] = v < 0 ? v + n : v; }
    cnt.fill(0, 0, classes + 1);
    for (let i = 0; i < n; i++) cnt[c[pn[i]]]++;
    for (let i = 1; i < classes; i++) cnt[i] += cnt[i - 1];
    for (let i = n - 1; i >= 0; i--) p[--cnt[c[pn[i]]]] = pn[i];
    cn[p[0]] = 0;
    classes = 1;
    for (let i = 1; i < n; i++) {
      const a = p[i], b = p[i - 1];
      const a2 = a + h >= n ? a + h - n : a + h, b2 = b + h >= n ? b + h - n : b + h;
      if (c[a] !== c[b] || c[a2] !== c[b2]) classes++;
      cn[a] = classes - 1;
    }
    [c, cn] = [cn, c];
  }
  return p;
}

/** First-stage run-length encoding: 4..255 equal bytes become 4 bytes plus a count (0..251). */
function rle1Block(input: Uint8Array, start: number, maxLen: number): { block: Uint8Array; end: number } {
  const out = new Uint8Array(maxLen + 8);
  let o = 0, i = start;
  while (i < input.length) {
    const b = input[i];
    let run = 1;
    while (i + run < input.length && input[i + run] === b && run < 255) run++;
    const need = run >= 4 ? 5 : run;
    if (o + need > maxLen) break;
    if (run >= 4) { out[o++] = b; out[o++] = b; out[o++] = b; out[o++] = b; out[o++] = run - 4; }
    else for (let k = 0; k < run; k++) out[o++] = b;
    i += run;
  }
  return { block: out.subarray(0, o), end: i };
}

export function bzip2Compress(data: Uint8Array, level = 9): Uint8Array {
  level = Math.min(9, Math.max(1, level | 0));
  const bw = new BitWriter();
  for (const ch of 'BZh') bw.write(ch.charCodeAt(0), 8);
  bw.write(0x30 + level, 8);
  const maxBlock = level * 100000 - 19;
  let combined = 0;
  let pos = 0;
  while (pos < data.length) {
    const { block, end } = rle1Block(data, pos, maxBlock);
    const blockCrc = bzCrc(data, pos, end);
    pos = end;
    combined = combine(combined, blockCrc);
    writeBlock(bw, block, blockCrc);
  }
  bw.write(0x177245, 24); bw.write(0x385090, 24);
  bw.write(combined >>> 16, 16); bw.write(combined & 0xffff, 16);
  return bw.finish();
}

function writeBlock(bw: BitWriter, block: Uint8Array, crc: number) {
  const n = block.length;
  const sa = sortRotations(block);
  const last = new Uint8Array(n);
  let origPtr = 0;
  for (let i = 0; i < n; i++) { const s = sa[i]; if (s === 0) { origPtr = i; last[i] = block[n - 1]; } else last[i] = block[s - 1]; }

  // which byte values occur, and their MTF alphabet
  const used = new Uint8Array(256);
  for (let i = 0; i < n; i++) used[last[i]] = 1;
  const unseq: number[] = [];
  const seqToUnseq = new Int32Array(256);
  for (let i = 0; i < 256; i++) if (used[i]) { seqToUnseq[i] = unseq.length; unseq.push(i); }
  const nInUse = unseq.length;
  const eob = nInUse + 1, alphaSize = nInUse + 2;

  // MTF with zero-run coding (RUNA = 0, RUNB = 1)
  const mtf: number[] = [];
  const freq = new Array(alphaSize).fill(0);
  const list = Array.from({ length: nInUse }, (_, i) => i);
  let zrun = 0;
  const flushRun = () => {
    if (zrun === 0) return;
    let z = zrun;
    while (z > 0) { z--; const sym = z & 1; mtf.push(sym); freq[sym]++; z >>= 1; }   // bijective base 2
    zrun = 0;
  };
  for (let i = 0; i < n; i++) {
    const v = seqToUnseq[last[i]];
    const idx = list.indexOf(v);
    if (idx === 0) { zrun++; continue; }
    flushRun();
    list.splice(idx, 1);
    list.unshift(v);
    mtf.push(idx + 1);
    freq[idx + 1]++;
  }
  flushRun();
  mtf.push(eob);
  freq[eob]++;
  const nMtf = mtf.length;

  // Huffman tables: start from frequency ranges, refine by assigning each group to its best table
  const nGroups = nMtf < 200 ? 2 : nMtf < 600 ? 3 : nMtf < 1200 ? 4 : nMtf < 2400 ? 5 : 6;
  const lens: number[][] = Array.from({ length: nGroups }, () => new Array(alphaSize).fill(15));
  {
    let remaining = nMtf, start = 0;
    for (let t = nGroups; t > 0; t--) {
      const target = Math.floor(remaining / t);
      let end = start - 1, acc = 0;
      while (acc < target && end < alphaSize - 1) acc += freq[++end];
      if (end > start && t !== nGroups && t !== 1 && (nGroups - t) % 2 === 1) acc -= freq[end--];
      for (let v = 0; v < alphaSize; v++) lens[t - 1][v] = v >= start && v <= end ? 0 : 15;
      remaining -= acc;
      start = end + 1;
    }
  }
  const nSel = Math.ceil(nMtf / GROUP_SIZE);
  const selectors = new Array(nSel).fill(0);
  for (let iter = 0; iter < 4; iter++) {
    const tf = Array.from({ length: nGroups }, () => new Array(alphaSize).fill(0));
    for (let g = 0; g < nSel; g++) {
      const lo = g * GROUP_SIZE, hi = Math.min(nMtf, lo + GROUP_SIZE);
      let best = 0, bestCost = Infinity;
      for (let t = 0; t < nGroups; t++) {
        let cost = 0;
        for (let k = lo; k < hi; k++) cost += lens[t][mtf[k]];
        if (cost < bestCost) { bestCost = cost; best = t; }
      }
      selectors[g] = best;
      for (let k = lo; k < hi; k++) tf[best][mtf[k]]++;
    }
    for (let t = 0; t < nGroups; t++) lens[t] = codeLengths(tf[t], alphaSize);
  }

  // canonical codes
  const codes = lens.map(l => {
    const code = new Array(alphaSize).fill(0);
    let minLen = 32, maxLen = 0;
    for (const x of l) { if (x > maxLen) maxLen = x; if (x < minLen) minLen = x; }
    let vec = 0;
    for (let len = minLen; len <= maxLen; len++) {
      for (let s = 0; s < alphaSize; s++) if (l[s] === len) code[s] = vec++;
      vec <<= 1;
    }
    return code;
  });

  // ── write the block
  bw.write(0x314159, 24); bw.write(0x265359, 24);
  bw.write(crc >>> 16, 16); bw.write(crc & 0xffff, 16);
  bw.write(0, 1);                                        // not randomised
  bw.write(origPtr, 24);
  let inUse16 = 0;
  for (let i = 0; i < 16; i++) { let any = false; for (let j = 0; j < 16; j++) if (used[i * 16 + j]) any = true; if (any) inUse16 |= 1 << (15 - i); }
  bw.write(inUse16, 16);
  for (let i = 0; i < 16; i++) {
    if (!(inUse16 & (1 << (15 - i)))) continue;
    let bits = 0;
    for (let j = 0; j < 16; j++) if (used[i * 16 + j]) bits |= 1 << (15 - j);
    bw.write(bits, 16);
  }
  bw.write(nGroups, 3);
  bw.write(nSel, 15);
  const pos = Array.from({ length: nGroups }, (_, i) => i);   // MTF of selectors, unary coded
  for (const sel of selectors) {
    const j = pos.indexOf(sel);
    pos.splice(j, 1); pos.unshift(sel);
    for (let k = 0; k < j; k++) bw.write(1, 1);
    bw.write(0, 1);
  }
  for (let t = 0; t < nGroups; t++) {
    let cur = lens[t][0];
    bw.write(cur, 5);
    for (let s = 0; s < alphaSize; s++) {
      while (cur < lens[t][s]) { bw.write(2, 2); cur++; }
      while (cur > lens[t][s]) { bw.write(3, 2); cur--; }
      bw.write(0, 1);
    }
  }
  for (let g = 0; g < nSel; g++) {
    const t = selectors[g];
    const lo = g * GROUP_SIZE, hi = Math.min(nMtf, lo + GROUP_SIZE);
    for (let k = lo; k < hi; k++) bw.write(codes[t][mtf[k]], lens[t][mtf[k]]);
  }
}

// ── decoder ──────────────────────────────────────────────────────────

class OutBuf {
  buf: Uint8Array; len = 0;
  constructor(n: number) { this.buf = new Uint8Array(Math.max(1024, n)); }
  push(b: number) { if (this.len === this.buf.length) { const nb = new Uint8Array(this.buf.length * 2); nb.set(this.buf); this.buf = nb; } this.buf[this.len++] = b; }
}

export function bzip2Decompress(data: Uint8Array): Uint8Array {
  const out = new OutBuf(data.length * 4);
  const br = new BitReader(data);
  let streams = 0;
  while (br.bitsLeft >= 32) {
    if (br.bits(8) !== 0x42 || br.bits(8) !== 0x5a || br.bits(8) !== 0x68) {
      if (streams > 0) break;                     // trailing garbage after a good stream
      throw new Error('data is not in bzip2 format (bad magic)');
    }
    const lv = br.bits(8) - 0x30;
    if (lv < 1 || lv > 9) throw new Error('data is not in bzip2 format (bad block size)');
    const maxBlock = lv * 100000;
    let combined = 0;
    for (;;) {
      const m1 = br.bits(24), m2 = br.bits(24);
      if (m1 === 0x177245 && m2 === 0x385090) {
        const want = br.u32();
        if (want !== combined) throw new Error('stream CRC mismatch (corrupt data)');
        br.alignByte();
        break;
      }
      if (m1 !== 0x314159 || m2 !== 0x265359) throw new Error('corrupt data (bad block header)');
      const blockCrc = br.u32();
      if (br.bit()) throw new Error('randomised blocks are not supported');
      const origPtr = br.bits(24);
      // symbol map
      const inUse16 = br.bits(16);
      const seqToUnseq: number[] = [];
      for (let i = 0; i < 16; i++) if (inUse16 & (1 << (15 - i))) {
        const bits = br.bits(16);
        for (let j = 0; j < 16; j++) if (bits & (1 << (15 - j))) seqToUnseq.push(i * 16 + j);
      }
      const nInUse = seqToUnseq.length;
      if (nInUse === 0) throw new Error('corrupt data (empty symbol map)');
      const alphaSize = nInUse + 2;
      const nGroups = br.bits(3);
      if (nGroups < 2 || nGroups > 6) throw new Error('corrupt data (bad table count)');
      const nSel = br.bits(15);
      if (nSel < 1) throw new Error('corrupt data (no selectors)');
      const selMtf: number[] = [];
      const pos = Array.from({ length: nGroups }, (_, i) => i);
      for (let i = 0; i < nSel; i++) {
        let j = 0;
        while (br.bit()) { if (++j >= nGroups) throw new Error('corrupt data (bad selector)'); }
        const v = pos[j];
        pos.splice(j, 1); pos.unshift(v);
        selMtf.push(v);
      }
      const tables: DecTable[] = [];
      for (let t = 0; t < nGroups; t++) {
        let cur = br.bits(5);
        const lens: number[] = [];
        for (let s = 0; s < alphaSize; s++) {
          for (;;) {
            if (cur < 1 || cur > 20) throw new Error('corrupt data (bad code length)');
            if (!br.bit()) break;
            cur += br.bit() ? -1 : 1;
          }
          lens.push(cur);
        }
        tables.push(makeDecTable(lens, alphaSize));
      }
      // Huffman → MTF/RLE2 → the last column
      const eob = nInUse + 1;
      const tt = new Uint32Array(maxBlock);
      const unzftab = new Int32Array(256);
      const yy = Array.from({ length: nInUse }, (_, i) => i);
      let nblock = 0, groupNo = -1, groupPos = 0, table!: DecTable;
      let run = 0, runBit = 1;
      const emitRun = () => {
        if (run === 0) return;
        const b = seqToUnseq[yy[0]];
        if (nblock + run > maxBlock) throw new Error('corrupt data (block overflow)');
        unzftab[b] += run;
        for (let k = 0; k < run; k++) tt[nblock++] = b;
        run = 0; runBit = 1;
      };
      for (;;) {
        if (groupPos === 0) {
          groupNo++;
          if (groupNo >= nSel) throw new Error('corrupt data (selectors exhausted)');
          groupPos = GROUP_SIZE;
          table = tables[selMtf[groupNo]];
        }
        groupPos--;
        const sym = decodeSymbol(br, table);
        if (sym <= 1) { run += runBit << sym; runBit <<= 1; if (run > maxBlock) throw new Error('corrupt data (run too long)'); continue; }
        emitRun();
        if (sym === eob) break;
        const idx = sym - 1;
        const v = yy[idx];
        yy.splice(idx, 1); yy.unshift(v);
        const b = seqToUnseq[v];
        if (nblock >= maxBlock) throw new Error('corrupt data (block overflow)');
        unzftab[b]++;
        tt[nblock++] = b;
      }
      if (origPtr >= nblock) throw new Error('corrupt data (bad origin pointer)');
      // inverse BWT
      const cftab = new Int32Array(257);
      for (let i = 0; i < 256; i++) cftab[i + 1] = cftab[i] + unzftab[i];
      for (let i = 0; i < nblock; i++) { const b = tt[i] & 0xff; tt[cftab[b]++] |= i << 8; }
      let tPos = tt[origPtr] >>> 8;
      // un-RLE1 while writing out
      const start = out.len;
      let prev = -1, same = 0;
      for (let i = 0; i < nblock; i++) {
        tPos = tt[tPos];
        const b = tPos & 0xff;
        tPos >>>= 8;
        if (same === 4) {                       // this byte is a repeat count
          for (let k = 0; k < b; k++) out.push(prev);
          same = 0; prev = -1;
          continue;
        }
        if (b === prev) same++; else { same = 1; prev = b; }
        out.push(b);
      }
      if (bzCrc(out.buf, start, out.len) !== blockCrc) throw new Error('block CRC mismatch (corrupt data)');
      combined = combine(combined, blockCrc);
    }
    streams++;
  }
  if (streams === 0) throw new Error('data is not in bzip2 format');
  return out.buf.slice(0, out.len);
}

// ── commands ─────────────────────────────────────────────────────────

const cmds = makeCodecCommands(
  { name: 'bzip2', suffixes: ['.bz2', '.bz'], defaultLevel: 9, dataErrorStatus: 2, compress: (d, l) => bzip2Compress(d, l), decompress: bzip2Decompress },
  [{ name: 'bunzip2', prepend: ['-d'] }, { name: 'bzcat', prepend: ['-dc'] }],
);
export const bzip2Cmd: Command = cmds[0];
export const bunzip2Cmd: Command = cmds[1];
export const bzcatCmd: Command = cmds[2];
