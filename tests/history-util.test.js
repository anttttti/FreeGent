// Tests for the shared history-walk helpers in history-util.ts.
import { describe, it, expect, beforeEach } from 'vitest';

// history-util.ts reads openaiHistory and lastProvider from state.ts via live bindings.
// setup.js has already loaded state.ts (via workers.ts) before this file runs, so the
// module-cache entries are real — vi.mock can't replace cached bindings at test time.
// Use the window-bridged setters instead: they update the module-level variables directly
// and the live bindings inside history-util.ts pick up the change immediately.
const W = window;

const { activeHistory, msgText, stripInjected, isRealUserMessage, lastExchange } =
    await import('../history-util.ts');

beforeEach(() => {
    W.setOpenaiHistory([]);
    W.setLastProvider(undefined);
});

// ── activeHistory ─────────────────────────────────────────────────────────────

describe('activeHistory', () => {
    it('returns openaiHistory as hist', () => {
        W.setOpenaiHistory([{ role: 'user', content: 'hi' }]);
        const { hist } = activeHistory();
        // Use toEqual (value equality) — the hist reference is the module-level
        // openaiHistory binding, not the array we passed to setOpenaiHistory.
        expect(hist).toEqual([{ role: 'user', content: 'hi' }]);
    });
});

// ── isRealUserMessage ─────────────────────────────────────────────────────────

describe('isRealUserMessage', () => {
    it('accepts a plain OAI user turn', () => {
        expect(isRealUserMessage({ role: 'user', content: 'do X' })).toBe(true);
    });
    it('rejects a <nudge> framework nudge', () => {
        expect(isRealUserMessage({ role: 'user', content: '<nudge>continue</nudge>' })).toBe(false);
    });
    it('rejects a message without string content (e.g. tool-result, image array)', () => {
        expect(isRealUserMessage({ role: 'user', content: [{ type: 'image_url' }] })).toBe(false);
    });
    it('rejects a <tool_response> fn-tag tool-result injected as role:user', () => {
        expect(isRealUserMessage({ role: 'user', content: '<tool_response>\n<tool_name>web_search</tool_name>\n<result>{}</result>\n</tool_response>' })).toBe(false);
    });
    it('rejects non-user roles', () => {
        expect(isRealUserMessage({ role: 'assistant', content: 'x' })).toBe(false);
    });
});

// ── stripInjected ─────────────────────────────────────────────────────────────

describe('stripInjected', () => {
    it('removes a leading guidance block but keeps the request', () => {
        const s = '<active_guidance>\nrules here\n</active_guidance>\nadd variety to the map';
        expect(stripInjected(s)).toBe('add variety to the map');
    });
    it('removes a relevant_memory block', () => {
        expect(stripInjected('<relevant_memory>m</relevant_memory>\nhello')).toBe('hello');
    });
});

// ── lastExchange ──────────────────────────────────────────────────────────────

describe('lastExchange', () => {
    it('pulls the last assistant response and preceding real user message (OAI)', () => {
        W.setLastProvider('mistral');
        W.setOpenaiHistory([
            { role: 'user', content: 'first request' },
            { role: 'assistant', content: 'first answer' },
            { role: 'user', content: 'second request' },
            { role: 'assistant', content: 'second answer' },
        ]);
        expect(lastExchange()).toEqual({ userMsg: 'second request', response: 'second answer' });
    });

    it('skips <nudge> nudges and strips injected blocks from the user message', () => {
        W.setLastProvider('mistral');
        W.setOpenaiHistory([
            { role: 'user', content: '<active_guidance>g</active_guidance>\nthe real request' },
            { role: 'assistant', content: 'partial' },
            { role: 'user', content: '<nudge>continue</nudge>' },
            { role: 'assistant', content: 'the answer' },
        ]);
        expect(lastExchange()).toEqual({ userMsg: 'the real request', response: 'the answer' });
    });

    it('returns empties on an empty history', () => {
        W.setLastProvider('mistral');
        W.setOpenaiHistory([]);
        expect(lastExchange()).toEqual({ userMsg: '', response: '' });
    });
});
