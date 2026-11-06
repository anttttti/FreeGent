import { describe, it, expect } from 'vitest';
import { truncateResultForHistory } from '../history.ts';

describe('review: web_search truncation and step budget accounting', () => {
    it('bounds web_search results to the limit and charges the step budget', () => {
        const stepBudget = { remaining: 1500 };
        const results = Array.from({ length: 15 }, (_, i) => ({
            title: `Search Result ${i}`,
            url: `https://example.com/page/${i}`,
            snippet: 'A'.repeat(500),
        }));
        const raw = { results };

        const out = truncateResultForHistory('web_search', raw, { stepBudget });
        const outLen = JSON.stringify(out).length;

        // When web_search exceeds the budget/limit, its retained size must be charged to stepBudget,
        // and the retained output must not exceed the allowed limit (1500).
        expect(stepBudget.remaining).toBeLessThan(1500);
        expect(outLen).toBeLessThanOrEqual(1500);
    });
});
