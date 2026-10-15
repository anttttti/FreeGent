import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const src = (f: string) => readFileSync(`${process.cwd()}/${f}`, 'utf8');

describe('browser-tour fixes', () => {
    it('CodeMirror basic-setup is pinned to a published version', () => {
        expect(src('editor.ts')).toContain('basic-setup@0.20.0');
        expect(src('editor.ts')).not.toContain('basic-setup@0.7');
    });
    it('tab selectors escape quotes and backslashes in file names', () => {
        const s = src('tabs.ts');
        expect(s).toContain('_attrEsc(key)');
        expect(s).not.toMatch(/\[data-panel="\$\{key\}"\]/);
    });
    it('the user message is persisted before the turn runs', () => {
        const s = src('agent-core.ts');
        const i = s.indexOf("_evtSess.append('user/message'");
        expect(s.slice(i, i + 500)).toContain('saveHistory()');
    });
    it('the click that focuses the input does not accept the ghost suggestion', () => {
        expect(src('init.ts')).toContain('_wasFocusedOnDown');
    });
});

describe('browser-tour fixes, low-severity round', () => {
    it('the stop/send button keeps its aria-label in step with its state', () => {
        expect(src('agent-core.ts')).toContain("'aria-label', enabled ? 'Send message' : 'Stop now'");
    });
    it('an HTML error body is reduced to its text', async () => {
        const { _httpErrorFromResponse } = await import('../retry.ts');
        const resp = new Response('<html><head><style>x{}</style></head><body><h1>502 Bad Gateway</h1><p>nginx</p></body></html>', { status: 502 });
        const e: any = await _httpErrorFromResponse(resp);
        expect(e.message).toBe('HTTP 502: 502 Bad Gateway nginx');
    });
    it('task slugs keep the base letters of accented titles', () => {
        const slug = (t: string) => t.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'task';
        expect(slug('Ünïcödé 日本語 🎉')).toBe('unicode');
        expect(src('tasks.ts')).toContain("title.normalize('NFKD')");
    });
});

describe('cross-tab chat history', () => {
    it('the interactive send persists the message right after it enters history', () => {
        const s = src('agent-core.ts');
        const i = s.indexOf('_pushHistoryMessage(provider, _mediaGeminiModel');
        expect(s.slice(i, i + 400)).toContain('saveHistory()');
    });
    it('a send and New Chat take the other tab\'s messages instead of overwriting them', () => {
        const a = src('agent-core.ts'), c = src('chat-state.ts');
        expect(a).toContain('reloadChatIfChangedElsewhere()');
        expect(a).toContain('chatChangedElsewhere()');
        expect(c).toContain('if (!force) saveHistory();');
        expect(c).toContain("window.addEventListener('storage'");
    });
});

describe('empty reply and sandbox hint', () => {
    it('interactive turns that end with no text show a note instead of an empty bubble', () => {
        const s = src('agent-core.ts');
        expect(s).toContain('_EMPTY_REPLY_NOTE');
        expect(s.match(/placeholder\.finalize\(_uiFinalText\(finalText\)\)/g)?.length).toBe(4);
    });
    it('the JS sandbox hint no longer says there is no network access', () => {
        const h = src('index.html');
        expect(h).not.toContain('no network access');
        expect(h).toContain('reaches public URLs');
    });
});

describe('empty-reply retry burst', () => {
    it('consecutive empty/cut replies back off and stop after a few', () => {
        const s = src('llm-loops.ts');
        expect(s).toContain('const _MAX_EMPTY_STREAK = 5');
        expect(s).toContain('_emptyStreak >= _MAX_EMPTY_STREAK');
        expect(s).toContain('_cutOffStreak = 0; _emptyStreak = 0;');
    });
});
