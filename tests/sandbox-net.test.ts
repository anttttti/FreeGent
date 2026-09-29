// Network access for code in the exec sandbox:
//   - exec-sandbox/net.ts sandboxFetch: direct first; a plain GET the browser refuses is retried
//     through the page, anything else fails as before
//   - shiro curl / wget on top of it
// The page side (exec-sandbox-host.ts _answerNet) is tested in exec-sandbox.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// net.ts captures fetch when it loads, so the stub must exist before the import.
const { directFetch, pageFetch } = vi.hoisted(() => {
    const directFetch = vi.fn();
    (globalThis as any).fetch = directFetch;
    return { directFetch, pageFetch: vi.fn() };
});
vi.mock('../exec-sandbox/channel', () => ({ pageFetch }));

import { sandboxFetch, VIA_PROXY_HEADER } from '../exec-sandbox/net';
import { curlCmd, wgetCmd } from '../shiro/commands/curl';

const bytes = (s: string) => new TextEncoder().encode(s).buffer;
const corsRefusal = () => { throw new TypeError('Failed to fetch'); };

function ctx(args: string[]) {
    const written: Record<string, Uint8Array> = {};
    return {
        args, cwd: '/workspace', env: {}, stdin: '', stdout: '', stderr: '', shell: {} as any, written,
        fs: {
            resolvePath: (p: string, cwd: string) => p.startsWith('/') ? p : `${cwd}/${p}`,
            readFile: vi.fn(async () => ''),
            writeFile: vi.fn(async (p: string, d: Uint8Array) => { written[p] = d; }),
        } as any,
    };
}

beforeEach(() => { directFetch.mockReset(); pageFetch.mockReset(); });

describe('sandboxFetch', () => {
    it('returns direct responses without asking the page', async () => {
        directFetch.mockResolvedValue(new Response('direct'));
        expect(await (await sandboxFetch('https://registry.npmjs.org/x')).text()).toBe('direct');
        expect(pageFetch).not.toHaveBeenCalled();
    });

    it('retries a refused plain GET through the page', async () => {
        directFetch.mockImplementation(corsRefusal);
        pageFetch.mockResolvedValue({ status: 200, contentType: 'text/html', body: bytes('<p>hi</p>') });
        const r = await sandboxFetch('https://example.com/');
        expect(pageFetch).toHaveBeenCalledWith('https://example.com/');
        expect(await r.text()).toBe('<p>hi</p>');
        expect(r.headers.get('Content-Type')).toBe('text/html');
        expect(r.headers.get(VIA_PROXY_HEADER)).toBe('1');
    });

    it('keeps HTTP errors from the proxied fetch', async () => {
        directFetch.mockImplementation(corsRefusal);
        pageFetch.mockResolvedValue({ status: 404, contentType: '', body: bytes('nope') });
        expect((await sandboxFetch('https://example.com/missing')).status).toBe(404);
    });

    it('does not proxy requests with a body or another method, or aborts', async () => {
        directFetch.mockImplementation(corsRefusal);
        await expect(sandboxFetch('https://api.example.com/', { method: 'POST', body: '{}' })).rejects.toThrow(TypeError);
        await expect(sandboxFetch('https://api.example.com/', { method: 'DELETE' })).rejects.toThrow(TypeError);
        directFetch.mockImplementation(() => { throw new DOMException('aborted', 'AbortError'); });
        await expect(sandboxFetch('https://example.com/')).rejects.toThrow('aborted');
        expect(pageFetch).not.toHaveBeenCalled();
    });
});

describe('curl', () => {
    it('prints the body', async () => {
        directFetch.mockResolvedValue(new Response('{"ok":true}'));
        const c = ctx(['-sSL', 'https://api.example.com/v1']);
        expect(await curlCmd.exec(c)).toBe(0);
        expect(c.stdout).toBe('{"ok":true}');
    });

    it('writes binary bodies to a file with -o and -O', async () => {
        const data = new Uint8Array([0, 255, 1, 2]);
        directFetch.mockImplementation(async () => new Response(data));
        const c = ctx(['-o', 'out.bin', 'https://example.com/a.bin']);
        expect(await curlCmd.exec(c)).toBe(0);
        expect([...c.written['/workspace/out.bin']]).toEqual([0, 255, 1, 2]);
        const d = ctx(['-O', 'https://example.com/dir/pkg.tar.gz']);
        expect(await curlCmd.exec(d)).toBe(0);
        expect(d.written['/workspace/pkg.tar.gz']).toBeDefined();
    });

    it('sends method, headers and data', async () => {
        directFetch.mockResolvedValue(new Response('created', { status: 201 }));
        const c = ctx(['-X', 'PUT', '-H', 'Authorization: Bearer t', '-d', 'a=1', 'https://api.example.com/x']);
        expect(await curlCmd.exec(c)).toBe(0);
        expect(directFetch).toHaveBeenCalledWith('https://api.example.com/x',
            { method: 'PUT', headers: { Authorization: 'Bearer t' }, body: 'a=1' });
    });

    it('-f fails on HTTP errors, -w prints the status', async () => {
        directFetch.mockResolvedValue(new Response('gone', { status: 404 }));
        const c = ctx(['-sf', 'https://example.com/x']);
        expect(await curlCmd.exec(c)).toBe(22);
        directFetch.mockResolvedValue(new Response(null, { status: 204 }));
        const d = ctx(['-s', '-o', '/dev/null', '-w', '%{http_code}', 'https://example.com/y']);
        expect(await curlCmd.exec(d)).toBe(0);
        expect(d.stdout).toBe('204');
    });

    it('explains a refused POST instead of a bare network error', async () => {
        directFetch.mockImplementation(corsRefusal);
        const c = ctx(['-d', 'x', 'https://api.example.com/']);
        expect(await curlCmd.exec(c)).toBe(7);
        expect(c.stderr).toMatch(/only plain GET requests can go through FreeGent's proxy/);
    });

    it('-v says when a request went through the proxy', async () => {
        directFetch.mockImplementation(corsRefusal);
        pageFetch.mockResolvedValue({ status: 200, contentType: 'text/plain', body: bytes('x') });
        const c = ctx(['-v', 'https://example.com/']);
        expect(await curlCmd.exec(c)).toBe(0);
        expect(c.stderr).toMatch(/through FreeGent's proxy/);
    });

    it('rejects unsupported options clearly', async () => {
        const c = ctx(['--proxy', 'http://p', 'https://example.com/']);
        expect(await curlCmd.exec(c)).toBe(2);
        expect(c.stderr).toMatch(/not supported in the browser shell/);
    });
});

describe('wget', () => {
    it('-qO- prints the body; the default saves under the URL name', async () => {
        directFetch.mockImplementation(async () => new Response('body'));
        const c = ctx(['-qO-', 'https://example.com/file.txt']);
        expect(await wgetCmd.exec(c)).toBe(0);
        expect(c.stdout).toBe('body');
        const d = ctx(['https://example.com/file.txt']);
        expect(await wgetCmd.exec(d)).toBe(0);
        expect(new TextDecoder().decode(d.written['/workspace/file.txt'])).toBe('body');
    });

    it('exits 8 on server errors', async () => {
        directFetch.mockResolvedValue(new Response('', { status: 500 }));
        expect(await wgetCmd.exec(ctx(['-q', 'https://example.com/x']))).toBe(8);
    });
});
