import { describe, it, expect } from 'vitest';
import { _checkTextResponse, _isLoopedLongText, LONG_TEXT_HARD_CAP } from '../detectors.ts';
import { readFileSync } from 'fs';

const doc = (n: number) => Array.from({ length: n }, (_, i) => `Section ${i}: ${(i * 2654435761 % 1e9).toString(36)} covers ${i % 97} topics in region ${(i * 31) % 1013}.`).join('\n\n');

describe('long text replies', () => {
    it('a 55 KB document is accepted', () => {
        const t = doc(1000); expect(t.length).toBeGreaterThan(30_000);
        expect(_checkTextResponse(t, 1, 50)).toBeNull();
    });
    it('a looping reply is still a runaway', () => {
        const unit = 'The same sentence repeats again and again without end. ';
        const t = unit.repeat(1200);
        expect(t.length).toBeGreaterThan(30_000);
        expect(_isLoopedLongText(t)).toBe(true);
        expect(_checkTextResponse(t, 1, 50)?.action).toBe('runaway');
    });
    it('a unit that is not a multiple of the sampling grid is still caught', () => {
        const t = 'abcdefghij klmnopqrs tuvwxyz 0123456789 '.repeat(1000);
        expect(_isLoopedLongText(t)).toBe(true);
    });
    it('anything past the hard cap is refused', () => {
        expect(_isLoopedLongText(doc(8000).padEnd(LONG_TEXT_HARD_CAP + 1, 'x'))).toBe(true);
    });
});

describe('JS sandbox timeout', () => {
    it('is 60 s with a notice that Stop cancels, and the timeout names its cause', () => {
        const s = readFileSync(`${process.cwd()}/tools.ts`, 'utf8');
        expect(s).toContain('const JS_SANDBOX_TIMEOUT_MS = 60_000');
        expect(s).toContain('press Stop to cancel it');
        expect(s).toContain('an endless loop, or work that needs longer');
    });
});
