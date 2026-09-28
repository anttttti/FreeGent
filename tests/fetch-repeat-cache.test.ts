// fetch-repeat-cache.test.ts — the per-turn repeat cache must not answer a read with its
// pre-write result. A non-GET fetch_url clears the other cached entries (v0.56 AutomationBench:
// 5 reads after a write came from the cache; v0.55: 10), but is still cached itself so an
// identical repeat — a duplicate send — is not executed twice.
import { describe, it, expect, beforeAll, vi } from 'vitest';

const W = window as any;
beforeAll(async () => { await import('../llm-loops.ts'); await import('../tools.ts'); });

describe('repeat cache and fetch_url methods', () => {
    it('re-runs a cached read after a POST, and dedups an identical POST', async () => {
        let rows = 1;
        const origFetch = W.fetch;
        const calls: string[] = [];
        W.fetch = vi.fn(async (url: any, init?: any) => {
            const body = String(init?.body ?? '');
            calls.push(body.includes('update_row') ? 'write' : 'read');
            if (body.includes('update_row')) rows++;
            const text = JSON.stringify({ rows });
            return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
        });
        try {
            const cache = new Map();
            const run = (args: any) => W._runToolCalls([{ name: 'fetch_url', args }], null, { forWorker: false, repeatCache: cache });
            const read  = { url: 'https://api.example.com/execute', method: 'POST', body: '{"tool":"get_rows"}' };
            const write = { url: 'https://api.example.com/execute', method: 'POST', body: '{"tool":"update_row"}' };
            const search = { url: 'https://api.example.com/search?q=rows' };
            await run(search);
            await run(read);
            await run(write);
            await run(write);                                                // back-to-back duplicate: cached
            expect(calls.filter(c => c === 'write').length).toBe(1);
            const after = await run(read);
            expect(JSON.stringify(after[0].result)).toContain('"rows":2');   // fresh, not the pre-write 1
            await run(search);                                               // cleared by the POSTs: runs again
            expect(W.fetch.mock.calls.length).toBe(5);
        } finally { W.fetch = origFetch; }
    });
});
