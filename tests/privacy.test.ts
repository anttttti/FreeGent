import { describe, it, expect, afterEach, vi } from 'vitest';
import { isLocalAddress, privacyBlockReason, proxiedTarget, providerBlockedByPrivacy, sandboxCspMeta, parsePrivacyLevel, type PrivacyContext } from '../privacy.js';
import { resolveProxy, DEFAULT_CF_WORKER, installPrivacyGuard } from '../proxy.js';

const hosted: PrivacyContext = { pageOrigin: 'https://freegent.ai', workerOrigins: [DEFAULT_CF_WORKER, 'https://mine.workers.dev'] };
const lan: PrivacyContext = { pageOrigin: 'http://192.168.1.28:5000', workerOrigins: [DEFAULT_CF_WORKER] };

describe('isLocalAddress', () => {
    it('accepts loopback, private ranges, link-local, .local and LAN names', () => {
        for (const h of ['localhost', 'app.localhost', '127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.0.1', '172.31.255.1', '169.254.1.1', '[::1]', 'fd12::1', 'fe80::1', 'nas.local', 'mybox', '::ffff:10.0.0.1'])
            expect(isLocalAddress(h), h).toBe(true);
    });
    it('rejects public hosts and look-alikes', () => {
        for (const h of ['api.groq.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '11.0.0.1', 'localhost.evil.com', '2606:4700::1', ''])
            expect(isLocalAddress(h), h).toBe(false);
    });
});

describe('privacyBlockReason', () => {
    it('default blocks nothing', () => {
        expect(privacyBlockReason('https://proxy.freegent.ai/', 'default', hosted)).toBeNull();
        expect(privacyBlockReason('https://api.groq.com/x', 'default', hosted)).toBeNull();
    });
    it('provider blocks the hosted and a custom Worker, not providers or the web', () => {
        expect(privacyBlockReason(`${DEFAULT_CF_WORKER}/keys`, 'provider', hosted)).toMatch(/Provider-only.*Cloudflare Worker/);
        expect(privacyBlockReason('https://mine.workers.dev/?url=x', 'provider', hosted)).toMatch(/Cloudflare Worker/);
        expect(privacyBlockReason('https://api.groq.com/openai/v1/chat/completions', 'provider', hosted)).toBeNull();
        expect(privacyBlockReason('https://example.com/page', 'provider', hosted)).toBeNull();
    });
    it('provider does not mistake a look-alike host for the Worker', () => {
        expect(privacyBlockReason('https://proxy.freegent.ai.example.com/', 'provider', hosted)).toBeNull();
    });
    it('local allows this machine, the LAN and the page origin only', () => {
        expect(privacyBlockReason('http://localhost:11434/v1/chat/completions', 'local', hosted)).toBeNull();
        expect(privacyBlockReason('http://192.168.1.50:8000/v1', 'local', hosted)).toBeNull();
        expect(privacyBlockReason('/assets/x.wasm', 'local', hosted)).toBeNull();
        expect(privacyBlockReason('data:text/plain,hi', 'local', hosted)).toBeNull();
        expect(privacyBlockReason('blob:https://freegent.ai/abc', 'local', hosted)).toBeNull();
        expect(privacyBlockReason('https://api.groq.com/openai/v1/chat/completions', 'local', hosted)).toMatch(/Local.*not on this machine/);
        expect(privacyBlockReason(`${DEFAULT_CF_WORKER}/`, 'local', hosted)).toMatch(/Local/);
        expect(privacyBlockReason('https://api.groq.com/x', 'local', lan)).not.toBeNull();
    });
});

describe('proxiedTarget', () => {
    it('reads the destination of a local-server proxy call from the query or the POST body', () => {
        const o = 'http://192.168.1.28:5000';
        expect(proxiedTarget(`${o}/api/proxy?url=${encodeURIComponent('https://example.com/a')}`, undefined, o)).toBe('https://example.com/a');
        expect(proxiedTarget(`${o}/api/proxy`, JSON.stringify({ url: 'https://api.groq.com/x', method: 'POST' }), o)).toBe('https://api.groq.com/x');
        expect(proxiedTarget(`${o}/api/execute`, '{"url":"https://x"}', o)).toBeNull();
        expect(proxiedTarget('https://other.example/api/proxy?url=https://x', undefined, o)).toBeNull();
        expect(proxiedTarget(`${o}/api/proxy`, 'not json', o)).toBeNull();
    });
});

describe('providerBlockedByPrivacy', () => {
    it('default blocks nothing', () => expect(providerBlockedByPrivacy('nvidia', 'default', { staticHost: true })).toBe(false));
    it('provider drops NVIDIA and Kilo on a static host only', () => {
        expect(providerBlockedByPrivacy('nvidia', 'provider', { staticHost: true })).toBe(true);
        expect(providerBlockedByPrivacy('kilo', 'provider', { staticHost: true })).toBe(true);
        expect(providerBlockedByPrivacy('nvidia', 'provider', { staticHost: false })).toBe(false);
        expect(providerBlockedByPrivacy('groq', 'provider', { staticHost: true })).toBe(false);
    });
    it('local keeps only custom and vllm models at local addresses', () => {
        expect(providerBlockedByPrivacy('groq', 'local', { staticHost: false })).toBe(true);
        expect(providerBlockedByPrivacy('custom', 'local', { staticHost: true, url: 'http://localhost:11434/v1' })).toBe(false);
        expect(providerBlockedByPrivacy('vllm', 'local', { staticHost: true })).toBe(false);
        expect(providerBlockedByPrivacy('custom', 'local', { staticHost: true, url: 'https://api.openai.com/v1' })).toBe(true);
    });
});

describe('sandboxCspMeta / parsePrivacyLevel', () => {
    it('only the local level adds a CSP', () => {
        expect(sandboxCspMeta('default')).toBe('');
        expect(sandboxCspMeta('provider')).toBe('');
        expect(sandboxCspMeta('local')).toMatch(/Content-Security-Policy.*connect-src/);
    });
    it('unknown values mean default', () => {
        expect(parsePrivacyLevel('provider')).toBe('provider');
        expect(parsePrivacyLevel('local')).toBe('local');
        expect(parsePrivacyLevel('strict')).toBe('default');
        expect(parsePrivacyLevel(null)).toBe('default');
    });
});

function stubPage(hostname: string, level: string | null, manual = '') {
    const store: Record<string, string> = {};
    if (level) store.fg_privacy_level = level;
    if (manual) store.fg_search_proxy = manual;
    const fetchSpy = vi.fn(async () => new Response('ok'));
    const win: any = { _fgHeadless: false, location: { hostname, origin: `https://${hostname}` }, fetch: fetchSpy };
    vi.stubGlobal('window', win);
    vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } });
    return { win, fetchSpy };
}
afterEach(() => vi.unstubAllGlobals());

describe('resolveProxy at each privacy level', () => {
    it('default is unchanged', () => {
        stubPage('freegent.ai', null);
        expect(resolveProxy('post')).toBe(DEFAULT_CF_WORKER);
    });
    it('provider and local use no Worker on a static host, and ignore a custom Worker URL', () => {
        for (const level of ['provider', 'local']) {
            stubPage('freegent.ai', level, 'https://mine.workers.dev');
            for (const k of ['get', 'post', 'local'] as const) expect(resolveProxy(k, 'https://mine.workers.dev'), `${level}/${k}`).toBe('');
        }
    });
    it('provider and local keep the local server proxy', () => {
        stubPage('192.168.1.28', 'provider');
        expect(resolveProxy('post')).toBe('https://192.168.1.28/api/proxy');
    });
});

describe('installPrivacyGuard', () => {
    it('lets everything through at default', async () => {
        const { win, fetchSpy } = stubPage('freegent.ai', null);
        installPrivacyGuard();
        await win.fetch('https://proxy.freegent.ai/keys');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    it('provider refuses the Worker (hosted and custom) but not a provider', async () => {
        const { win, fetchSpy } = stubPage('freegent.ai', 'provider', 'https://mine.workers.dev');
        installPrivacyGuard();
        await expect(win.fetch(`${DEFAULT_CF_WORKER}/keys`)).rejects.toMatchObject({ name: 'PrivacyBlockedError' });
        await expect(win.fetch('https://mine.workers.dev/?url=x')).rejects.toMatchObject({ name: 'PrivacyBlockedError' });
        await win.fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', body: '{}' });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    it('local refuses public hosts, including ones behind the local server proxy', async () => {
        const { win, fetchSpy } = stubPage('localhost', 'local');
        installPrivacyGuard();
        await expect(win.fetch('https://api.groq.com/x')).rejects.toMatchObject({ name: 'PrivacyBlockedError' });
        await expect(win.fetch('https://localhost/api/proxy?url=' + encodeURIComponent('https://example.com'))).rejects.toMatchObject({ name: 'PrivacyBlockedError' });
        await expect(win.fetch('https://localhost/api/proxy', { method: 'POST', body: JSON.stringify({ url: 'https://api.groq.com/x' }) })).rejects.toMatchObject({ name: 'PrivacyBlockedError' });
        await win.fetch('https://localhost/api/proxy', { method: 'POST', body: JSON.stringify({ url: 'http://192.168.1.50:8000/v1/chat/completions' }) });
        await win.fetch('http://localhost:11434/v1/chat/completions');
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
});
