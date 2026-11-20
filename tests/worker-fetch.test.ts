// The worker's fetch fallback relays a refused GET or HEAD to the page: the method goes with it, and a HEAD answer has no body (explorations N011, as in the frame).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { installWorkerFetch, handleNetReply } from '../exec-sandbox/worker-fetch.ts';

const g: any = globalThis;
const saved = { fetch: g.fetch, postMessage: g.postMessage };
afterEach(() => { g.fetch = saved.fetch; g.postMessage = saved.postMessage; });

describe('installWorkerFetch', () => {
    it('relays the method, and a HEAD reply has an empty body while a GET reply keeps its body', async () => {
        g.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
        const sent: any[] = [];
        g.postMessage = (m: any) => { sent.push(m); queueMicrotask(() => handleNetReply({ type: 'net-reply', id: m.id, value: { status: 200, contentType: 'text/plain', body: new TextEncoder().encode('payload').buffer } })); };
        installWorkerFetch();
        const head = await g.fetch('https://example.test/x', { method: 'HEAD' });
        expect(await head.text()).toBe('');
        const get = await g.fetch('https://example.test/x');
        expect(await get.text()).toBe('payload');
        expect(sent.map(m => m.method)).toEqual(['HEAD', 'GET']);
    });
});
