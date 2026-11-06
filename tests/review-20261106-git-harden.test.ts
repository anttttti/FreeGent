import { describe, it, expect } from 'vitest';
import { gitArgsRefusal, hardenGitArgs } from '../dev-api.ts';

describe('review: gitArgsRefusal and hardenGitArgs boundary', () => {
    it('refuses external diff and textconv options that invoke repository-defined programs', () => {
        // Opencode §3.2 and dev-api.ts:648-649 specify that git runs as a data-only reader
        // without invoking programs named by repository config (external diff drivers or textconv filters).
        // hardenGitArgs inserts --no-ext-diff and --no-textconv, but caller-supplied --ext-diff or --textconv
        // appears after them and overrides them in git argument precedence, or bypasses hardenGitArgs entirely for grep.
        expect(gitArgsRefusal(['diff', '--ext-diff'])).not.toBeNull();
        expect(gitArgsRefusal(['diff', '--textconv'])).not.toBeNull();
        expect(gitArgsRefusal(['show', '--ext-diff'])).not.toBeNull();
        expect(gitArgsRefusal(['grep', '--textconv', 'pattern'])).not.toBeNull();
    });
});
