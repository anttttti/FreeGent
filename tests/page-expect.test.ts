import { describe, it, expect } from 'vitest';
import { parseExpectations, judgeExpectation, summarizeExpectations } from '../page-expect.js';

describe('check_page expectations', () => {
    it('parses well-formed items only', () => {
        expect(parseExpectations([{ expr: 'G.state', equals: 'play' }, { expr: '' }, 5, { expr: 'x', matches: '^a' }, { expr: 'y' }]))
            .toEqual([{ expr: 'G.state', equals: 'play' }, { expr: 'x', matches: '^a' }, { expr: 'y', truthy: true }]);
        expect(parseExpectations('nope')).toEqual([]);
    });
    it('judges equals against the page string form, quoted or bare', () => {
        expect(judgeExpectation({ expr: 'G.state', equals: 'play' }, '"play"').ok).toBe(true);
        expect(judgeExpectation({ expr: 'G.state', equals: 'play' }, 'title').ok).toBe(false);
        expect(judgeExpectation({ expr: 'G.rings', equals: 0 }, '0').ok).toBe(true);
        expect(judgeExpectation({ expr: 'G.rings', equals: 0 }, '3').ok).toBe(false);
    });
    it('judges matches, truthy and evaluation errors', () => {
        expect(judgeExpectation({ expr: 'x', matches: 'lv\\d' }, 'lv2').ok).toBe(true);
        expect(judgeExpectation({ expr: 'x', truthy: true }, 'null').ok).toBe(false);
        expect(judgeExpectation({ expr: 'x', truthy: false }, 'null').ok).toBe(true);
        const e = judgeExpectation({ expr: 'a.b', equals: 1 }, undefined, 'a is not defined');
        expect(e.ok).toBe(false);
        expect(e.actual).toContain('a is not defined');
    });
    it('summarizes the verdict, naming what was not met', () => {
        const r = [judgeExpectation({ expr: 'a', equals: 1 }, '1'), judgeExpectation({ expr: 'G.state', equals: 'play' }, 'title')];
        expect(summarizeExpectations(r)).toBe('1/2 expectations met; not met: G.state expected = play, got title');
        expect(summarizeExpectations([r[0]])).toBe('1/1 expectations met.');
    });
});

// codex R239: the pattern runs on the app thread; `(a+)+$` against a long near-match froze it.
describe('unsafe patterns are not run', () => {
    it('refuses nested repetition, alternation under repetition, back-references and long patterns; ordinary ones run', async () => {
        const { unsafePatternReason, judgeExpectation } = await import('../page-expect.ts');
        for (const p of ['(a+)+$', '(a*)*b', '(x+x+)+y', '(a|aa)+$', '(\\w+\\s?)*$', '(.*a){2,}', '(a)\\1', 'x'.repeat(301)]) expect(unsafePatternReason(p), p).not.toBeNull();
        for (const p of ['^\\d+$', 'score: \\d+', '(foo|bar)', '^(ab)+$', '[a-z]+@[a-z]+\\.com', '(\\d{3})-\\d{4}']) expect(unsafePatternReason(p), p).toBeNull();
        const t0 = Date.now();
        const r = judgeExpectation({ expr: 'x', matches: '(a+)+$' }, 'a'.repeat(4000) + '!');
        expect(Date.now() - t0).toBeLessThan(100);
        expect(r.ok).toBe(false);
        expect(r.actual).toMatch(/pattern not run/);
    });
});
