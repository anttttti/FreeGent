// Every step's Request pane held the whole conversation as sent, twice (live column and event log): one Autopilot task chat of
// ~45 steps reached 79 MB of text in the page (browser run 2026-10-27). Old steps now keep only the start, as in the TUI.
import { describe, it, expect } from 'vitest';
import { requestKeeper, trimKeptRequest, KEPT_REQUEST_CHARS } from '../request-trim.ts';
import { KEEP_WHOLE_STEP_PANES } from '../chat-render.ts';
const W = globalThis as any;

describe('request-trim', () => {
    it('keeps short text and cuts long text to its start with a note', () => {
        expect(trimKeptRequest('short')).toBe('short');
        const cut = trimKeptRequest('y'.repeat(50_000));
        expect(cut.startsWith('y'.repeat(KEPT_REQUEST_CHARS))).toBe(true);
        expect(cut).toContain('44,000 more characters dropped');
    });
    it('trims only what falls off the front; touching a step again makes it newest', () => {
        const trimmed: number[] = [];
        const k = requestKeeper<number>((n) => trimmed.push(n), 2);
        k.touch(1); k.touch(2); k.touch(1); k.touch(1); k.touch(3);
        expect(trimmed).toEqual([2]);
    });
});

describe('WebUI step panes', () => {
    it('only the latest steps keep their whole Request and Prompt', () => {
        W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        document.body.innerHTML = '<div id="agent-messages"></div>';
        const ph = W.createResponsePlaceholder();
        const big = 'm'.repeat(100_000);
        const n = 40;
        for (let i = 0; i < n; i++) { const t = ph.addThinkingTask({ histLen: i }); t.setPrompt(big + i); t.setRequest(big + i); }
        const panes = (name: string) => [...ph.div.querySelectorAll<HTMLElement>(`.step-content-pre[data-tab-name="${name}"]`)].map(p => p.textContent!.length);
        for (const name of ['Request', 'Prompt']) {
            const lens = panes(name);
            expect(lens.length).toBeGreaterThanOrEqual(n);   // live column and event-log entry per step
            expect(lens.filter(l => l > 100_000).length).toBeLessThanOrEqual(2 * KEEP_WHOLE_STEP_PANES);
            expect(lens.filter(l => l > 100_000).length).toBeGreaterThan(0);
            expect(lens.every(l => l > 100_000 || l < KEPT_REQUEST_CHARS + 200)).toBe(true);
        }
        expect(ph.div.textContent!.length).toBeLessThan(2 * 2 * KEEP_WHOLE_STEP_PANES * 100_010 + 4 * n * (KEPT_REQUEST_CHARS + 200));   // was 4 * n * 100 KB
    });
});
