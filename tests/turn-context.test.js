// Tests for turn-context.js — the per-turn evaluation shared by agentSend (interactive)
// and runAgentTurn (headless: benchmarks, TUI, agent-loop).
//
// Regression origin: this logic used to live inline in agentSend, which is the DOM send
// path. Headless runs call runAgentTurn directly, so currentTurnSkills stayed empty for
// entire benchmark runs — disabling the turn-start half of the trigger table.
// These tests assert the evaluation is reachable without a DOM.
import { describe, it, expect, beforeEach } from 'vitest';

const W = window;

beforeEach(() => {
    W.skillsRegistry.clear();
    W.activeSkills.clear();
    W.setMainAgentRole(null);
    W.setCurrentTurnSkills(new Set());
});

const skill = (over = {}) => ({
    name: 'x', description: '', body: 'body', type: 'skill',
    trigger: '', trigger_on_filetype: '', trigger_on_event: '', trigger_on_media: '',
    trigger_on_file_present: '', trigger_on_message_pattern: '', trigger_on_history_tool: '',
    trigger_on_turn: '', requires: '', requires_tools: '', roles: '', exclude_roles: '',
    ...over,
});

describe('buildWorkspaceIndex', () => {
    it('indexes basenames, single extensions, and compound extensions', () => {
        const { wsExts, wsNames, wsAllPaths } = W.buildWorkspaceIndex([
            'src/app.test.js', 'Makefile', 'pkg/setup.py',
        ]);
        expect(wsNames.has('makefile')).toBe(true);
        expect(wsExts.has('.js')).toBe(true);
        expect(wsExts.has('.test.js')).toBe(true);
        expect(wsExts.has('.py')).toBe(true);
        expect(wsAllPaths.has('src/app.test.js')).toBe(true);
    });
    it('lowercases paths so triggers match case-insensitively', () => {
        const { wsNames } = W.buildWorkspaceIndex(['SRC/README.MD']);
        expect(wsNames.has('readme.md')).toBe(true);
    });
    it('ignores empty and nullish entries', () => {
        const { wsAllPaths } = W.buildWorkspaceIndex(['', null, undefined, 'a.js']);
        expect(wsAllPaths.size).toBe(1);
    });
});

describe('applyTurnTriggers — turn-start triggers without a DOM', () => {
    it('fires trigger_on_filetype from supplied workspace paths', () => {
        W.skillsRegistry.set('python', skill({ name: 'python', trigger_on_filetype: '.py' }));
        W.applyTurnTriggers({ rawText: 'fix the bug', history: [], wsPaths: ['pkg/setup.py'] });
        expect(W.currentTurnSkills.has('python')).toBe(true);
    });

    it('fires trigger_on_file_present from supplied workspace paths', () => {
        W.skillsRegistry.set('verify', skill({ name: 'verify', trigger_on_file_present: 'tests/' }));
        // rawText must be > 25 chars at turn 0; shorter messages are guarded against
        // accidental trigger_on_file_present fires (e.g. 'ok' after a tool output).
        W.applyTurnTriggers({ rawText: 'Please fix the bug in this repository file', history: [], wsPaths: ['tests/test_x.py'] });
        expect(W.currentTurnSkills.has('verify')).toBe(true);
    });

    it('fires trigger_on_history_tool from the supplied history', () => {
        W.skillsRegistry.set('nav', skill({ name: 'nav', trigger_on_history_tool: 'read_file' }));
        const history = [{ role: 'assistant', tool_calls: [{ function: { name: 'read_file' } }] }];
        W.applyTurnTriggers({ rawText: 'continue', history, wsPaths: [] });
        expect(W.currentTurnSkills.has('nav')).toBe(true);
    });

    it('fires trigger_on_event session-start only on an empty history', () => {
        W.skillsRegistry.set('intro', skill({ name: 'intro', trigger_on_event: 'session-start' }));
        W.applyTurnTriggers({ rawText: 'hi', history: [], wsPaths: [] });
        expect(W.currentTurnSkills.has('intro')).toBe(true);

        W.applyTurnTriggers({ rawText: 'hi', history: [{ role: 'user', content: 'hi' }], wsPaths: [] });
        expect(W.currentTurnSkills.has('intro')).toBe(false);
    });
});


describe('_isCompletionRequest', () => {
    it('detects explicit task references', () => {
        expect(W._isCompletionRequest('work on tasks/038-foo.md')).toBe(true);
        expect(W._isCompletionRequest('complete the next task')).toBe(true);
    });
    it('does not fire on unrelated prose', () => {
        expect(W._isCompletionRequest('what does this function do?')).toBe(false);
    });
});

describe('buildTurnPrelude', () => {
    it('returns guidance for triggered (non-always-on) skills', async () => {
        W.skillsRegistry.set('python', skill({ name: 'python', trigger_on_filetype: '.py' }));
        W.applyTurnTriggers({ rawText: 'fix it', history: [], wsPaths: ['a.py'] });
        const out = await W.buildTurnPrelude({ text: 'fix it', isFirstTurn: true });
        expect(out).toContain('~~~guidance');
        expect(out).toContain('python');
    });

    it('returns an empty string when nothing fired', async () => {
        W.applyTurnTriggers({ rawText: 'fix it', history: [], wsPaths: [] });
        const out = await W.buildTurnPrelude({ text: 'fix it', isFirstTurn: false });
        expect(out).toBe('');
    });

    it('omits always-on skills — those live in the system prompt', async () => {
        W.skillsRegistry.set('memory', skill({ name: 'memory', trigger_on_filetype: '.py' }));
        W.activeSkills.add('memory');
        W.applyTurnTriggers({ rawText: 'fix it', history: [], wsPaths: ['a.py'] });
        const out = await W.buildTurnPrelude({ text: 'fix it', isFirstTurn: true });
        expect(out).toBe('');
    });
});
