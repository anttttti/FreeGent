// Tests for extractRelevant — the shared relevance-extraction helper used by both the
// deep-research per-page extractor and the fetch_url `extract` option. callLLMComplete is
// stubbed so we exercise chunking, NOTHING-filtering, and the small-input short-circuit
// without real network/LLM calls.
// deep-research.js is imported as an ES module in tests/setup.js; no eval needed here.
import { describe, it, expect, vi } from 'vitest';

describe('extractRelevant', () => {
    it('returns "" for text below the minimum length without calling the LLM', async () => {
        const spy = vi.fn();
        window.callLLMComplete = spy;
        const out = await window.extractRelevant('anything', 'too short');
        expect(out).toBe('');
        expect(spy).not.toHaveBeenCalled();
    });

    it('returns relevant passages from a single chunk', async () => {
        window.callLLMComplete = vi.fn(async () => 'The cache TTL is 24 hours.');
        const out = await window.extractRelevant('cache ttl', 'x'.repeat(500));
        expect(out).toBe('The cache TTL is 24 hours.');
    });

    it('filters out NOTHING responses', async () => {
        window.callLLMComplete = vi.fn(async () => 'NOTHING');
        const out = await window.extractRelevant('unrelated', 'y'.repeat(500));
        expect(out).toBe('');
    });

    it('chunks large input and joins per-chunk findings, capped by maxChunks', async () => {
        const calls = [];
        window.callLLMComplete = vi.fn(async (prompt) => { calls.push(prompt); return `hit${calls.length}`; });
        // 90k chars with default 40k chunk + maxChunks=2 → exactly 2 LLM calls
        const out = await window.extractRelevant('goal', 'z'.repeat(90_000));
        expect(window.callLLMComplete).toHaveBeenCalledTimes(2);
        expect(out).toBe('hit1\nhit2');
    });

    it('tolerates a failed LLM call (returns "" for that chunk)', async () => {
        window.callLLMComplete = vi.fn(async () => { throw new Error('rate limit'); });
        const out = await window.extractRelevant('goal', 'w'.repeat(500));
        expect(out).toBe('');
    });
});
