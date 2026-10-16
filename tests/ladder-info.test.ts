// Long-context conversation results (bench/modelladder → generated model-ladder.ts) reach the ranking prompt and the update modal
// through ladder-info.ts: best result over the providers serving a model, one summary line.
import { describe, it, expect, beforeAll } from 'vitest';
import { MODEL_LADDER, MODEL_LADDER_DATE, type LadderResult } from '../model-ladder.ts';
import { bestLadder, formatLadder } from '../ladder-info.ts';

const W = window as any;
let M: any;
beforeAll(async () => {
    W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    M = await import('../settings-ui.ts');
});
const e = (provider: string, model: string) =>
    ({ provider, model, label: model, released: '2026-10', contextK: 1000, params: 120, media: ['text'], tools: true, thinking: true, note: '' });
const R = (c: [number, number], k: [number, number], r: [number, number], capK: [number, number, number], limit: string | null = null): LadderResult =>
    ({ coding: c, knowledge: k, reasoning: r, capK, ceilingK: 250, limit, tokens: 1, medianS: 1 });

describe('generated model-ladder.ts', () => {
    it('has a date and sane numbers', () => {
        expect(MODEL_LADDER_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        for (const [spec, r] of Object.entries(MODEL_LADDER)) {
            expect(spec).toContain('|');
            for (const d of [r.coding, r.knowledge, r.reasoning]) { expect(d[0]).toBeLessThanOrEqual(d[1]); expect(d[0]).toBeGreaterThanOrEqual(0); }
            expect(r.capK.length).toBeGreaterThan(0);
        }
    });
});

describe('ladder-info', () => {
    const table = {
        'a|m': R([4, 6], [6, 6], [3, 6], [250, 250, 250]),
        'b|m': R([5, 6], [6, 6], [5, 6], [180, 180, 170], 'HTTP 429 daily quota'),
        'c|other': R([1, 6], [2, 6], [0, 6], [60, 60, 60]),
    };
    it('formatLadder is empty without a result; states the domains, the context held and a stopping limit', () => {
        expect(formatLadder(null)).toBe('');
        expect(formatLadder(table['a|m'])).toBe('long chats: coding 4/6 (held 250K, ceiling), knowledge 6/6 (held 250K, ceiling), reasoning 3/6 (held 250K, ceiling)');
        expect(formatLadder(table['b|m'])).toBe('long chats: coding 5/6 (held 180K), knowledge 6/6 (held 180K), reasoning 5/6 (held 170K); free tier stopped a chat: HTTP 429 daily quota');
    });
    it('bestLadder takes the highest solve rate over all providers of a model and ignores unknown specs', () => {
        expect(bestLadder(['nope|nothing'], table)).toBeNull();
        expect(bestLadder(['a|m', 'b|m', 'nope|x'], table)).toBe(table['b|m']);
        expect(bestLadder(['c|other'], table)).toBe(table['c|other']);
    });
});

describe('ranking prompt line', () => {
    it('adds the long-chat summary before the usage count, and nothing for untested models', () => {
        const spec = Object.keys(MODEL_LADDER)[0];
        if (spec) {   // the generated table may be empty before the first run
            const [prov, model] = spec.split('|');
            const [g1] = M.buildModelRankGroups([e(prov, model)]);
            expect(g1.ladder).toMatch(/^long chats: coding \d+\/\d+/);
            expect(M.formatModelRankLine(1, g1)).toContain(`, ${g1.ladder}, not used here yet`);
        }
        const [g2] = M.buildModelRankGroups([e('kilo', 'untested/never-run-model:free')]);
        expect(g2.ladder).toBe('');
        expect(M.formatModelRankLine(1, g2)).not.toContain('long chats');
    });
});
