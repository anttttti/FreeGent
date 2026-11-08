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
});
