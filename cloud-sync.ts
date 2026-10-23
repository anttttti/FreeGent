// cloud-sync.ts — client for the Worker's /sync routes (cf-worker/worker.js): per-file project sync.
// A project is a manifest (path → {h: SHA-256 hex, s: size, e?: 'base64', m?: mtime}) plus content-addressed blobs. Pure protocol and hashing here;
// workspace.ts decides what to copy.

export interface CloudFile { h: string; s: number; e?: 'base64'; m?: number }
export interface CloudManifest { files: Record<string, CloudFile> }

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 in plain JS: pages served over plain HTTP (a LAN address, older iPads) have no crypto.subtle. */
export function sha256Js(data: Uint8Array): string {
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const len = data.length, total = ((len + 9 + 63) >> 6) << 6;
    const buf = new Uint8Array(total); buf.set(data); buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, Math.floor(len / 0x20000000)); dv.setUint32(total - 4, (len << 3) >>> 0);
    const w = new Uint32Array(64);
    const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < total; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let [a, b, c, d, e, f, g, hh] = h;
        for (let i = 0; i < 64; i++) {
            const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
            const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
            hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    return Array.from(h, x => x.toString(16).padStart(8, '0')).join('');
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
    const subtle = (globalThis as any).crypto?.subtle;
    if (subtle) {
        try { return Array.from(new Uint8Array(await subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join(''); } catch {}
    }
    return sha256Js(data);
}

/** A Worker-safe project id: ASCII letters, digits, dot, dash, underscore. */
export function cloudSlug(name: string): string {
    return (name || 'project').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'project';
}

export class CloudError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.status = status; }
}

export class CloudSyncClient {
    private token = '';
    private tokenExp = 0;
    private base: string;
    private devKey: string;
    private doFetch: typeof fetch;
    constructor(base: string, devKey: string, doFetch: typeof fetch = (input, init) => fetch(input, init)) {
        // (no parameter properties: the headless CLI loads this file with Node's type stripping)
        this.base = base.replace(/\/$/, ''); this.devKey = devKey; this.doFetch = doFetch;
    }

    private async call(method: string, path: string, init: { body?: BodyInit | null; headers?: Record<string, string> } = {}, retried = false): Promise<Response> {
        if (path !== '/auth') await this.ensureToken();
        const headers: Record<string, string> = { ...(init.headers || {}) };
        if (path === '/auth') headers['X-FG-Dev-Key'] = this.devKey; else headers['X-FG-Sync-Token'] = this.token;
        const r = await this.doFetch(`${this.base}/sync${path}`, { method, headers, body: init.body });
        if (r.status === 401 && path !== '/auth' && !retried) { this.tokenExp = 0; return this.call(method, path, init, true); }
        if (!r.ok) {
            let msg = `${r.status}`;
            try { msg = (await r.json()).error || msg; } catch {}
            throw new CloudError(r.status, msg);
        }
        return r;
    }

    private async ensureToken(): Promise<void> {
        if (this.token && this.tokenExp - Date.now() > 60_000) return;
        const j = await (await this.call('POST', '/auth')).json();
        this.token = j.token; this.tokenExp = j.expires;
    }

    async projects(): Promise<string[]> { return (await (await this.call('GET', '/projects')).json()).projects; }
    async getManifest(project: string): Promise<{ etag: string | null; manifest: CloudManifest }> {
        return (await this.call('GET', `/${project}/manifest`)).json();
    }
    /** Replace the manifest if the server still has `baseEtag` (null = none yet); a CloudError with status 412 means somebody pushed first. */
    async putManifest(project: string, manifest: CloudManifest, baseEtag: string | null): Promise<string> {
        const r = await this.call('PUT', `/${project}/manifest`, { body: JSON.stringify(manifest), headers: { 'Content-Type': 'application/json', 'X-FG-Sync-Base': baseEtag || 'none' } });
        return (await r.json()).etag;
    }
    async putBlob(project: string, hash: string, bytes: Uint8Array): Promise<void> {
        await this.call('PUT', `/${project}/b/${hash}`, { body: bytes as BodyInit, headers: { 'Content-Type': 'application/octet-stream' } });
    }
    async getBlob(project: string, hash: string): Promise<Uint8Array> {
        return new Uint8Array(await (await this.call('GET', `/${project}/b/${hash}`)).arrayBuffer());
    }
    async gc(project: string): Promise<number> { return (await (await this.call('POST', `/${project}/gc`)).json()).deleted; }
    async remove(project: string): Promise<number> { return (await (await this.call('DELETE', `/${project}`)).json()).deleted; }
}

/** Run `fn` over `items` with at most `limit` in flight; stops at the first failure. */
export async function pool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
    let next = 0, failed: unknown = null;
    const worker = async () => {
        while (!failed && next < items.length) {
            const i = next++;
            try { await fn(items[i], i); } catch (e) { failed = e; }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    if (failed) throw failed;
}
