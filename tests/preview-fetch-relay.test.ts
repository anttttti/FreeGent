// preview-fetch-relay.test.ts — HTML preview iframes are sandboxed (Origin "null"), which the CF
// proxy rejects. Their fetch shim relays cross-origin GETs to the parent page, which fetches them
// through the proxy with its own origin; the proxy's own errors reach the app as fetch failures,
// not as a JSON body the app would parse as data.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const W = window as any;

beforeAll(async () => {
    await import('../tabs.ts');
});

const tick = () => new Promise(r => setTimeout(r, 0));

describe('parent-side relay', () => {
    let iframe: HTMLIFrameElement;
    let replies: any[];
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        iframe = document.createElement('iframe');
        iframe.className = 'artifact-iframe';
        document.body.appendChild(iframe);
        replies = [];
        (iframe.contentWindow as any).postMessage = (msg: any) => replies.push(msg);
        W.getEffectiveProxy = () => 'https://px.test';
        fetchSpy = vi.fn(async () => new Response('{"chart":{"result":[1]}}', { status: 200, headers: { 'content-type': 'application/json' } }));
        vi.stubGlobal('fetch', fetchSpy);
    });
    afterEach(() => { iframe.remove(); vi.unstubAllGlobals(); });

    const send = async (data: any, source: any = iframe.contentWindow) => {
        window.dispatchEvent(new MessageEvent('message', { data, source }));
        await tick(); await tick();
    };

    it('fetches through the proxy and posts the response back', async () => {
        await send({ type: 'fg-fetch', id: 1, url: 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=5y',
            headers: { Accept: 'application/json', Authorization: 'Bearer x' } });
        const url = new URL(fetchSpy.mock.calls[0][0]);
        expect(url.origin).toBe('https://px.test');
        expect(url.searchParams.get('url')).toBe('https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=5y');
        expect(JSON.parse(atob(url.searchParams.get('h')!))).toEqual({ Accept: 'application/json' });
        expect(replies).toHaveLength(1);
        expect(replies[0]).toMatchObject({ type: 'fg-fetch-result', id: 1, status: 200 });
        expect(new TextDecoder().decode(replies[0].body)).toBe('{"chart":{"result":[1]}}');
    });

    it('turns a proxy-generated error into an error reply, not a response', async () => {
        fetchSpy.mockResolvedValueOnce(new Response('{"error":"Origin not allowed"}',
            { status: 403, headers: { 'X-FG-Proxy-Error': '1' } }));
        await send({ type: 'fg-fetch', id: 2, url: 'https://cdn.test/pyodide-lock.json' });
        expect(replies[0]).toEqual({ type: 'fg-fetch-result', id: 2, error: 'proxy: Origin not allowed' });
    });

    it('passes upstream error statuses through as responses', async () => {
        fetchSpy.mockResolvedValueOnce(new Response('not found', { status: 404 }));
        await send({ type: 'fg-fetch', id: 3, url: 'https://api.test/x' });
        expect(replies[0]).toMatchObject({ id: 3, status: 404 });
        expect(replies[0].error).toBeUndefined();
    });

    it('ignores messages from windows that are not preview iframes', async () => {
        await send({ type: 'fg-fetch', id: 4, url: 'https://api.test/x' }, window);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('refuses non-http URLs', async () => {
        await send({ type: 'fg-fetch', id: 5, url: 'file:///etc/passwd' });
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(replies[0].error).toMatch(/only http/);
    });
});

describe('iframe fetch shim', () => {
    let shim: string;

    beforeAll(async () => {
        W.getEffectiveProxy = () => 'https://px.test';
        document.body.innerHTML = '<div id="tab-bar"></div><div id="tab-content"></div>';
        await W.openArtifactTab('app.html', '<html><head></head><body></body></html>');
        const srcdoc = (document.querySelector('iframe.artifact-iframe') as HTMLIFrameElement).srcdoc;
        shim = srcdoc.match(/<script>(?:(?!<\/script>)[\s\S])*fg-fetch[\s\S]*?<\/script>/)![0];
    });

    // Runs the shim in its own window whose parent answers relay requests with `answer`.
    function frame(answer: (msg: any) => any) {
        const posted: any[] = [];
        const parent = {
            postMessage(msg: any) {
                posted.push(msg);
                const reply = answer(msg);
                if (reply) setTimeout(() => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: reply, source: parent as any })));
            },
        };
        const directFetch = vi.fn(async () => new Response('direct'));
        const dom: JSDOM = new JSDOM(`<html><head>${shim}</head><body></body></html>`, {
            runScripts: 'dangerously',
            beforeParse(win: any) {
                Object.defineProperty(win, 'parent', { value: parent });
                win.Response = Response; win.Headers = Headers; win.fetch = directFetch;
            },
        });
        return { win: dom.window as any, posted, directFetch };
    }

    it('relays a cross-origin GET to the parent and resolves with its response', async () => {
        const { win, posted, directFetch } = frame(m => ({ type: 'fg-fetch-result', id: m.id, status: 200, statusText: 'OK',
            headers: [['content-type', 'application/json']], body: new TextEncoder().encode('{"ok":1}').buffer }));
        const resp = await win.fetch('https://api.test/x', { headers: { Accept: 'application/json', Cookie: 'c' } });
        expect(posted[0]).toMatchObject({ type: 'fg-fetch', url: 'https://api.test/x', headers: { Accept: 'application/json' } });
        expect(await resp.json()).toEqual({ ok: 1 });
        expect(resp.headers.get('content-type')).toBe('application/json');
        expect(directFetch).not.toHaveBeenCalled();
    });

    it('rejects when the parent reports a proxy error', async () => {
        const { win } = frame(m => ({ type: 'fg-fetch-result', id: m.id, error: 'proxy: Origin not allowed' }));
        await expect(win.fetch('https://cdn.test/pyodide-lock.json')).rejects.toThrow(/Origin not allowed/);
    });

    it('rejects with AbortError when aborted before the reply', async () => {
        const { win } = frame(() => null);
        const ctl = new win.AbortController();
        const p = win.fetch('https://api.test/slow', { signal: ctl.signal });
        ctl.abort();
        await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('sends non-GET requests directly', async () => {
        const { win, posted, directFetch } = frame(() => null);
        await win.fetch('https://api.test/x', { method: 'POST', body: '{}' });
        expect(posted).toHaveLength(0);
        expect(directFetch).toHaveBeenCalledTimes(1);
    });
});
