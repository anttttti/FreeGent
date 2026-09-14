import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('emitNudge — framework nudge emitter', () => {
    beforeEach(() => {
        window.openaiHistory = [];
        window.convoLogTurn = vi.fn();
        window.getShowNudges = () => true;
        document.body.innerHTML = '<div id="agent-messages"></div>';
        delete window._noteRendered;
    });

    // ── String input ──

    it('pushes a string as a user-role <nudge> entry to openaiHistory', () => {
        window.emitNudge('test_nudge', 'hello world');
        expect(window.openaiHistory).toHaveLength(1);
        expect(window.openaiHistory[0]).toEqual({ role: 'user', content: '<nudge>hello world</nudge>' });
    });

    it('logs the nudge via convoLogTurn', () => {
        window.emitNudge('test_nudge', 'hello world');
        expect(window.convoLogTurn).toHaveBeenCalledTimes(1);
        const call = window.convoLogTurn.mock.calls[0][0];
        expect(call.type).toBe('nudge');
        expect(call.name).toBe('test_nudge');
        expect(call.text).toBe('hello world');
        expect(call.role).toBe('user');
    });

    it('renders a user-role nudge in the DOM', () => {
        window.emitNudge('test_nudge', 'hello world');
        const el = document.querySelector('.agent-msg-nudge');
        expect(el).toBeTruthy();
        expect(el.textContent).toBe('(nudge) hello world');
        expect(el.dataset.nudgeName).toBe('test_nudge');
    });

    // ── Entry object input ──

    it('pushes an entry object as-is to openaiHistory', () => {
        window.emitNudge('obj_nudge', { role: 'system', content: 'sys msg' });
        expect(window.openaiHistory).toHaveLength(1);
        expect(window.openaiHistory[0]).toEqual({ role: 'system', content: 'sys msg' });
    });

    it('renders a user-role entry object in the DOM', () => {
        window.emitNudge('obj_nudge', { role: 'user', content: '<nudge>wrapped</nudge>' });
        const el = document.querySelector('.agent-msg-nudge');
        expect(el.textContent).toBe('(nudge) wrapped');
    });

    it('does not render a system-role entry object in the DOM', () => {
        window.emitNudge('sys_nudge', { role: 'system', content: 'sys msg' });
        expect(document.querySelector('.agent-msg-nudge')).toBeNull();
    });

    // ── Role override ──

    it('overrides the auto-detected role via opts.role for string input', () => {
        window.emitNudge('overridden', 'bare text', { role: 'system' });
        expect(window.openaiHistory[0]).toEqual({ role: 'system', content: 'bare text' });
    });

    // ── History target ──

    it('pushes to a custom history array via opts.history', () => {
        const local = [];
        window.emitNudge('custom_hist', 'msg', { history: local });
        expect(local).toHaveLength(1);
        expect(local[0].content).toContain('<nudge>');
        expect(window.openaiHistory).toHaveLength(0);
    });

    // ── Suppress flags ──

    it('suppresses history push with suppressHistory', () => {
        window.emitNudge('sup_hist', 'msg', { suppressHistory: true });
        expect(window.openaiHistory).toHaveLength(0);
    });

    it('suppresses logging with suppressLog', () => {
        window.emitNudge('sup_log', 'msg', { suppressLog: true });
        expect(window.convoLogTurn).not.toHaveBeenCalled();
    });

    it('suppresses DOM render with suppressRender', () => {
        window.emitNudge('sup_render', 'msg', { suppressRender: true });
        expect(document.querySelector('.agent-msg-nudge')).toBeNull();
    });

    // ── appendPartTo (Gemini format) ──

    it('appends a {text} part to the given array via appendPartTo', () => {
        const parts = [];
        window.emitNudge('gemini_part', 'raw text', { appendPartTo: parts });
        expect(parts).toHaveLength(1);
        expect(parts[0]).toEqual({ text: 'raw text' });
    });

    it('strips <nudge> tags from entry content when using appendPartTo', () => {
        const parts = [];
        window.emitNudge('gemini_wrapped', { role: 'user', content: '<nudge>wrapped</nudge>' }, { appendPartTo: parts });
        expect(parts).toHaveLength(1);
        expect(parts[0]).toEqual({ text: 'wrapped' });
    });

    it('does not push to history when appendPartTo is set', () => {
        window.emitNudge('gemini_no_hist', 'raw', { appendPartTo: [] });
        expect(window.openaiHistory).toHaveLength(0);
    });

    it('still logs when appendPartTo is set and suppressLog is not', () => {
        window.emitNudge('gemini_log', 'raw', { appendPartTo: [] });
        expect(window.convoLogTurn).toHaveBeenCalled();
    });

    it('still renders when appendPartTo is set and suppressRender is not', () => {
        window.emitNudge('gemini_render', 'raw text', { appendPartTo: [] });
        const el = document.querySelector('.agent-msg-nudge');
        expect(el).toBeTruthy();
        expect(el.textContent).toBe('(nudge) raw text');
    });

    // ── DOM dedup ──

    it('does not render a second nudge with the same name', () => {
        window.emitNudge('dedup', 'first');
        window.emitNudge('dedup', 'second');
        const notes = document.querySelectorAll('.agent-msg-nudge');
        expect(notes).toHaveLength(1);
        expect(notes[0].textContent).toBe('(nudge) first');
    });

    it('renders nudges with different names independently', () => {
        window.emitNudge('alpha', 'msg a');
        window.emitNudge('beta', 'msg b');
        const notes = document.querySelectorAll('.agent-msg-nudge');
        expect(notes).toHaveLength(2);
    });

    // ── Config gate ──

    it('skips DOM render when getShowNudges returns false', () => {
        window.getShowNudges = () => false;
        window.emitNudge('gated', 'msg');
        expect(document.querySelector('.agent-msg-nudge')).toBeNull();
    });

    it('still pushes to history and logs when getShowNudges returns false', () => {
        window.getShowNudges = () => false;
        window.emitNudge('gated', 'msg');
        expect(window.openaiHistory).toHaveLength(1);
        expect(window.convoLogTurn).toHaveBeenCalled();
    });

    it('renders when getShowNudges is not a function (headless compat)', () => {
        window.getShowNudges = undefined;
        window.emitNudge('headless', 'msg');
        expect(document.querySelector('.agent-msg-nudge')).toBeTruthy();
    });

    // ── DOM not available (headless) ──

    it('does not throw when DOM element is missing', () => {
        document.body.innerHTML = '';
        expect(() => window.emitNudge('no_dom', 'msg')).not.toThrow();
    });

    // ── convoLogTurn not available ──

    it('does not throw when convoLogTurn is missing', () => {
        const saved = window.convoLogTurn;
        delete window.convoLogTurn;
        expect(() => window.emitNudge('no_log', 'msg')).not.toThrow();
        window.convoLogTurn = saved;
    });

    // ── Step metadata ──

    it('passes step metadata to convoLogTurn', () => {
        window.emitNudge('stepped', 'msg', { step: 'worker:test:3' });
        expect(window.convoLogTurn.mock.calls[0][0].step).toBe('worker:test:3');
    });

    // ── Injected-guidance wrapper tags (bug: raw <active_guidance> leaking into the DOM) ──

    it('strips <active_guidance> wrapper tags from the rendered bubble but keeps the content', () => {
        window.emitNudge('reactive_guidance', '<active_guidance>\nRe-read the file first.\n</active_guidance>');
        const el = document.querySelector('.agent-msg-nudge .agent-msg-bubble-nudge');
        expect(el.textContent).toBe('(nudge) Re-read the file first.');
        expect(el.textContent).not.toContain('<active_guidance>');
        expect(el.textContent).not.toContain('</active_guidance>');
    });

    it('strips <handover_context> and <relevant_memory> wrapper tags from the rendered bubble', () => {
        window.emitNudge('n1', '<handover_context>prior state</handover_context>');
        window.emitNudge('n2', '<relevant_memory>past note</relevant_memory>');
        const bubbles = [...document.querySelectorAll('.agent-msg-bubble-nudge')].map(b => b.textContent);
        expect(bubbles).toContain('(nudge) prior state');
        expect(bubbles).toContain('(nudge) past note');
    });

    it('keeps the full <active_guidance> block (including the tags) in openaiHistory and the log — only the DOM render is cleaned', () => {
        window.emitNudge('reactive_guidance', '<active_guidance>keep me</active_guidance>');
        expect(window.openaiHistory[0].content).toBe('<nudge><active_guidance>keep me</active_guidance></nudge>');
        expect(window.convoLogTurn.mock.calls[0][0].text).toBe('<active_guidance>keep me</active_guidance>');
    });

    // ── NVIDIA provider (system role) ──

    it('defaults to the user role and requires opts.role for system (B6 contract)', () => {
        // emitNudge deliberately no longer sniffs getProvider(): after mid-turn endpoint
        // rotation the global provider is the wrong one. The main loop's _nudge closure
        // owns the decision and passes opts.role. String callers default to 'user'.
        const saved = window.getProvider;
        window.getProvider = () => 'nvidia';
        window.emitNudge('nvidia_test', 'no wrap');
        expect(window.openaiHistory[0]).toEqual({ role: 'user', content: '<nudge>no wrap</nudge>' });
        window.getProvider = saved;
    });

    it('honours an explicit system role: unwrapped content and no DOM rendering', () => {
        window.emitNudge('sys_test', 'no wrap', { role: 'system' });
        expect(window.openaiHistory.at(-1)).toEqual({ role: 'system', content: 'no wrap' });
        expect(document.querySelector('.agent-msg-nudge')).toBeNull();
    });
});
