// codex report 8, cases 469-471: attachment notes in a stored user turn come back as chips whatever the file is called.
import { describe, it, expect } from 'vitest';
import { extractAttachmentNames } from '../history-util.ts';

describe('extractAttachmentNames', () => {
    it('names with commas and brackets', () => {
        const t = '[Attached file: report, Q4.dat, 8 B; original available at report, Q4.dat]\n[Attached file: report [draft].dat, 1.5 KB; original available at report [draft].dat]\n[Attached file: control.dat, 8 B]\nhello';
        const r = extractAttachmentNames(t);
        expect(r.names).toEqual(['report, Q4.dat', 'report [draft].dat', 'control.dat']);
        expect(r.text).toBe('hello');
    });
    it('image notes, binary and unsupported-media notes', () => {
        expect(extractAttachmentNames('[Binary file attached: a [1].bin, application/octet-stream, 3 KB]\n[Audio attached: s, 1.wav, 2.0 MB — audio not supported by x; original available at s, 1.wav]').names)
            .toEqual(['a [1].bin', 's, 1.wav']);
    });
    it('text file blocks, with the escaped name restored and file bodies removed', () => {
        const t = '<file name="totals, Q4 &amp; [x].csv">\nOriginal file: totals, Q4 & [x].csv\n```csv\na,b\n```\n</file>\n\n<file name="r.txt">\n```\nhi\n```\n</file>\n\ncaption';
        const r = extractAttachmentNames(t);
        expect(r.names).toEqual(['totals, Q4 & [x].csv', 'r.txt']);
        expect(r.text).toBe('caption');
    });
    it('user text that merely looks like a note is kept', () => {
        expect(extractAttachmentNames('[Attached file: nothing]').text).toBe('[Attached file: nothing]');
    });
});
