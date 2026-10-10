// inflate.ts — pure-JS gzip/deflate decoder, the fallback where DecompressionStream is missing (older iOS/Safari).

const LBASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
const LEXT  = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
const DBASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
const DEXT  = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
const CLORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

interface Huff { count: Uint16Array; symbol: Uint16Array }

function build(lengths: ArrayLike<number>, n: number): Huff {
    const count = new Uint16Array(16), symbol = new Uint16Array(n), offs = new Uint16Array(16);
    for (let i = 0; i < n; i++) count[lengths[i]]++;
    for (let i = 1; i < 15; i++) offs[i + 1] = offs[i] + count[i];
    for (let i = 0; i < n; i++) if (lengths[i]) symbol[offs[lengths[i]]++] = i;
    return { count, symbol };
}

let fixedL: Huff | null = null, fixedD: Huff | null = null;

export function inflateRaw(src: Uint8Array, start = 0): Uint8Array {
    let pos = start, bitBuf = 0, bitCnt = 0;
    let out = new Uint8Array(Math.max(1024, src.length * 4)), op = 0;
    const bits = (n: number): number => {
        while (bitCnt < n) {
            if (pos >= src.length) throw new Error('Unexpected end of compressed data');
            bitBuf |= src[pos++] << bitCnt; bitCnt += 8;
        }
        const v = bitBuf & ((1 << n) - 1);
        bitBuf >>>= n; bitCnt -= n;
        return v;
    };
    const decode = (h: Huff): number => {
        let code = 0, first = 0, index = 0;
        for (let len = 1; len <= 15; len++) {
            code |= bits(1);
            const c = h.count[len];
            if (code - c < first) return h.symbol[index + (code - first)];
            index += c; first += c; first <<= 1; code <<= 1;
        }
        throw new Error('Invalid compressed data');
    };
    const ensure = (n: number) => {
        if (op + n <= out.length) return;
        const bigger = new Uint8Array(Math.max(out.length * 2, op + n));
        bigger.set(out.subarray(0, op));
        out = bigger;
    };
    let last = 0;
    while (!last) {
        last = bits(1);
        const type = bits(2);
        if (type === 0) {
            bitBuf = 0; bitCnt = 0;
            const len = src[pos] | (src[pos + 1] << 8);
            pos += 4;
            if (pos + len > src.length) throw new Error('Unexpected end of compressed data');
            ensure(len);
            out.set(src.subarray(pos, pos + len), op);
            op += len; pos += len;
            continue;
        }
        let lit: Huff, dist: Huff;
        if (type === 1) {
            if (!fixedL) {
                const l = new Uint8Array(288);
                l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
                fixedL = build(l, 288);
                fixedD = build(new Uint8Array(30).fill(5), 30);
            }
            lit = fixedL; dist = fixedD!;
        } else if (type === 2) {
            const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
            const cl = new Uint8Array(19);
            for (let i = 0; i < ncode; i++) cl[CLORDER[i]] = bits(3);
            const clh = build(cl, 19);
            const lens = new Uint8Array(nlen + ndist);
            for (let i = 0; i < nlen + ndist;) {
                const s = decode(clh);
                if (s < 16) { lens[i++] = s; continue; }
                let prev = 0, rep: number;
                if (s === 16) { if (!i) throw new Error('Invalid compressed data'); prev = lens[i - 1]; rep = 3 + bits(2); }
                else if (s === 17) rep = 3 + bits(3);
                else rep = 11 + bits(7);
                if (i + rep > nlen + ndist) throw new Error('Invalid compressed data');
                while (rep--) lens[i++] = prev;
            }
            lit = build(lens.subarray(0, nlen), nlen);
            dist = build(lens.subarray(nlen), ndist);
        } else throw new Error('Invalid compressed data');
        for (;;) {
            const s = decode(lit);
            if (s < 256) { ensure(1); out[op++] = s; }
            else if (s === 256) break;
            else {
                const li = s - 257;
                if (li >= 29) throw new Error('Invalid compressed data');
                const len = LBASE[li] + bits(LEXT[li]);
                const di = decode(dist);
                if (di >= 30) throw new Error('Invalid compressed data');
                const d = DBASE[di] + bits(DEXT[di]);
                if (d > op) throw new Error('Invalid compressed data');
                ensure(len);
                for (let i = 0; i < len; i++, op++) out[op] = out[op - d];
            }
        }
    }
    return out.subarray(0, op);
}

export function gunzipSync(data: Uint8Array): Uint8Array {
    if (data.length < 18 || data[0] !== 0x1f || data[1] !== 0x8b) throw new Error('Not a gzip file');
    const flg = data[3];
    let p = 10;
    if (flg & 4) p += 2 + (data[p] | (data[p + 1] << 8));
    if (flg & 8) { while (data[p++]); }
    if (flg & 16) { while (data[p++]); }
    if (flg & 2) p += 2;
    return inflateRaw(data, p);
}
