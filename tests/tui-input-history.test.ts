// TUI composer: ↑/↓ recall the open chat's earlier messages, with n/total in the header while browsing.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userMessages, record, step, position, type Browse } from '../tui-input-history.ts';

describe('what the list holds', () => {
    it('is the user messages of a chat, oldest first, without what the harness injected', () => {
        const h = [
            { role: 'user', content: '<workspace_files>\n1 file:\nA.md\n</workspace_files>\nfirst question' },
            { role: 'assistant', content: 'answer' },
            { role: 'tool', content: 'result' },
            { role: 'user', content: [{ type: 'text', text: 'second' }, { type: 'image_url', image_url: { url: 'x' } }] },
            { role: 'user', content: '<nudge>keep going</nudge>' },
            { role: 'user', content: '   ' },
            { role: 'user', content: 'second' },                   // a repeat of the last one
            { role: 'user', content: 'third' },
        ];
        expect(userMessages(h)).toEqual(['first question', 'second', 'third']);
        expect(userMessages(null)).toEqual([]);
    });
    it('a submitted line is added once, not twice in a row, and empty ones not at all', () => {
        const l = ['a'];
        record(l, 'b'); record(l, 'b'); record(l, '  '); record(l, '/goal fix it');
        expect(l).toEqual(['a', 'b', '/goal fix it']);
    });
});

describe('↑ and ↓', () => {
    const E = ['one', 'two', 'three'];
    const up = (b: Browse | null, cur = '') => step(b, 'older', E, cur);
    const down = (b: Browse | null, cur = '') => step(b, 'newer', E, cur);

    it('↑ starts at the newest message and keeps the text being typed as the draft', () => {
        const r = up(null, 'half-typed')!;
        expect(r.text).toBe('three');
        expect(r.browse).toEqual({ index: 2, draft: 'half-typed' });
        expect(position(r.browse, E.length)).toBe('3/3');
    });
    it('goes back to the oldest and stays there', () => {
        let r = up(null)!; r = up(r.browse)!; r = up(r.browse)!;
        expect([r.text, position(r.browse, 3)]).toEqual(['one', '1/3']);
        r = up(r.browse)!;
        expect([r.text, position(r.browse, 3)]).toEqual(['one', '1/3']);
    });
    it('↓ goes forward, and past the newest gives the draft back and ends the browsing', () => {
        let r = up(null, 'draft')!; r = up(r.browse)!;             // two
        expect(r.text).toBe('two');
        r = down(r.browse)!;
        expect([r.text, position(r.browse, 3)]).toEqual(['three', '3/3']);
        r = down(r.browse)!;
        expect(r.text).toBe('draft');
        expect(r.browse).toBeNull();
        expect(position(r.browse, 3)).toBe('');
    });
    it('does nothing when there is nothing to recall, and ↓ does nothing when not browsing', () => {
        expect(step(null, 'older', [], 'x')).toBeNull();
        expect(down(null)).toBeNull();
    });
    it('survives the list changing under it (a message sent while browsing)', () => {
        const r = step({ index: 5, draft: '' }, 'older', E, '')!;               // index beyond the end
        expect(r.text).toBe('two');
        expect(step({ index: 0, draft: 'd' }, 'newer', [], 'x')).toEqual({ browse: null, text: 'd' });
    });
});

describe('wired into the TUI', () => {
    const src = (f: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', f), 'utf8');
    const app = src('tui-app.tsx');
    it('the composer handles the arrows with a header, the app scrolls the log with PgUp/PgDn and only uses the arrows for a panel without a list', () => {
        expect(app).toMatch(/InputHistory\.step\(browseRef\.current, key\.upArrow \? 'older' : 'newer'/);
        expect(app).toMatch(/message \$\{InputHistory\.position\(browse, _historyList\(\)\.length\)\}/);
        expect(app).toMatch(/if \(\(key\.upArrow \|\| key\.downArrow\) && !Store\.getState\(\)\.activePanel\)/);
        expect(app).toMatch(/if \(key\.pageUp\)\s+Store\.scroll\(Math\.max\(1, logH - 2\)\)/);
        expect(app).toMatch(/if \(state\.activePanel\) \{\s+if \(key\.upArrow\)\s+Store\.scroll\(1\)/);
    });
    it('every submitted line is recorded, and a user edit ends the browsing', () => {
        expect(app).toMatch(/InputHistory\.record\(_historyList\(\), t\)/);
        expect(app).toMatch(/if \(browseRef\.current\) setBrowsing\(null\)/);
    });
});

describe('/resume and --resume choose from a list', () => {
    const src = (f: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', f), 'utf8');
    const app = src('tui-app.tsx'), main = src('fg-tui.tsx');
    it('/resume opens the session list; /resume N still picks by number; Enter on an empty composer opens the highlighted session', () => {
        expect(app).toMatch(/Store\.setActivePanel\('resume'\)/);
        expect(app).toMatch(/name === 'resume'\s+\? <ResumePanel/);
        expect(app).toMatch(/_panelItems\.kind === 'resume'\) void resumeChosen\(item\)/);
        expect(app).toMatch(/idx = parseInt\(arg, 10\) - 1/);
    });
    it('bare --resume opens the list instead of continuing the newest session; --resume <id> and a launch without the flag are unchanged', () => {
        expect(main).toMatch(/else if \(_resumeIdx >= 0\) \{\s+Store\.setActivePanel\('resume'\)/);
        expect(main).toMatch(/if \(_resumeId\) showRestoredConversation\(\)/);
    });
});
