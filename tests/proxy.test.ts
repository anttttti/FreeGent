import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveProxy, DEFAULT_CF_WORKER } from '../proxy.js';

const env = (hostname: string, headless = false) =>
    vi.stubGlobal('window', { _fgHeadless: headless, location: { hostname, origin: `https://${hostname}` } });
afterEach(() => vi.unstubAllGlobals());

describe('resolveProxy', () => {
    it('headless never proxies, except via a manual proxy for get/post', () => {
        env('localhost', true);
        for (const k of ['get', 'post', 'local'] as const) expect(resolveProxy(k)).toBe('');
        expect(resolveProxy('get', 'https://p.example/')).toBe('https://p.example/');
    });
    it('static host: get/post use the CF Worker, local (MCP) goes direct', () => {
        env('freegent.ai');
        expect(resolveProxy('get')).toBe(DEFAULT_CF_WORKER);
        expect(resolveProxy('post')).toBe(DEFAULT_CF_WORKER);
        expect(resolveProxy('local')).toBe('');
    });
    it('dev server / LAN: same-origin /api/proxy for every kind', () => {
        env('192.168.1.28');
        for (const k of ['get', 'post', 'local'] as const) expect(resolveProxy(k)).toBe('https://192.168.1.28/api/proxy');
    });
    it('manual proxy wins for get/post (post strips a trailing slash) but never for local', () => {
        env('freegent.ai');
        expect(resolveProxy('get', 'https://p.example/')).toBe('https://p.example/');
        expect(resolveProxy('post', 'https://p.example/')).toBe('https://p.example');
        expect(resolveProxy('local', 'https://p.example/')).toBe('');
    });
});
