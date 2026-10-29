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

// Autopilot exploration 2026-10-28: AE-19 (3.4 MB of storage per task, most of it whole request panes in the saved chat HTML) and AE-23
// (3.1 MB of page text in one task chat: every step's thinking and output, twice).
describe('saved chat panes and old step text', () => {
    it('trimSavedPanes keeps the start of Request and Prompt panes, never cuts an entity, and leaves other panes alone', async () => {
        const { trimSavedPanes } = await import('../request-trim.ts');
        const req = '&quot;x&quot;'.repeat(400) + 'END';
        const html = `<div><pre class="step-content-pre" data-tab-name="Request">${req}</pre><pre data-tab-name="Output">${'o'.repeat(9000)}</pre>`
            + `<pre data-tab-name="Prompt">${'p'.repeat(3000)}</pre></div>`;
        const out = trimSavedPanes(html, 1500);
        const reqOut = /data-tab-name="Request">([\s\S]*?)<\/pre>/.exec(out)![1];
        expect(reqOut).toMatch(/more characters not kept in the saved chat\]$/);
        expect(reqOut).not.toMatch(/END/);
        expect(reqOut.split('\n')[0]).toMatch(/&quot;$/);   // ends on a whole entity
        expect(out).toContain('o'.repeat(9000));
        expect(/data-tab-name="Prompt">([\s\S]*?)<\/pre>/.exec(out)![1].length).toBeLessThan(1700);
        expect(trimSavedPanes('<pre data-tab-name="Request">short</pre>')).toBe('<pre data-tab-name="Request">short</pre>');
    });
    it('trimStepText keeps the start and the end of a long step', async () => {
        const { trimStepText } = await import('../chat-render.ts');
        const t = 'a'.repeat(2000) + 'MIDDLE' + 'b'.repeat(2000);
        const cut = trimStepText(t);
        expect(cut.startsWith('a'.repeat(1500))).toBe(true);
        expect(cut.endsWith('b'.repeat(1500))).toBe(true);
        expect(cut).toMatch(/characters of an older step not kept/);
        expect(cut).not.toMatch(/MIDDLE/);
        expect(trimStepText('short')).toBe('short');
    });
});

// AE-11: a test that stubs `globalThis.location = {...}` navigated the in-browser shell's frame, and every later node hung.
describe('scripts that assign location get their own', () => {
    it('recognises an assignment, not a read or a comparison', async () => {
        const { _ASSIGNS_LOCATION_RE: re } = await import('../shiro/node-compat/execution.ts');
        for (const s of ['globalThis.location = { reload() {} }', 'window.location={}', 'location = "x"', 'self . location = 1']) expect(re.test(s)).toBe(true);
        for (const s of ['const u = location.href', 'if (window.location == x) {}', 'obj.location = 3', 'myLocation = 1', 'location === y']) expect(re.test(s)).toBe(false);
    }, 30_000);   // the shell's execution module is a large import under a full-suite load
});
