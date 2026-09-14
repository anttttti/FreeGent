// Tests for _rewriteHunkCounts — the apply_patch preprocessing step that recomputes
// @@ -a,b +c,d @@ header counts from the actual hunk body so models that miscalculate
// them (81% of observed apply_patch errors) don't fail at the jsdiff validation stage.
import { describe, it, expect } from 'vitest';

const W = window;

describe('_rewriteHunkCounts', () => {
    it('leaves a correct patch unchanged', () => {
        const patch = `--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n context\n-old\n+new\n context2`;
        const { patch: out, corrections } = W._rewriteHunkCounts(patch);
        expect(out).toBe(patch);
        expect(corrections).toHaveLength(0);
    });

    it('fixes a wrong added-line count (model said ,1 but body has 2 new lines)', () => {
        const patch = `--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n context\n-old\n+new`;
        // body: 1 context + 1 removed = 2 old; 1 context + 1 new = 2 new
        const { patch: out, corrections } = W._rewriteHunkCounts(patch);
        expect(out).toContain('@@ -1,2 +1,2 @@');
        expect(corrections).toHaveLength(1);
    });

    it('fixes a wrong removed-line count', () => {
        // model wrote ,1 for old but body has 2 removed lines
        const patch = `--- a/f\n+++ b/f\n@@ -5,1 +5,0 @@\n-line1\n-line2`;
        const { patch: out } = W._rewriteHunkCounts(patch);
        expect(out).toContain('@@ -5,2 +5,0 @@');
    });

    it('handles pure insertion (old count 0)', () => {
        const patch = `--- a/f\n+++ b/f\n@@ -3,1 +3,3 @@\n context\n+added1\n+added2`;
        // old: 1 context = 1; new: 1 context + 2 added = 3 — already correct
        const { patch: out, corrections } = W._rewriteHunkCounts(patch);
        expect(out).toContain('@@ -3,1 +3,3 @@');
        expect(corrections).toHaveLength(0);
    });

    it('handles missing count (shorthand ,1 implied) and corrects it', () => {
        // @@ -5 +5 @@ is shorthand for @@ -5,1 +5,1 @@
        // body has 2 old and 2 new lines → should rewrite to ,2
        const patch = `--- a/f\n+++ b/f\n@@ -5 +5 @@\n context\n-old\n+new`;
        const { patch: out, corrections } = W._rewriteHunkCounts(patch);
        expect(out).toContain('@@ -5,2 +5,2 @@');
        expect(corrections).toHaveLength(1);
    });

    it('handles multiple hunks independently', () => {
        const patch = [
            '--- a/f', '+++ b/f',
            '@@ -1,1 +1,1 @@',  // wrong: body has 2+2
            ' context',
            '-old',
            '+new',
            '@@ -10,3 +10,3 @@',  // correct
            ' a',
            '-b',
            '+c',
            ' d',
        ].join('\n');
        const { patch: out, corrections } = W._rewriteHunkCounts(patch);
        expect(out).toContain('@@ -1,2 +1,2 @@');
        expect(out).toContain('@@ -10,3 +10,3 @@');
        expect(corrections).toHaveLength(1);
    });

    it('does not count \\ No newline lines', () => {
        const patch = `--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new`;
        const { patch: out } = W._rewriteHunkCounts(patch);
        // old: 1 removed; new: 1 added; backslash line not counted
        expect(out).toContain('@@ -1,1 +1,1 @@');
    });

    it('preserves the @@ tail comment', () => {
        const patch = `--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@ function foo()`;
        const { patch: out } = W._rewriteHunkCounts(patch);
        expect(out).toContain('@@ function foo()');
    });
});
