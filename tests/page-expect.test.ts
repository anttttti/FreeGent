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
