/**
 * System prompt quality tests.
 *
 * Guards against prompt bloat and regression — checks that buildSystemPrompt()
 * stays under a reasonable size, contains required sections, and has no obvious
 * clutter left over from earlier experiments.
 */

const W = window;

// workers.ts (loaded as a real module in setup.js) sets the Director role at import time
// — tests run with whatever role is active, which is Director in production.

// ── Basic shape ───────────────────────────────────────────────────────────────

describe('buildSystemPrompt — shape', () => {
    beforeEach(() => {
        // getSandboxProvider() defaults to 'wasm', which causes _buildWorkspaceDesc() to
        // return a /workspace path without the IndexedDB description. Set 'auto' so the
        // IndexedDB-based workspace description is used and the test can find it.
        localStorage.setItem('fg_sandbox_provider', 'auto');
    });

    it('returns a non-empty string', () => {
        const p = W.buildSystemPrompt();
        expect(typeof p).toBe('string');
        expect(p.length).toBeGreaterThan(100);
    });

    it('identifies the agent as FreeGent', () => {
        expect(W.buildSystemPrompt()).toContain('FreeGent');
    });

    it('describes the workspace file system', () => {
        const p = W.buildSystemPrompt();
        expect(p).toContain('IndexedDB');
        expect(p).toContain('local/');
    });

    it('mentions web_search', () => {
        expect(W.buildSystemPrompt()).toContain('web_search');
    });
});

// ── Size / bloat guard ────────────────────────────────────────────────────────

describe('buildSystemPrompt — size', () => {
    it('is under 6 000 characters without any skills active', () => {
        localStorage.setItem('fg_active_skills', '[]');
        const len = W.buildSystemPrompt().length;
        expect(len).toBeLessThan(6_000);
    });

    it('token estimate is under 1 500 without any skills active', () => {
        localStorage.setItem('fg_active_skills', '[]');
        const tokens = Math.ceil(W.buildSystemPrompt().length / 4);
        expect(tokens).toBeLessThan(1_500);
    });
});

// ── No lingering clutter from past experiments ────────────────────────────────

describe('buildSystemPrompt — no clutter', () => {
    it('does not mention NVIDIA audio', () => {
        expect(W.buildSystemPrompt()).not.toMatch(/nvidia.*audio|audio.*nvidia/i);
    });

    it('does not hardcode model IDs that no longer exist', () => {
        const p = W.buildSystemPrompt();
        expect(p).not.toContain('gemini-1.5');
        expect(p).not.toContain('gpt-4o');  // not a FreeGent default
    });

    it('has no duplicate "## Tools" section headings', () => {
        const p = W.buildSystemPrompt();
        const matches = [...p.matchAll(/^## Tools/gm)];
        expect(matches.length).toBeLessThanOrEqual(1);
    });

    it('has no duplicate "## Working style" headings', () => {
        const p = W.buildSystemPrompt();
        const matches = [...p.matchAll(/^## Working style/gm)];
        expect(matches.length).toBeLessThanOrEqual(1);
    });
});

// ── Search provider notes ─────────────────────────────────────────────────────

describe('buildSystemPrompt — search provider notes', () => {
    afterEach(() => localStorage.removeItem('fg_search_provider'));

    it('adds Tavily note when provider is tavily', () => {
        localStorage.setItem('fg_search_provider', 'tavily');
        expect(W.buildSystemPrompt()).toContain('Tavily');
    });

    it('adds Brave note when provider is brave', () => {
        localStorage.setItem('fg_search_provider', 'brave');
        expect(W.buildSystemPrompt()).toContain('Brave');
    });

    it('adds Wikipedia-only note when provider is wikipedia', () => {
        localStorage.setItem('fg_search_provider', 'wikipedia');
        expect(W.buildSystemPrompt()).toContain('Wikipedia');
    });
});
