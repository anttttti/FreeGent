import { describe, it, expect, vi } from 'vitest';
import { previewCandidates, selectPreviewFile } from '../preview-pane.js';

describe('previewCandidates', () => {
    it('drops scratch, task, tooling, dot and local files', () => {
        const names = ['tmp/a.py', 'tasks/1.md', 'fg-tasks/ledger.md', 'src/tmp/x.js', 'node_modules/p/i.js',
            '.git/config', 'local/a.html', 'game.html', 'docs/readme.md', 'src/main.js'];
        expect(previewCandidates(names)).toEqual(['game.html', 'docs/readme.md', 'src/main.js']);
    });
});

describe('selectPreviewFile', () => {
    it('uses root index.html without asking the model', async () => {
        const pick = vi.fn();
        expect(await selectPreviewFile(['a.html', 'index.html', 'b.css'], pick)).toBe('index.html');
        expect(pick).not.toHaveBeenCalled();
    });
    it('does not treat a nested index.html as root', async () => {
        const pick = vi.fn(async () => 'a.html');
        expect(await selectPreviewFile(['sub/index.html', 'a.html', 'b.css'], pick)).toBe('a.html');
        expect(pick).toHaveBeenCalledOnce();
    });
    it('returns null when only excluded files exist', async () => {
        expect(await selectPreviewFile(['tmp/x', 'tasks/y.md'], async () => 'tmp/x')).toBeNull();
    });
    it('skips the model for a single candidate', async () => {
        const pick = vi.fn();
        expect(await selectPreviewFile(['tmp/x', 'only.txt'], pick)).toBe('only.txt');
        expect(pick).not.toHaveBeenCalled();
    });
    it('accepts a quoted answer, rejects a hallucinated one and falls back to an html file', async () => {
        expect(await selectPreviewFile(['a.css', 'b.md'], async () => '"b.md"\n')).toBe('b.md');
        expect(await selectPreviewFile(['a.css', 'p.html'], async () => 'nope.txt')).toBe('p.html');
        expect(await selectPreviewFile(['a.css', 'b.md'], async () => { throw new Error('x'); })).toBeNull();
    });
});
