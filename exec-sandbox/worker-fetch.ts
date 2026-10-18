// exec-sandbox/worker-fetch.ts — the proxied-GET fallback for fetch inside the exec sandbox's
// Web Workers (JS runner, Pyodide). The same logic runs in the frame as net.ts's sandboxFetch,
// which reaches the page through the channel instead of through its worker's parent.
//
// installWorkerFetch() replaces self.fetch: a request the browser refuses (CORS — the worker has
// the sandbox's opaque origin) is retried as a plain GET relayed to the page ({ type: 'net' }),
// which answers with { type: 'net-reply' }; pass those to handleNetReply from onmessage.

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);
const netWaiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let netSeq = 0;

export function installWorkerFetch(): void {
    const directFetch = self.fetch.bind(self);
    self.fetch = async (input: any, init: any = {}) => {
        try {
            return await directFetch(input, init);
        } catch (err) {
            if (!(err instanceof TypeError)) throw err;
            const url    = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            const method = String(init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
            if ((method !== 'GET' && method !== 'HEAD') || init.body != null || !/^https?:\/\//i.test(url)) throw err;
            const id = ++netSeq;
            const r: any = await new Promise((resolve, reject) => {
                netWaiting.set(id, { resolve, reject });
                self.postMessage({ type: 'net', id, url });
            });
            const headers: Record<string, string> = { 'X-FG-Via-Proxy': '1' };
            if (r.contentType) headers['Content-Type'] = r.contentType;
            return new Response(NULL_BODY_STATUS.has(r.status) ? null : r.body, { status: r.status, headers });
        }
    };
}

/** Settle the pending fetch a 'net-reply' message answers. True when the message was one. */
export function handleNetReply(data: any): boolean {
    if (data?.type !== 'net-reply') return false;
    const w = netWaiting.get(data.id);
    if (!w) return true;
    netWaiting.delete(data.id);
    if (data.error !== undefined) w.reject(new TypeError(`Failed to fetch: ${data.error}`)); else w.resolve(data.value);
    return true;
}
