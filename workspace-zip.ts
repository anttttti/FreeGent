// workspace-zip.ts — builds a ZIP archive from in-memory files (the Workspace "Download" button).
// Deflated or stored entries, no ZIP64 (4 GiB limits), UTF-8 names.

let _crcTable: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
    if (!_crcTable) {
        _crcTable = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            _crcTable[i] = c >>> 0;
        }
    }
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = _crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
    const out = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(out).arrayBuffer());
}

function dosStamp(ms: number): { time: number; date: number } {
    const d = new Date(ms);
    const y = Math.max(1980, d.getFullYear());
    return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

export async function zipFiles(files: { name: string; data: Uint8Array; mtime?: number }[]): Promise<Uint8Array> {
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    for (const f of files) {
        const { time, date } = dosStamp(f.mtime || Date.now());
        let method = 0, packed = f.data;
        if (f.data.length > 0) {
            const d = await deflateRaw(f.data);
            if (d.length < f.data.length) { method = 8; packed = d; }
        }
        const crc = crc32(f.data);
        const name = enc.encode(f.name);
        const utf8 = /[^\x00-\x7f]/.test(f.name) ? 0x800 : 0;
        const lh = new Uint8Array(30 + name.length);
        const l = new DataView(lh.buffer);
        l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, utf8, true);
        l.setUint16(8, method, true); l.setUint16(10, time, true); l.setUint16(12, date, true);
        l.setUint32(14, crc, true); l.setUint32(18, packed.length, true); l.setUint32(22, f.data.length, true); l.setUint16(26, name.length, true);
        lh.set(name, 30);
        const ch = new Uint8Array(46 + name.length);
        const c = new DataView(ch.buffer);
        c.setUint32(0, 0x02014b50, true); c.setUint16(4, 0x031e, true); c.setUint16(6, 20, true); c.setUint16(8, utf8, true);
        c.setUint16(10, method, true); c.setUint16(12, time, true); c.setUint16(14, date, true);
        c.setUint32(16, crc, true); c.setUint32(20, packed.length, true); c.setUint32(24, f.data.length, true); c.setUint16(28, name.length, true);
        c.setUint32(38, (0o100644 << 16) >>> 0, true); c.setUint32(42, offset, true);
        ch.set(name, 46);
        parts.push(lh, packed);
        central.push(ch);
        offset += lh.length + packed.length;
    }
    const cdSize = central.reduce((n, x) => n + x.length, 0);
    const end = new Uint8Array(22);
    const v = new DataView(end.buffer);
    v.setUint32(0, 0x06054b50, true); v.setUint16(8, files.length, true); v.setUint16(10, files.length, true);
    v.setUint32(12, cdSize, true); v.setUint32(16, offset, true);
    const all = [...parts, ...central, end];
    const out = new Uint8Array(all.reduce((n, x) => n + x.length, 0));
    let o = 0;
    for (const x of all) { out.set(x, o); o += x.length; }
    return out;
}
