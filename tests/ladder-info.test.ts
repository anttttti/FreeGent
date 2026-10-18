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
const R = (correct: number, attempted: number, capK: number[], stops: string[], tokPerS: number | null = 40): LadderResult =>
    ({ correct, attempted, capK, stops, ceilingK: 250, tokPerS, tokens: 1 });

describe('generated model-ladder.ts', () => {
    it('has a date and sane numbers', () => {
        expect(MODEL_LADDER_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        for (const [spec, r] of Object.entries(MODEL_LADDER)) {
            expect(spec).toContain('|');
            expect(r.correct).toBeLessThanOrEqual(r.attempted);
            expect(r.capK.length).toBe(r.stops.length);
        }
    });
});

describe('ladder-info', () => {
    const table = {
        'a|m': R(170, 195, [250, 250, 250], ['ceiling', 'ceiling', 'ceiling']),
        'b|m': R(120, 130, [180, 90], ['quota', 'ceiling'], null),
        'c|other': R(10, 60, [60], ['context']),
    };
    it('formatLadder is empty without a result; states solved tasks, context held, speed and a stopping limit', () => {
        expect(formatLadder(null)).toBe('');
        expect(formatLadder(table['a|m'])).toBe('long chats: 170/195 microtasks solved, held 250K/250K/250K tokens (test ceiling), 40 tok/s');
        expect(formatLadder(table['b|m'])).toBe("long chats: 120/130 microtasks solved, held 180K/90K tokens; a chat was ended by the free tier's quota");
        expect(formatLadder(table['c|other'])).toContain("ended by the free tier's context limit");
    });
    it('bestLadder takes the highest solve rate over all providers of a model and ignores unknown specs', () => {
        expect(bestLadder(['nope|nothing'], table)).toBeNull();
        expect(bestLadder(['a|m', 'b|m', 'nope|x'], table)).toBe(table['b|m']);   // 120/130 beats 170/195
        expect(bestLadder(['c|other'], table)).toBe(table['c|other']);
    });
});

describe('ranking prompt line', () => {
    it('adds the long-chat summary before the usage count, and nothing for untested models', () => {
        const spec = Object.keys(MODEL_LADDER)[0];
        if (spec) {   // the generated table may be empty before the first run
            const [prov, model] = spec.split('|');
            const [g1] = M.buildModelRankGroups([e(prov, model)]);
            expect(g1.ladder).toMatch(/^long chats: \d+\/\d+ microtasks solved/);
            expect(M.formatModelRankLine(1, g1)).toContain(`, ${g1.ladder}, not used here yet`);
        }
        const [g2] = M.buildModelRankGroups([e('kilo', 'untested/never-run-model:free')]);
        expect(g2.ladder).toBe('');
        expect(M.formatModelRankLine(1, g2)).not.toContain('long chats');
    });
});
