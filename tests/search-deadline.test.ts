// codex R252: the alternate search sources (Hacker News, GitHub, arXiv, PubMed, npm, PyPI, …) passed only the Stop signal, so a source that
// never answered held the turn until the user stopped it. They share the primary search's 30 s deadline.
import { describe, it, expect, vi, afterEach } from 'vitest';
const W = globalThis as any;

let savedTimeout: any;
afterEach(() => { vi.useRealTimers(); (AbortSignal as any).timeout = savedTimeout; });

describe('every search source has a deadline', () => {
    it('a package search and a Hacker News search that never answer end after 30 s', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        savedTimeout = (AbortSignal as any).timeout; (AbortSignal as any).timeout = undefined;   // the setTimeout fallback, which fake timers drive
        W.fetch.mockReset();
        W.fetch.mockImplementation((_u: string, init: any) => new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal.reason ?? new Error('aborted')))));
        const npm = W.executeToolAsync('package_search', { query: 'left-pad', registry: 'npm' }, null);
        const hn = W.executeToolAsync('web_search', { query: 'x', source: 'hackernews' }, null);
        await vi.advanceTimersByTimeAsync(31_000);
        const [a, b] = await Promise.all([npm, hn]);
        expect(a.error ?? a).toBeTruthy();
        expect(JSON.stringify(a)).toMatch(/error/i);
        expect(JSON.stringify(b)).toMatch(/error/i);
    });
});
