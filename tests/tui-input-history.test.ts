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

describe('only the user\'s own turns', () => {
    const u = (content: any) => ({ role: 'user', content });
    it('leaves out nudges, the compaction summary and its notes, tool results in text mode, and the /goal loop\'s turns', () => {
        const h = [
            u('<workspace_files>\n1 file:\nA.md\n</workspace_files>\nfix the login bug'),
            u('<nudge>~~~guidance\nReactive guidance triggered by recent tool activity\n~~~</nudge>'),
            u('<nudge>You declared COMPLETED with no answer body.</nudge>'),
            u('<tool_response>{"ok":true}</tool_response>'),
            u('[SYSTEM: The conversation history above has been compacted. The following is a read-only summary]'),
            u('[SYSTEM: Continue where you left off.]'),
            u('[Files read before compaction — last-read content retained so you can verify fix state without re-reading:\n\na.ts:\nx]'),
            u('No results from "ls", results from "ls -la":\ntotal 0'),
            u('~~~guidance\nThe following capabilities and rules apply to the request below.\n~~~\n\nthen add a test'),
            { role: 'assistant', content: 'done' },
        ];
        expect(userMessages(h)).toEqual(['fix the login bug', 'then add a test']);
    });
    it('leaves out every turn the goal loop sends, and keeps a message that merely starts like one', () => {
        const END = 'When the goal is fully met, finish your reply with COMPLETED. If you cannot go on without something only the user can give (a credential, a choice, a missing fact), do not guess: finish with a line "BLOCKED: <your question, one sentence>".';
        const h = [
            u('Goal: ship the report\n\nWork toward this goal until it is met. Use your tools; check the result against the goal itself, not against your own plan. ' + END),
            u('Resuming this goal: ship the report\n\nProgress so far:\n- turn 1: outline\n\nLook at the project as it is now, then take the next concrete step. ' + END),
            u('The goal is not met yet: ship the report\n\nContinue: take the next concrete step with tools now, without restating the plan. Finish with COMPLETED only when the goal is met.'),
            u('You said the goal is complete: ship the report\n\nVerify it now against that wording: run the check, read the result, look at the files. If it is met, reply with the evidence and finish with COMPLETED. If something is missing, say what and keep working.'),
            u('Goal: I want to understand the build'),            // typed by a person
        ];
        expect(userMessages(h)).toEqual(['Goal: I want to understand the build']);
    });
    it('the task re-stated after a compaction is the user\'s first message, without its pin', () => {
        expect(userMessages([u('[TASK — do not lose track of this]\nReview the source code'), u('[SYSTEM: summary]')])).toEqual(['Review the source code']);
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
