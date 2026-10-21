import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Enter that confirms an IME composition (isComposing, or keyCode 229 on older engines) must not save, submit or choose.
// Campaign 8 case002-004: the saved-message editor saved and re-ran the conversation on the confirming Enter.
const GUARDED: Array<[string, RegExp]> = [
    ['agent-core.ts', /e\.key === 'Enter' && !e\.shiftKey && !e\.isComposing && e\.keyCode !== 229\) \{ e\.preventDefault\(\); doSave/],
    ['chat-state.ts', /e\.key === 'Enter' && !e\.isComposing && e\.keyCode !== 229\) \{ e\.preventDefault\(\); commit/],
    ['init.ts', /e\.key === 'Enter' && _msgSearchIdx >= 0 && !e\.isComposing/],
    ['settings-ui.ts', /event\.key === 'Enter' && cur >= 0 && !event\.isComposing/],
    ['skills.ts', /e\.key === 'Enter' && selectedIdx >= 0 && !e\.isComposing/],
];
describe('IME composition Enter', () => {
    for (const [f, re] of GUARDED) it(`${f} ignores Enter during composition`, () => expect(readFileSync(f, 'utf8')).toMatch(re));
    it('inline index.html Enter handlers are guarded', () => {
        const html = readFileSync('index.html', 'utf8');
        for (const m of html.matchAll(/onkeydown="if\(event\.key==='Enter'([^"]*)"/g)) expect(m[1]).toContain('isComposing');
    });
});

describe('Escape ownership (campaign 8 cases 163/164/177/181)', () => {
    it('the dialog stack includes the workspace picker', () => {
        expect(readFileSync('init.ts', 'utf8')).toMatch(/querySelectorAll<HTMLElement>\('\.fg-modal-overlay, \.ws-pick-overlay'\)/);
    });
    it('an open model list or attach menu takes Escape before the stop-reply action', () => {
        const src = readFileSync('init.ts', 'utf8');
        expect(src.indexOf("picker-open')) {")).toBeGreaterThan(0);
        expect(src.indexOf("picker-open')) {")).toBeLessThan(src.indexOf('if (agentStreaming) { stopNow?.(); return; }'));
    });
});
