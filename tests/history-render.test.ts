// codex report 8, cases 304-310 (larger change 3): a chat rebuilt from saved history is drawn by the builders the live turn uses.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

const W: any = window;
let setChatHistory: any;
beforeAll(async () => {
    W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    await import('../chat-attachments.ts');
    await import('../settings-ui.ts');
    await import('../chat-state.ts');
    ({ setChatHistory } = await import('../chat-history.ts'));
    W.addVoiceButtons ??= () => {};
});
beforeEach(() => { document.body.innerHTML = '<div id="agent-messages"></div>'; localStorage.clear(); });

const draw = (history: any[]) => { setChatHistory(history); W.renderHistoryFallback(); return document.getElementById('agent-messages')!; };

describe('rebuilt model turn has the live reply structure', () => {
    it('the reply sits in the same response element and has its copy row', () => {
        const el = draw([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Here:\n\n```html\n<b>a</b>\n```\n' }]);
        const model = el.querySelector('.agent-msg-model')!;
        expect(model.querySelector('.agent-response-text')).toBeTruthy();
        expect(model.querySelector('.agent-turn-diff-row [data-action="copy-response"]')).toBeTruthy();
    });
    it('a terminal marker is not drawn', () => {
        const el = draw([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'Done.\n\nCOMPLETED' }]);
        expect(el.querySelector('.agent-msg-model')!.textContent).not.toMatch(/COMPLETED/);
    });
});

describe('rebuilt user turn shows attachments as chips like the live bubble', () => {
    it('a file note becomes a chip and is not repeated as text', () => {
        const el = draw([{ role: 'user', content: '[Attached file: budget.xlsx, 12 KB; original available at attachments/1-a/budget.xlsx]\n\nSum column B.' }]);
        const html = el.innerHTML;
        expect(el.querySelector('.agent-msg-user .chat-file-chip')?.textContent).toContain('budget.xlsx');
        expect(html).not.toContain('Attached file:');
        expect(html).toContain('Sum column B.');
    });
    it('a note-only message still draws its chip', () => {
        const el = draw([{ role: 'user', content: '[Attached file: a.pdf, 1 KB]' }]);
        expect(el.querySelector('.agent-msg-user .chat-file-chip')).toBeTruthy();
    });
});

describe('userBubbleHtml', () => {
    it('joins attachments and text with one break, and omits it when either is missing', () => {
        expect(W.userBubbleHtml({ thumbsHtml: '<i></i>', text: 'hello' })).toMatch(/^<i><\/i><br>/);
        expect(W.userBubbleHtml({ chipsHtml: '<b></b>', text: '  ' })).toBe('<b></b>');
        expect(W.userBubbleHtml({ text: 'hello' })).not.toContain('<br>');
    });
});

describe('live and rebuilt replies come from the same builders', () => {
    it('finalize and the rebuilt turn both call buildResponseEl and buildResponseActionRow', () => {
        const src = require('fs').readFileSync(`${process.cwd()}/chat-render.ts`, 'utf8') as string;
        const fin = src.slice(src.indexOf('const responseEl = buildResponseEl(toShow)'), src.indexOf('const responseEl = buildResponseEl(toShow)') + 400);
        expect(fin).toContain('buildResponseActionRow(responseEl)');
        const turn = src.slice(src.indexOf('export function appendModelTurn'));
        expect(turn.slice(0, 500)).toContain('buildResponseEl(text)');
        expect(turn.slice(0, 600)).toContain('buildResponseActionRow(responseEl)');
    });
});
