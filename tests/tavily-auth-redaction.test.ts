// codex R615: a Tavily 401 body that reflects the submitted key must not reach the tool result.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { tavilySearch } from '../search-providers.ts';

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

describe('tavilySearch auth failure', () => {
    it('redacts the stored key from the provider\'s error detail', async () => {
        const key = 'tvly-dev-AbCdEf0123456789XyZ';
        localStorage.setItem('fg_tavily_key', key);
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: { error: `Unauthorized: invalid key ${key}` } }), { status: 401 })));
        const r: any = await tavilySearch('anything');
        expect(r.authFailed).toBe(true);
        expect(r.error).toContain('Tavily 401');
        expect(r.error).not.toContain(key);
    });
});
