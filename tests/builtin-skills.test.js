// builtin-skills.test.js — guards the BUILTIN_SKILLS registry against the failure mode in
// docs/dead-code-audit-2026-07-25.md §2.2: skills that shipped with no trigger of any kind
// and no slash-command dispatcher, so their bodies could never reach a model.
//
// Also covers the `search` skill promoted in that pass: it is the concrete recipe for
// delegating code location to a disposable-context worker (the run_workers design thesis),
// and it must actually fire when the main loop is grinding through files.
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';

const W = window;

// skills.ts is not in tests/setup.js, and skillsRegistry stays EMPTY until loadSkills()
// runs — without this the reachability sweep below passes vacuously over zero skills.
beforeAll(async () => {
    await import('../skills.ts');
    W.agentListFiles = async () => [];   // built-ins only; no workspace skills/ files
    await W.loadSkills();
    expect(W.skillsRegistry.size).toBeGreaterThan(10); // guard against a silent empty pass
});

const TRIGGER_FIELDS = [
    'trigger', 'trigger_on_filetype', 'trigger_on_tool', 'trigger_on_failure',
    'trigger_on_event', 'trigger_on_media', 'trigger_on_message_pattern',
    'trigger_on_history_tool', 'trigger_on_turn', 'trigger_on_repeat',
    'trigger_on_file_present', 'trigger_on_completion', 'roles',
];

beforeEach(() => { localStorage.clear(); });

describe('BUILTIN_SKILLS reachability', () => {
    it('every built-in skill declares at least one activation path', () => {
        // There is no slash-command dispatcher — skills.ts only renders '/' + name as a
        // label — so a skill with no trigger field is unreachable except by manual toggle.
        const unreachable = [];
        for (const s of W.skillsRegistry.values()) {
            if (s.path !== 'builtin') continue; // file skills are user-managed
            if (!TRIGGER_FIELDS.some(f => s[f])) unreachable.push(s.name);
        }
        expect(unreachable).toEqual([]);
    });

    it('the five superseded slash-only skills are gone', () => {
        for (const name of ['document', 'scaffold', 'translate', 'spec', 'explain'])
            expect(W.skillsRegistry.has(name)).toBe(false);
    });

    it('no surviving skill body opens with an unverifiable slash-command conditional', () => {
        // "When invoked with `/foo ...`:" as a first line is a condition the model cannot
        // check — injected on a keyword it may describe the command instead of acting.
        const bad = [];
        for (const s of W.skillsRegistry.values()) {
            if (s.path !== 'builtin') continue;
            const body = typeof s.body_fn === 'function' ? s.body_fn() : (s.body || '');
            if (/^\s*When invoked with\s+`?\//.test(body)) bad.push(s.name);
        }
        expect(bad).toEqual([]);
    });
});

describe('search skill — delegation recipe', () => {
    const search = () => W.skillsRegistry.get('search');

    beforeEach(() => {
        // The default main role is 'agent', which search excludes (it has no run_workers).
        // Benchmarks and the Director path are what this skill is for.
        W.setMainAgentRole('director');
        // reactiveSkillGuidance dedups via _reactiveFired and counts repeats via the
        // 20-entry _toolCallHistory window — both are module state that leaks across tests.
        W.setReactiveFired(new Set());
        W.setToolCallHistory([]);
    });
    afterEach(() => { W.clearMainAgentRole(); });

    it('is registered and gated to roles that actually have run_workers', () => {
        expect(search()).toBeTruthy();
        expect(search().requires_tools).toContain('run_workers');
        expect(search().exclude_roles).toContain('agent');
    });

    it('fires when the main loop has re-read files repeatedly', () => {
        const reads = Array.from({ length: 6 }, () => ({ name: 'read_file', result: { content: 'x' } }));
        const out = W.reactiveSkillGuidance(reads);
        expect(out).toContain('### search');
        expect(out).toContain('run_workers');
    });

    it('fires on repeated search_workspace calls', () => {
        const greps = Array.from({ length: 4 }, () => ({ name: 'search_workspace', result: { matches: [] } }));
        expect(W.reactiveSkillGuidance(greps)).toContain('### search');
    });

    it('does not fire on a couple of ordinary reads', () => {
        const reads = Array.from({ length: 2 }, () => ({ name: 'read_file', result: { content: 'x' } }));
        expect(W.reactiveSkillGuidance(reads)).not.toContain('### search');
    });

    it('is skipped when run_workers is disabled', () => {
        const had = W.enabledTools.has('run_workers');
        W.enabledTools.delete('run_workers');
        try {
            const reads = Array.from({ length: 6 }, () => ({ name: 'read_file', result: { content: 'x' } }));
            expect(W.reactiveSkillGuidance(reads)).not.toContain('### search');
        } finally { if (had) W.enabledTools.add('run_workers'); }
    });
});

describe('code-first — absorbed scaffold rules', () => {
    const body = () => {
        const s = W.skillsRegistry.get('code-first');
        return typeof s.body_fn === 'function' ? s.body_fn() : s.body;
    };

    it('keeps the two durable rules from the deleted scaffold skill', () => {
        expect(body()).toMatch(/read one similar existing file first/i);
        expect(body()).toMatch(/No pseudocode and no .*TODO: implement.* stubs/i);
    });
});
