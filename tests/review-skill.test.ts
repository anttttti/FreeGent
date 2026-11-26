// skills/review/SKILL.md: the front matter loads, the folder and name agree, and the natural-language trigger fires for review requests only.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseFrontmatter } from '../frontmatter.ts';

const src = readFileSync('skills/review/SKILL.md', 'utf8');
const fm = parseFrontmatter(src);

describe('review skill', () => {
    it('has the folder name, a description and a pattern trigger that compiles', () => {
        expect(fm.name).toBe('review');
        expect(fm.description).toMatch(/uncommitted/);
        expect(() => new RegExp(fm.trigger_on_message_pattern, 'i')).not.toThrow();
    });
    it('the trigger matches review requests and not unrelated messages', () => {
        const re = new RegExp(fm.trigger_on_message_pattern, 'i');
        for (const m of ['/review', 'review', 'Review my uncommitted changes', 'review the last commit', 'please do a code review', 'review this branch', 'Review the staged changes', 'review pr'])
            expect(re.test(m), m).toBe(true);
        for (const m of ['add a review form to the page', 'write a book review', 'preview the page', 'fix the reviewer button', 'summarize the commit log'])
            expect(re.test(m), m).toBe(false);
    });
    it('names every target and stays read-only', () => {
        for (const w of ['uncommitted', 'staged', 'branch', 'commit', 'merge-base', 'untracked']) expect(src).toContain(w);
        expect(src).toMatch(/do not edit files, commit, stash, reset or push/);
        expect(src).toContain('VERDICT:');
    });
});
