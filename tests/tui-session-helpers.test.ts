// Pieces behind the TUI/CLI report fixes that need no terminal: restoring the screen from a saved history, number-field validation, which
// settings are credentials, unknown roles, and reloading skills / roles / AGENTS.md after the agent writes them through a workspace adapter.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as Store from '../tui-store.ts';
import { numberFieldError, SETTINGS_DEF, keyedFields } from '../panel-defs.ts';
import { isCredentialKey } from '../profile-keys.ts';

const W = window as any;
const clean = { user: (s: string) => s.replace(/^<workspace_files>[\s\S]*?<\/workspace_files>\s*/, '').trim(), answer: (s: string) => s.replace(/\s*COMPLETED\s*$/, '') };

describe('entriesFromHistory (resume shows the conversation, cases 007, 021)', () => {
    const history = [
        { role: 'user', content: '<workspace_files>\n(empty)\n</workspace_files>\n\nFirst question' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '{"content":"x"}' },
        { role: 'assistant', content: 'First answer.\nCOMPLETED' },
        { role: 'user', content: '<nudge>do not stop</nudge>' },
        { role: 'user', content: 'Second question' },
        { role: 'assistant', content: '[The user stopped this request before it was answered. Do not carry it out unless they ask for it again.]' },
    ];
    it('one user entry per user message and one answer per exchange; harness lines are left out', () => {
        const e = Store.entriesFromHistory(history, clean);
        expect(e.map(x => x.type)).toEqual(['user', 'turn', 'user']);
        expect((e[0] as any).text).toBe('First question');
        expect((e[1] as any).turn.finalText).toBe('First answer.');
        expect((e[1] as any).turn.done).toBe(true);
        expect((e[2] as any).text).toBe('Second question');
    });
    it('an empty history is an empty screen', () => expect(Store.entriesFromHistory([], clean)).toEqual([]));
    it('local notices are marked and replaceEntries swaps the screen', () => {
        Store.replaceEntries([]);
        Store.addNotice('Resumed');
        const t = Store.getState().entries[0] as any;
        expect(t.turn.local).toBe(true);
        Store.replaceEntries(Store.entriesFromHistory(history, clean));
        expect(Store.getState().entries).toHaveLength(3);
    });
});

describe('numberFieldError (/set and the panels share it, case 036)', () => {
    const temp = keyedFields(SETTINGS_DEF).find(f => f.key === 'fg_temperature') as any;
    it('refuses out-of-range and non-numbers, accepts the range', () => {
        expect(numberFieldError(temp, '3.5')).toMatch(/at most 2/);
        expect(numberFieldError(temp, '-1')).toMatch(/at least 0/);
        expect(numberFieldError(temp, 'warm')).toMatch(/not a number/);
        expect(numberFieldError(temp, '')).toMatch(/not a number/);
        expect(numberFieldError(temp, '0.4')).toBeNull();
        expect(numberFieldError(temp, '2')).toBeNull();
    });
    it('a field without bounds only needs a number', () => {
        expect(numberFieldError({}, '12345')).toBeNull();
        expect(numberFieldError({}, 'x')).not.toBeNull();
    });
});

describe('credential keys (case 026)', () => {
    it('the compaction threshold is a setting; keys, secrets and tokens are credentials', () => {
        expect(isCredentialKey('fg_agent_compact_tokens')).toBe(false);
        expect(isCredentialKey('fg_temperature')).toBe(false);
        for (const k of ['fg_openai_key', 'fg_github_token', 'fg_tokenharbor_key', 'fg_some_secret', 'fg_password'])
            expect(isCredentialKey(k), k).toBe(true);
    });
});

describe('roles', () => {
    beforeAll(async () => { await import('../workers.ts'); });
    it('an unknown role is refused and the current one stays (cases 035, 043)', () => {
        expect(W.setMainAgentRole('director')).toBe(true);
        const before = W.mainAgentRole?.name;
        expect(W.setMainAgentRole('no-such-role-xyz')).toBe(false);
        expect(W.mainAgentRole?.name).toBe(before);
        expect(W.setMainAgentRole('coder')).toBe(true);
        expect(W.mainAgentRole?.name).toBe('coder');
        W.setMainAgentRole('director');
    });
});

describe('writes through a workspace adapter reload what the agent reads (case 046)', () => {
    it('skills, roles and AGENTS.md', async () => {
        const { setWorkspaceAdapter, agentWriteFile, agentDeleteFile } = await import('../workspace.ts');
        const loadSkills = vi.fn(), loadRoles = vi.fn(), loadAgentsContext = vi.fn();
        Object.assign(globalThis, { loadSkills, loadRoles, loadAgentsContext }); Object.assign(W, { loadSkills, loadRoles, loadAgentsContext });
        setWorkspaceAdapter({ agentWriteFile: async () => {}, agentDeleteFile: async () => {} } as any);
        try {
            await agentWriteFile('skills/meeting-style/SKILL.md', '---\nname: x\n---');
            expect(loadSkills).toHaveBeenCalledTimes(1);
            await agentWriteFile('roles/planner.md', 'x');
            expect(loadRoles).toHaveBeenCalledTimes(1);
            await agentWriteFile('./AGENTS.md', 'x');
            expect(loadAgentsContext).toHaveBeenCalledTimes(1);
            await agentWriteFile('notes/other.md', 'x');
            expect(loadSkills).toHaveBeenCalledTimes(1); expect(loadRoles).toHaveBeenCalledTimes(1);
            await agentDeleteFile('skills/meeting-style/SKILL.md');
            expect(loadSkills).toHaveBeenCalledTimes(2);
        } finally { setWorkspaceAdapter(null as any); }
    });
});
