// A relayed body that fails after the response arrived (the Worker's 48 MB cap, a dropped stream) is not a sign that the site blocks us:
// it must not put the whole hostname on the 7-day blacklist (Sol 6.2 review of dcf9d6c).
import { describe, it, expect, beforeAll, vi } from 'vitest';
const W = window as any;
beforeAll(async () => { await import('../llm-loops.ts'); await import('../tools.ts'); });

describe('fetch_url and a body that fails mid-stream', () => {
    it('leaves the host off the blacklist', async () => {
        const { blacklistHas } = await import('../fetch-blacklist.ts') as any;
        const origFetch = W.fetch;
        W.fetch = vi.fn(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([65])); c.error(new TypeError('network error')); } }), { status: 200, headers: { 'content-type': 'text/plain' } }));
        try {
            const r = await W._runToolCalls([{ name: 'fetch_url', args: { url: 'https://bigfile.example.org/a.txt' } }], null, { forWorker: false, repeatCache: new Map() });
            expect(JSON.stringify(r[0].result)).toMatch(/error/);
            expect(blacklistHas('https://bigfile.example.org/b.txt')).toBe(false);
        } finally { W.fetch = origFetch; }
    });
});
