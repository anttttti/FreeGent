// exec-output.test.ts — execute_code output shaping in the headless runner: curl's progress
// meter is removed from stderr (v0.56: 452 results), and long output keeps head + tail instead of
// the tail only (v0.56: 742 results lost their head).
import { describe, it, expect } from 'vitest';
import { stripCurlProgress, clipOutput, appendOut, CLIP_HEAD, CLIP_TAIL } from '../exec-output.ts';

const HEADER = '  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n                                 Dload  Upload   Total   Spent    Left  Speed\n';

describe('stripCurlProgress', () => {
    it('removes a meter-only stderr entirely (TAC v0.56)', () => {
        const s = HEADER + '\r  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0\r100  3543  100  3543    0     0   4677      0 --:--:-- --:--:-- --:--:--  4674\r100  3543  100  3543    0     0   4676      0 --:--:-- --:--:-- --:--:--  4674\n';
        expect(stripCurlProgress(s)).toBe('');
    });
    it('handles unit suffixes and elapsed times', () => {
        const s = HEADER + '\r100 3243k  100 3243k    0     0  26.6M      0  0:00:01  0:00:01 --:--:-- 26.8M\n';
        expect(stripCurlProgress(s)).toBe('');
    });
    it('keeps -v output and errors that follow a meter row with no newline', () => {
        const s = HEADER + '\r  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0*   Trying 127.0.0.1:8091...\n* Connected to host\ncurl: (22) The requested URL returned error: 404\n';
        expect(stripCurlProgress(s)).toBe('*   Trying 127.0.0.1:8091...\n* Connected to host\ncurl: (22) The requested URL returned error: 404\n');
    });
    it('leaves other stderr untouched', () => {
        const s = 'Traceback (most recent call last):\n  File "x.py", line 3\nValueError: 100 %\n';
        expect(stripCurlProgress(s)).toBe(s);
    });
});

describe('clipOutput', () => {
    it('keeps short output as is', () => {
        expect(clipOutput('abc')).toBe('abc');
    });
    it('keeps the head and the tail of long output and says how much was dropped', () => {
        const s = 'HEAD' + 'x'.repeat(10_000) + 'TAIL';
        const c = clipOutput(s);
        expect(c.startsWith('HEAD')).toBe(true);
        expect(c.endsWith('TAIL')).toBe(true);
        expect(c).toContain(`${s.length - CLIP_HEAD - CLIP_TAIL} chars omitted`);
    });
    it('keeps the head of a stream that overflowed the buffer', () => {
        const buf = { text: '', dropped: 0 };
        appendOut(buf, 'Columns: a, b, c\n', 50_000);
        for (let i = 0; i < 100; i++) appendOut(buf, 'row\n'.repeat(1_000), 50_000);
        appendOut(buf, 'Total: 42\n', 50_000);
        expect(buf.text.length).toBeLessThanOrEqual(50_000);
        const c = clipOutput(buf.text, buf.dropped);
        expect(c.startsWith('Columns: a, b, c')).toBe(true);
        expect(c.endsWith('Total: 42\n')).toBe(true);
        const total = 'Columns: a, b, c\n'.length + 100 * 4_000 + 'Total: 42\n'.length;
        expect(c).toContain(`${total - CLIP_HEAD - CLIP_TAIL} chars omitted`);
    });
});
