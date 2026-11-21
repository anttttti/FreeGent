import { describe, it, expect } from 'vitest';
import { errorLine, _repeatRefusalResult } from '../detectors.js';

describe('errorLine (tool_failure nudge)', () => {
    it('keeps the first line of a multi-line error, never a half line of the hint', () => {
        const e = 'replace_in_file: old_string not found in "src/main.js".\nClosest matches in file (adjust old_string to one of these):\n  L12: foo()';
        expect(errorLine(e)).toBe('replace_in_file: old_string not found in "src/main.js".');
    });
    it('cuts a long single line at 120 characters', () => {
        expect(errorLine('x'.repeat(300))).toHaveLength(120);
    });
    it('ends a long line at a sentence, not in the middle of one', () => {
        expect(errorLine(_repeatRefusalResult(8).error)).toBe('Not executed: this exact call already ran 8 times in your last 12 steps with the same result.');
    });
});
