// A guest whose day of searches on the Worker's key is used up (X-FG-Guest: search-limit) gets the Worker's message, and Auto mode goes on to the next provider.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { tavilySearch, braveSearch } from '../search-providers.ts';

const W: any = window;
const spent = (who: string) => new Response(JSON.stringify({ error: `This browser has used its guest ${who} searches for today (10)` }), { status: 403, headers: { 'X-FG-Guest': 'search-limit' } });
afterEach(() => { vi.unstubAllGlobals(); delete W.getEffectiveProxy; delete W.getTavilyKey; delete W.getBraveKey; delete W.hasCfTavilyKey; delete W.hasCfBraveKey; });

describe('guest search limit', () => {
    it('is reported with the Worker\'s own message by both providers, not as a bad key or a bare HTTP 403', async () => {
        W.getEffectiveProxy = () => 'https://proxy.example'; W.getTavilyKey = () => ''; W.getBraveKey = () => ''; W.hasCfTavilyKey = () => true; W.hasCfBraveKey = () => true;
        vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => spent(String(init?.body).includes('tavily') ? 'Tavily' : 'Brave')));
        const t: any = await tavilySearch('q');
        expect(t.error).toMatch(/guest Tavily searches for today/);
        expect(t.authFailed).toBeUndefined();
        expect(((await braveSearch('q')) as any).error).toMatch(/guest Brave searches for today/);
    });
});
