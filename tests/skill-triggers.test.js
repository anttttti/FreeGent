// Tests for the table-driven skill-trigger evaluator (evaluateSkillTriggers) and the shared
// role-exclusion predicate (_skillExcludedForRole) — both in skill-guidance.js (eval'd in setup.js).
// This is the hot path that decides which skills fire each turn; previously untestable inside agentSend.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const W = window;

// Minimal inputs object; tests override the relevant fields.
const baseInputs = (over = {}) => ({
    roleName: null, lowerText: '', rawText: '',
    firstMsg: false, isTaskCompletion: false, turn: 5,
    wsExts: new Set(), wsNames: new Set(), wsAllPaths: new Set(),
    msgMedia: new Set(), histTools: new Set(),
    ...over,
});
const reg = (...skills) => new Map(skills.map(s => [s.name, s]));

beforeEach(() => { localStorage.clear(); });

describe('_skillExcludedForRole', () => {
    it('excludes when the active role is in the skill exclude_roles list', () => {
        expect(W._skillExcludedForRole({ exclude_roles: 'agent, director' }, 'director')).toBe(true);
    });
    it('does not exclude a different role', () => {
        expect(W._skillExcludedForRole({ exclude_roles: 'agent' }, 'director')).toBe(false);
    });
    it('never excludes when roleName is null', () => {
        expect(W._skillExcludedForRole({ exclude_roles: 'agent' }, null)).toBe(false);
    });
    it('never excludes when the skill has no exclude_roles', () => {
        expect(W._skillExcludedForRole({}, 'agent')).toBe(false);
    });
});

describe('evaluateSkillTriggers — seed + per-type matching', () => {
    it('always includes the seed (always-on skills)', () => {
        const out = W.evaluateSkillTriggers(reg(), new Set(['memory']), baseInputs());
        expect(out.has('memory')).toBe(true);
    });

    it('keyword trigger fires on a whole-word match in the lowercased message', () => {
        const out = W.evaluateSkillTriggers(reg({ name: 'debug', trigger: 'error, bug' }), new Set(),
            baseInputs({ lowerText: 'i hit a bug here' }));
        expect(out.has('debug')).toBe(true);
    });

    it('filetype trigger fires on a message mention and on workspace presence', () => {
        const r = reg({ name: 'py', trigger_on_filetype: '.py' });
        expect(W.evaluateSkillTriggers(r, new Set(), baseInputs({ lowerText: 'open main.py' })).has('py')).toBe(true);
        expect(W.evaluateSkillTriggers(r, new Set(), baseInputs({ wsExts: new Set(['.py']) })).has('py')).toBe(true);
    });

    it('filetype :msg suffix matches the message only, not workspace presence', () => {
        const r = reg({ name: 'js', trigger_on_filetype: '.js:msg' });
        expect(W.evaluateSkillTriggers(r, new Set(), baseInputs({ wsExts: new Set(['.js']) })).has('js')).toBe(false);
        expect(W.evaluateSkillTriggers(r, new Set(), baseInputs({ lowerText: 'edit app.js' })).has('js')).toBe(true);
    });

    it('event trigger fires on session-start and task-start', () => {
        const r = reg({ name: 'recall', trigger_on_event: 'session-start' });
        expect(W.evaluateSkillTriggers(r, new Set(), baseInputs({ firstMsg: true })).has('recall')).toBe(true);
        expect(W.evaluateSkillTriggers(r, new Set(), baseInputs({ firstMsg: false })).has('recall')).toBe(false);
        const t = reg({ name: 'plan', trigger_on_event: 'task-start' });
        expect(W.evaluateSkillTriggers(t, new Set(), baseInputs({ isTaskCompletion: true })).has('plan')).toBe(true);
    });

    it('media trigger fires on a matching attachment type', () => {
        const r = reg({ name: 'img', trigger_on_media: 'image' });
        expect(W.evaluateSkillTriggers(r, new Set(), baseInputs({ msgMedia: new Set(['image']) })).has('img')).toBe(true);
        expect(W.evaluateSkillTriggers(r, new Set(), baseInputs({ msgMedia: new Set(['audio']) })).has('img')).toBe(false);
    });

    it('file-present trigger fires on an exact path or a prefix', () => {
        const r = reg({ name: 'ledger', trigger_on_file_present: 'tasks/' });
        expect(W.evaluateSkillTriggers(r, new Set(), baseInputs({ wsAllPaths: new Set(['tasks/ledger.md']) })).has('ledger')).toBe(true);
    });

    it('message-pattern trigger fires on a regex match and tolerates a bad regex', () => {
        const good = reg({ name: 'trace', trigger_on_message_pattern: 'Traceback|Error:' });
        expect(W.evaluateSkillTriggers(good, new Set(), baseInputs({ rawText: 'TypeError: x' })).has('trace')).toBe(true);
        const bad = reg({ name: 'oops', trigger_on_message_pattern: '(' }); // invalid regex
        expect(() => W.evaluateSkillTriggers(bad, new Set(), baseInputs({ rawText: 'anything' }))).not.toThrow();
    });

    it('history-tool trigger fires when a tool name appeared in history', () => {
        const r = reg({ name: 'wk', trigger_on_history_tool: 'run_workers' });
        expect(W.evaluateSkillTriggers(r, new Set(), baseInputs({ histTools: new Set(['run_workers']) })).has('wk')).toBe(true);
    });

    it('turn trigger fires on "first" and on a specific number', () => {
        const first = reg({ name: 'f', trigger_on_turn: 'first' });
        expect(W.evaluateSkillTriggers(first, new Set(), baseInputs({ turn: 0 })).has('f')).toBe(true);
        expect(W.evaluateSkillTriggers(first, new Set(), baseInputs({ turn: 3 })).has('f')).toBe(false);
        const n = reg({ name: 'n3', trigger_on_turn: '3' });
        expect(W.evaluateSkillTriggers(n, new Set(), baseInputs({ turn: 3 })).has('n3')).toBe(true);
    });
});

describe('evaluateSkillTriggers — guards', () => {
    it('excludes a skill for the active role', () => {
        const r = reg({ name: 'codefirst', trigger: 'read', exclude_roles: 'director' });
        const out = W.evaluateSkillTriggers(r, new Set(), baseInputs({ lowerText: 'read the file', roleName: 'director' }));
        expect(out.has('codefirst')).toBe(false);
    });

    it('does not fire a non-matching skill', () => {
        const r = reg({ name: 'x', trigger: 'zzz' });
        expect(W.evaluateSkillTriggers(r, new Set(), baseInputs({ lowerText: 'hello' })).has('x')).toBe(false);
    });
});

describe('completionGateGuidance', () => {
    // Save and restore the globals mutated by these tests.
    let savedRegistry, savedCurrentTurnSkills, savedReactiveFired;
    beforeEach(() => {
        savedRegistry        = new Map(skillsRegistry);
        savedCurrentTurnSkills = new Set(window.currentTurnSkills);
        savedReactiveFired   = new Set(window._reactiveFired);
    });
    afterEach(() => {
        skillsRegistry.clear();
        for (const [k, v] of savedRegistry) skillsRegistry.set(k, v);
        window.setCurrentTurnSkills(savedCurrentTurnSkills);
        window.setReactiveFired(savedReactiveFired);
    });

    const mkSkill = (over) => ({ name: 'verify-with-tests', body: 'run the tests', ...over });

    it('fires a triggered skill when its turn-start trigger matched (currentTurnSkills contains it)', () => {
        const s = mkSkill({ trigger_on_completion: 'triggered' });
        skillsRegistry.set(s.name, s);
        window.setCurrentTurnSkills(new Set([s.name]));
        window.setReactiveFired(new Set());
        const out = W.completionGateGuidance(false, false);
        expect(out).toContain('run the tests');
    });

    it('does NOT fire a triggered skill when its turn-start trigger did not match', () => {
        const s = mkSkill({ trigger_on_completion: 'triggered' });
        skillsRegistry.set(s.name, s);
        window.setCurrentTurnSkills(new Set());   // trigger did not fire
        window.setReactiveFired(new Set());
        const out = W.completionGateGuidance(false, false);
        expect(out).toBe('');
    });

    it('still fires at the gate even when the skill was prelude-injected (_reactiveFired contains it)', () => {
        // This is the regression: prelude injection marks the skill in _reactiveFired,
        // which previously caused fired.has(s.name) to skip it at the gate.
        const s = mkSkill({ trigger_on_completion: 'triggered' });
        skillsRegistry.set(s.name, s);
        window.setCurrentTurnSkills(new Set([s.name]));   // trigger fired → prelude-injected
        window.setReactiveFired(new Set([s.name]));       // prelude marked it as already fired
        const out = W.completionGateGuidance(false, false);
        expect(out).toContain('run the tests');
    });

    it('fires on edit condition when edits happened, not when they did not', () => {
        const s = mkSkill({ trigger_on_completion: 'edit' });
        skillsRegistry.set(s.name, s);
        window.setCurrentTurnSkills(new Set());
        window.setReactiveFired(new Set());
        expect(W.completionGateGuidance(true,  false)).toContain('run the tests');
        expect(W.completionGateGuidance(false, false)).toBe('');
    });

    it('fires on blocked condition only when blocked=true', () => {
        const s = mkSkill({ trigger_on_completion: 'blocked' });
        skillsRegistry.set(s.name, s);
        window.setCurrentTurnSkills(new Set());
        window.setReactiveFired(new Set());
        expect(W.completionGateGuidance(false, true)).toContain('run the tests');
        expect(W.completionGateGuidance(false, false)).toBe('');
    });

    it('after firing at the gate, adds the skill to _reactiveFired to prevent a later reactive re-fire', () => {
        const s = mkSkill({ trigger_on_completion: 'triggered' });
        skillsRegistry.set(s.name, s);
        window.setCurrentTurnSkills(new Set([s.name]));
        window.setReactiveFired(new Set());
        W.completionGateGuidance(false, false);
        expect(window._reactiveFired.has(s.name)).toBe(true);
    });
});
