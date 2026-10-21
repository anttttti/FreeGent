import { describe, it, expect } from 'vitest';
import { fmQuote, fmUnquote } from '../yaml-scalar.ts';

const rt = (t: string) => fmUnquote(fmQuote(t));

describe('front-matter title scalars (codex report 8, cases 207-209)', () => {
    it('round-trips ordinary and awkward titles exactly', () => {
        for (const t of ['Plain title', 'Prepare: "Quarterly report"', 'Review C:\\reports\\Q4', 'It\'s: fine', 'Fix #12: crash', 'Say "hi"',
            'Ends with quote"', "Ends with apostrophe'", '"Starts with quote', '  padded  ', 'a \\ b', 'tab\\nliteral', '- dash first', 'ünï: 日本語'])
            expect(rt(t), t).toBe(t);
    });
    it('leaves safe titles plain and quotes the ones YAML would misparse', () => {
        expect(fmQuote('Plain title')).toBe('Plain title');
        expect(fmQuote('Ends with quote"')).toBe('Ends with quote"');
        expect(fmQuote('Prepare: "Quarterly report"')).toBe('"Prepare: \\"Quarterly report\\""');
        expect(fmQuote('Review C:\\reports\\Q4')).toBe('"Review C:\\\\reports\\\\Q4"');
        expect(fmQuote('Fix #12')).toBe('"Fix #12"');   // " #" starts a YAML comment
        expect(fmQuote('Fix#12')).toBe('Fix#12');
        expect(fmQuote('a #b')).toBe('"a #b"');
        expect(fmQuote('No')).toBe('"No"');   // a YAML reader would take it for false
        expect(fmQuote('Notes')).toBe('Notes');
    });
    it('reads literal boundary punctuation and old files', () => {
        expect(fmUnquote('Title"')).toBe('Title"');
        expect(fmUnquote("Title'")).toBe("Title'");
        expect(fmUnquote('"Review C:\\reports\\Q4"')).toBe('Review C:\\reports\\Q4');   // older writers did not escape
        expect(fmUnquote("'it''s'")).toBe("it's");
        expect(fmUnquote('  "x"  ')).toBe('x');
    });
});
