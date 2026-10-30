// codex R240: a page with a doctype and no <head> was previewed in quirks mode (the injected script came before the doctype), and
// /<head[^>]*>/ matched <header>.
import { describe, it, expect } from 'vitest';
import { injectIntoHead } from '../html-inject.ts';

const mode = (html: string) => new DOMParser().parseFromString(html, 'text/html').compatMode;

describe('injectIntoHead', () => {
    it('keeps a doctype first when there is no <head>, so the page stays in standards mode', () => {
        const page = '<!doctype html><title>Demo</title><p>x</p>';
        expect(mode(page)).toBe('CSS1Compat');
        const out = injectIntoHead(page, '<script>1</script>');
        expect(out.startsWith('<!doctype html><script>1</script>')).toBe(true);
        expect(mode(out)).toBe('CSS1Compat');
        expect(mode('<script>1</script>' + page)).toBe('BackCompat');   // the old prepend
    });
    it('goes after <head>, not into a <header>', () => {
        expect(injectIntoHead('<html><body><header>h</header></body></html>', 'S')).toBe('<html>S<body><header>h</header></body></html>');
        expect(injectIntoHead('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"></head><body><header>h</header>', 'S'))
            .toBe('<!DOCTYPE html><html lang="en"><head>S<meta charset="utf-8"></head><body><header>h</header>');
    });
    it('keeps a BOM, comments before the doctype, and a bare fragment', () => {
        expect(injectIntoHead('﻿<!-- c --><!DOCTYPE html><p>x', 'S')).toBe('﻿<!-- c --><!DOCTYPE html>S<p>x');
        expect(injectIntoHead('<p>fragment</p>', 'S')).toBe('S<p>fragment</p>');
    });
});
