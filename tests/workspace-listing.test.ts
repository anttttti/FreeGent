// First-turn workspace listing (turn-context.ts formatWorkspaceListing), injected in every mode
// so the agent does not spend its first step on list_files.
import { describe, it, expect } from 'vitest';
import { formatWorkspaceListing } from '../turn-context.ts';

describe('formatWorkspaceListing', () => {
    it('states an empty workspace explicitly', () => {
        expect(formatWorkspaceListing([])).toContain('(empty — the workspace has no files yet)');
    });

    it('says nothing for an empty container listing (the find may have failed)', () => {
        expect(formatWorkspaceListing([], { inContainer: true })).toBe('');
    });

    it('lists a small workspace in full, sorted', () => {
        const out = formatWorkspaceListing(['index.html', 'game.js', 'fg-tasks/001-setup.md']);
        expect(out).toBe('<workspace_files>\n3 files:\nfg-tasks/001-setup.md\ngame.js\nindex.html\n</workspace_files>');
    });

    it('collapses a large repo to directory counts within the budget', () => {
        const paths = [
            'setup.py', 'README.rst',
            ...Array.from({ length: 300 }, (_, i) => `django/sub${i % 7}/f${i}.py`),
            ...Array.from({ length: 400 }, (_, i) => `docs/p${i}.txt`),
        ];
        const out = formatWorkspaceListing(paths);
        expect(out.length).toBeLessThan(3200);
        expect(out).toContain('702 files');
        expect(out).toContain('docs/ (400 files)');
        expect(out).toContain('setup.py');
        expect(out).not.toContain('docs/p1.txt');
    });

    it('drops directory entries emitted by container find, and flags a truncated listing', () => {
        const out = formatWorkspaceListing([
            '/app', '/app/src', '/app/src/main.c', '/app/src/util.c', '/app/Makefile',
            '[listing truncated at 500 entries — use execute_code bash `find` or `ls` for full coverage]',
        ], { inContainer: true });
        expect(out).toContain('3+ files (listing truncated)');
        expect(out).toContain('/app/src/main.c');
        expect(out.split('\n')).not.toContain('/app/src');
        expect(out.split('\n')).not.toContain('/app');
    });
});
