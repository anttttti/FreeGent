// read_file de-duplication (history.ts truncateResultForHistory): a repeated read is
// suppressed only while the content is unchanged. fg-chat 2026-09-27-01-29-29: after
// `sed -i` edited game.js through WASM bash (no per-file invalidation), the next read_file
// returned "Already read" and the model worked from the pre-edit copy.
import { describe, it, expect, beforeEach } from 'vitest';
import { truncateResultForHistory, resetSeenReadFiles } from '../history.ts';

const read = (content: string) =>
    truncateResultForHistory('read_file', { path: 'game.js', content });

describe('read_file dedup', () => {
    beforeEach(() => resetSeenReadFiles());

    it('suppresses a repeat read of unchanged content', () => {
        expect(read('const a = 1;').content).toBe('const a = 1;');
        expect(read('const a = 1;').note).toMatch(/Already read/);
    });

    it('serves a repeat read when the file changed outside write_file (e.g. sed -i)', () => {
        read("getElementById('highScore')");
        const again = read("getElementById('high-score')");
        expect(again.note).toBeUndefined();
        expect(again.content).toBe("getElementById('high-score')");
        // …and the new content is then the one deduplicated against.
        expect(read("getElementById('high-score')").note).toMatch(/Already read/);
    });

    it('serves a changed file whose old fingerprint was a 32-bit collision (X013)', () => {
        // Two 32-character strings with equal FNV-1a hashes (found by a birthday search): the earlier 32-bit fingerprint treated them as one file.
        const [a, b] = ['d36bf0d97d861074b2d089d3c39e9e56', '774566dc0c835839f8e64cc5199599ef'];
        read(a);
        const again = read(b);
        expect(again.note).toBeUndefined();
        expect(again.content).toBe(b);
    });
});
