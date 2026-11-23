import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('OpenRouter free models', () => {
    it('all carry the free-tier request limits, so FreeGent throttles them before OpenRouter answers 429 (commit review of 4b4b513)', () => {
        const rows = readFileSync('config.ts', 'utf8').split('\n').filter(l => /provider:'openrouter', model:'[^']*:free'/.test(l));
        expect(rows.length).toBeGreaterThan(5);
        expect(rows.filter(l => !/rpm:\s*20,\s*rpd:\s*50/.test(l)).map(l => l.match(/model:'([^']*)'/)![1])).toEqual([]);
    });
});
