import { describe, it, expect } from 'vitest';
import { rootPageOf } from '../detectors.ts';

// kanbanflow set 3: the agent's own test_page.html was "the only page at the root" and its error refused a task's done for 13 turns.
describe('rootPageOf', () => {
    it('prefers index.html, else the only page at the root', () => {
        expect(rootPageOf(['a.js', 'index.html', 'about.html', 'site/index.html'])).toBe('index.html');
        expect(rootPageOf(['game.html', 'game.js'])).toBe('game.html');
        expect(rootPageOf(['a.html', 'b.html'])).toBe(null);
    });
    it('does not take the agent\'s own test page for the project\'s page', () => {
        expect(rootPageOf(['lib/list.mjs', 'test_page.html'])).toBe(null);
        expect(rootPageOf(['scratch.html', 'x.js'])).toBe(null);
        expect(rootPageOf(['flatten_test.html'])).toBe(null);
        expect(rootPageOf(['test_page.html', 'index.html'])).toBe('index.html');
    });
    it('index.html is preferred to index.htm (review of c8ec6fd)', () => {
        expect(rootPageOf(['index.htm', 'index.html'])).toBe('index.html');
        expect(rootPageOf(['index.htm'])).toBe('index.htm');
    });
    it('a page whose name only starts with "test" is a page, and the agent\'s own pages are set aside before counting (review of dde5141)', () => {
        expect(rootPageOf(['testimonials.html'])).toBe('testimonials.html');
        expect(rootPageOf(['game.html', 'test_page.html'])).toBe('game.html');
        expect(rootPageOf(['a.html', 'b.html'])).toBe(null);
        expect(rootPageOf(['test_page.html'])).toBe(null);
    });
});
