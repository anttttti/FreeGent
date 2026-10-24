import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256Js, sha256Hex, cloudSlug, CloudSyncClient, CloudError, pool, isSafeSyncPath } from '../cloud-sync';
import worker from '../cf-worker/worker.js';

class FakeR2 {
    objs = new Map<string, { data: Uint8Array; etag: string }>(); n = 0;
    async get(k: string) { const o = this.objs.get(k); return o ? { etag: o.etag, size: o.data.length, body: new Response(o.data as BodyInit).body, text: async () => new TextDecoder().decode(o.data) } : null; }
    async head(k: string) { return this.objs.get(k) ? { key: k } : null; }
    async put(k: string, v: any, opt: any = {}) {
        const cur = this.objs.get(k);
        if (opt.onlyIf?.etagDoesNotMatch === '*' && cur) return null;
        if (opt.onlyIf?.etagMatches && (!cur || cur.etag !== opt.onlyIf.etagMatches)) return null;
        const data = typeof v === 'string' ? new TextEncoder().encode(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(await new Response(v).arrayBuffer());
        if (opt.sha256 && createHash('sha256').update(data).digest('hex') !== opt.sha256) throw new Error('digest mismatch');
        const etag = 'e' + (++this.n); this.objs.set(k, { data, etag }); return { etag };
    }
    async list({ prefix = '', delimiter, limit = 1000 }: any = {}) {
        const keys = [...this.objs.keys()].filter(x => x.startsWith(prefix));
        if (delimiter) return { objects: [], delimitedPrefixes: [...new Set(keys.map(x => prefix + x.slice(prefix.length).split(delimiter)[0] + delimiter))], truncated: false };
        return { objects: keys.slice(0, limit).map(key => ({ key })), truncated: false };
    }
    async delete(ks: string | string[]) { for (const k of [].concat(ks as any)) this.objs.delete(k); }
}

function setup(devKey = 'pw') {
    const env = { FG_DEV_KEY: 'pw', FG_SYNC: new FakeR2() };
    // A browser adds Content-Length to a fetch with a byte body, but a Request object cannot carry that forbidden header: present it through a proxy.
    const f = (async (url: any, init: any = {}) => {
        const req = new Request(String(url), { ...init, headers: { 'CF-Connecting-IP': '1.2.3.4', ...(init.headers || {}) } });
        const len = ArrayBuffer.isView(init.body) ? String(init.body.byteLength) : null;
        const seen = len === null ? req : new Proxy(req, { get(t: any, p) {
            if (p === 'headers') return { get: (n: string) => n.toLowerCase() === 'content-length' ? len : t.headers.get(n) };
            const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
        } });
        return worker.fetch(seen as Request, env);
    }) as typeof fetch;
    return { env, client: new CloudSyncClient('https://w.test', devKey, f) };
}
const bytes = (s: string) => new TextEncoder().encode(s);

describe('sha256', () => {
    it('the plain-JS fallback matches crypto for empty, short, block-edge and long input', async () => {
        for (const n of [0, 1, 55, 56, 63, 64, 65, 1000]) {
            const d = new Uint8Array(n).map((_, i) => (i * 7 + 3) & 255);
            expect(sha256Js(d)).toBe(createHash('sha256').update(d).digest('hex'));
        }
        expect(await sha256Hex(bytes('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });
    it('cloudSlug is ASCII and never empty', () => {
        expect(cloudSlug('Älä Päätä! 2')).toBe('ala-paata-2');
        expect(cloudSlug('日本語')).toBe('project');
    });
});

describe('/sync on the Worker', () => {
    it('answers 503 when no bucket is bound, and 401 for a wrong key', async () => {
        const f = (async (url: any, init: any) => worker.fetch(new Request(String(url), init), { FG_DEV_KEY: 'pw' })) as typeof fetch;
        await expect(new CloudSyncClient('https://w.test', 'pw', f).projects()).rejects.toMatchObject({ status: 503 });
        await expect(setup().client.projects()).resolves.toEqual([]);
        await expect(setup().env && new CloudSyncClient('https://w.test', 'wrong', (async (u: any, i: any) => worker.fetch(new Request(String(u), i), { FG_DEV_KEY: 'pw', FG_SYNC: new FakeR2() })) as typeof fetch).projects()).rejects.toMatchObject({ status: 401 });
    });
    it('stores blobs by hash, refuses a wrong hash, and swaps the manifest with a compare-and-swap', async () => {
        const { client } = setup();
        const data = bytes('hello'), h = await sha256Hex(data);
        await client.putBlob('proj', h, data);
        expect(new TextDecoder().decode(await client.getBlob('proj', h))).toBe('hello');
        await expect(client.putBlob('proj', 'a'.repeat(64), data)).rejects.toMatchObject({ status: 400 });
        const empty = await client.getManifest('proj');
        expect(empty).toEqual({ etag: null, manifest: { files: {} } });
        const e1 = await client.putManifest('proj', { files: { 'a.txt': { h, s: 5 } } }, null);
        await expect(client.putManifest('proj', { files: {} }, null)).rejects.toMatchObject({ status: 412 });   // someone pushed first
        const e2 = await client.putManifest('proj', { files: { 'a.txt': { h, s: 5 }, 'b.txt': { h, s: 5 } } }, e1);
        expect(e2).not.toBe(e1);
        await expect(client.putManifest('proj', { files: {} }, e1)).rejects.toMatchObject({ status: 412 });     // stale base
        expect(Object.keys((await client.getManifest('proj')).manifest.files)).toEqual(['a.txt', 'b.txt']);
        expect(await client.projects()).toEqual(['proj']);
    });
    it('rejects bad project names and manifests without hashes; gc drops unused blobs; remove clears the project', async () => {
        const { client } = setup();
        await expect(client.getManifest('..')).rejects.toBeInstanceOf(CloudError);
        await expect(client.putManifest('p', { files: { 'a': { h: 'zz', s: 1 } } }, null)).rejects.toMatchObject({ status: 400 });
        const keep = bytes('keep'), drop = bytes('drop');
        const hk = await sha256Hex(keep), hd = await sha256Hex(drop);
        await client.putBlob('p', hk, keep); await client.putBlob('p', hd, drop);
        await client.putManifest('p', { files: { k: { h: hk, s: 4 } } }, null);
        expect(await client.gc('p')).toBe(1);
        await expect(client.getBlob('p', hd)).rejects.toMatchObject({ status: 404 });
        expect((await client.getBlob('p', hk)).length).toBe(4);
        expect(await client.remove('p')).toBeGreaterThan(0);
        expect(await client.projects()).toEqual([]);
    });
});

describe('manifest paths', () => {
    const H = 'a'.repeat(64);
    it('isSafeSyncPath accepts project paths and refuses anything that climbs, roots or hides a control character', () => {
        for (const ok of ['a.txt', 'src/app.js', 'local/src/a b.js', 'dir/.hidden', 'ünï/ç.md']) expect(isSafeSyncPath(ok), ok).toBe(true);
        for (const bad of ['', '..', '../x', 'a/../../x', 'local/../../etc/passwd', './a', 'a/./b', 'a//b', '/abs', 'C:/x', 'C:\\x', 'a\\b', 'a/\u0000b', 'a/', 'x'.repeat(1025), 5, null]) expect(isSafeSyncPath(bad as any), String(bad)).toBe(false);
    });
    it('the Worker refuses a manifest with such a key, and the client refuses to pull one', async () => {
        const { client, env } = setup();
        await expect(client.putManifest('p', { files: { 'local/../../x': { h: H, s: 1 } } }, null)).rejects.toMatchObject({ status: 400 });
        await expect(client.putManifest('p', { files: { '/etc/passwd': { h: H, s: 1 } } }, null)).rejects.toMatchObject({ status: 400 });
        await client.putManifest('p', { files: { 'ok/a.txt': { h: H, s: 1 } } }, null);
        expect((await client.getManifest('p')).manifest.files['ok/a.txt'].h).toBe(H);
        // a manifest that got into the bucket some other way (an older Worker, a direct write)
        const key = [...(env.FG_SYNC as any).objs.keys()].find((k: string) => k.endsWith('manifest.json'))!;
        await (env.FG_SYNC as any).put(key, JSON.stringify({ files: { 'local/../../x': { h: H, s: 1 } } }));
        await expect(client.getManifest('p')).rejects.toMatchObject({ status: 422 });
    });
});

describe('pool', () => {
    it('limits concurrency and stops at the first failure', async () => {
        let live = 0, max = 0;
        await pool([1, 2, 3, 4, 5, 6], 2, async () => { live++; max = Math.max(max, live); await new Promise(r => setTimeout(r, 5)); live--; });
        expect(max).toBe(2);
        await expect(pool([1, 2, 3], 1, async (x) => { if (x === 2) throw new Error('boom'); })).rejects.toThrow('boom');
    });
});
