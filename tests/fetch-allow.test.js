// fetch-allow.test.js — --fetch-allow origin allowlist (parsing + enforcement in fetch_url via
// executeToolAsync) and --enable-tools' director ceiling. global fetch is stubbed per test.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseFetchAllow, setFetchAllow, checkFetchAllowed } from '../fetch-allow.ts';
import { setDirectorHeadlessTools } from '../workers.ts';

const W = globalThis;

describe('parseFetchAllow', () => {
    it('accepts bare origins and normalises them', () => {
        expect(parseFetchAllow('http://fg-gw:41234, http://localhost:8000/, https://api.example.com'))
            .toEqual(['http://fg-gw:41234', 'http://localhost:8000', 'https://api.example.com']);
    });

    it('rejects non-http schemes, paths, credentials and empty lists', () => {
        expect(() => parseFetchAllow('file:///etc/passwd')).toThrow(/only http/);
        expect(() => parseFetchAllow('http://localhost:41000/api')).toThrow(/bare origin/);
        expect(() => parseFetchAllow('http://u:p@localhost:41000')).toThrow(/bare origin/);
        expect(() => parseFetchAllow(' , ')).toThrow(/no origins/);
        expect(() => parseFetchAllow('not a url')).toThrow(/not a URL/);
    });

    it('fails the whole list when any entry is malformed', () => {
        expect(() => parseFetchAllow('http://fg-gw:41234,ftp://fg-gw')).toThrow();
    });
});

describe('fetch_url under --fetch-allow', () => {
    let fetchSpy;
    beforeEach(() => {
        W.mainAgentRole = null;
        fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }),
            { status: 200, headers: { 'content-type': 'application/json' } }));
        vi.stubGlobal('fetch', fetchSpy);
        setFetchAllow(parseFetchAllow('http://fg-gw:41234'));
    });
    afterEach(() => {
        setFetchAllow(null);
        vi.unstubAllGlobals();
    });

    it('reaches an allowed origin, without following redirects', async () => {
        const r = await W.executeToolAsync('fetch_url', { url: 'http://fg-gw:41234/search?q=x' });
        expect(r.status).toBe(200);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe('http://fg-gw:41234/search?q=x');
        expect(init.redirect).toBe('manual');
    });

    it.each([
        'https://example.com/',
        'http://fg-gw:41235/',          // same host, different port
        'http://localhost:41234/',      // same port, different host
        'http://fg-gw:8000/v1/models',
        'https://github.com/a/b/blob/main/x.py', // GitHub rewrite must not bypass the check
    ])('refuses %s without making a request', async (url) => {
        const r = await W.executeToolAsync('fetch_url', { url });
        expect(r.error).toMatch(/outside this sandbox/);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    // getEffectiveProxy() always yields at least the same-origin /api/proxy fallback, so a
    // plain GET would normally go through the proxy — the sandbox must fetch directly.
    it('does not route allowed plain GETs through the CORS proxy', async () => {
        await W.executeToolAsync('fetch_url', { url: 'http://fg-gw:41234/page' });
        expect(fetchSpy.mock.calls[0][0]).toBe('http://fg-gw:41234/page');
    });
});

describe('checkFetchAllowed without an allowlist', () => {
    it('allows everything (default behaviour unchanged)', () => {
        setFetchAllow(null);
        expect(checkFetchAllowed('https://example.com/')).toBeNull();
    });
});

describe('director headless ceiling (--enable-tools)', () => {
    let origExec;
    beforeEach(() => { origExec = W.nativeExec; W.nativeExec = () => {}; });   // headless branch
    afterEach(() => { W.nativeExec = origExec; setDirectorHeadlessTools([]); });

    it('excludes fetch_url by default, even with a fetch allowlist', () => {
        setFetchAllow(parseFetchAllow('http://fg-gw:41234'));
        try { expect(W.rolesRegistry.get('director').tools.has('fetch_url')).toBe(false); }
        finally { setFetchAllow(null); }
    });

    it('includes tools passed via setDirectorHeadlessTools', () => {
        setDirectorHeadlessTools(['fetch_url']);
        expect(W.rolesRegistry.get('director').tools.has('fetch_url')).toBe(true);
    });
});
