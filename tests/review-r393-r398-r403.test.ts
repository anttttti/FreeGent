// codex R393 (non-string skill trigger override), R398 (mixed-case role name), R403 (invalid approval value).
import { describe, it, expect, beforeAll, afterEach } from 'vitest';

const W = window as any;
beforeAll(async () => { await import('../skills.ts'); await import('../workers.ts'); });
afterEach(() => { localStorage.clear(); });

describe('approval policy value (R403)', () => {
    it('an unknown stored value falls back to the default policy instead of reading as off', () => {
        localStorage.setItem('fg_tool_approval', 'bogus');
        expect(['off', 'high']).toContain(W.getToolApproval());
        localStorage.setItem('fg_tool_approval', 'all');
        expect(W.getToolApproval()).toBe('all');
        localStorage.setItem('fg_tool_approval', 'high');
        expect(W.getToolApproval()).toBe('high');
    });
});

describe('skill trigger overrides (R393)', () => {
    it('a number as a trigger override is ignored, so trigger matching keeps working on strings', async () => {
        localStorage.setItem('fg_skill_triggers', JSON.stringify({ 'api-calls': { trigger: 42, trigger_on_filetype: { a: 1 } } }));
        await W.loadSkills();
        const s = W.skillsRegistry.get('api-calls');
        expect(s.trigger).not.toBe(42);
        expect(typeof s.trigger).toBe('string');
        expect(s.trigger_on_filetype).not.toEqual({ a: 1 });
    });
});

describe('main role selection (R398)', () => {
    it('a custom role with a mixed-case name can be selected', () => {
        W.rolesRegistry.set('SecurityReviewer', { name: 'SecurityReviewer', body: 'x' });
        try {
            expect(W.setMainAgentRole('SecurityReviewer')).toBe(true);
            expect(W.mainAgentRole?.name).toBe('SecurityReviewer');
        } finally { W.rolesRegistry.delete('SecurityReviewer'); W.clearMainAgentRole?.(); }
    });
});

describe('session grants for execute_code (R402)', () => {
    afterEach(() => { document.getElementById('tool-approval-toast')?.remove(); });

    it('a grant given for browser-sandbox code does not cover code that runs on the host', async () => {
        const { requestToolApproval } = await import('../tools.ts');
        localStorage.setItem('fg_sandbox_provider', 'local');
        localStorage.setItem('fg_tool_approval', 'high');
        const toast = document.createElement('div');
        toast.id = 'tool-approval-toast';
        toast.innerHTML = '<span id="tool-approval-label"></span><span id="tool-approval-detail"></span><input type="checkbox" id="tool-approval-session"><span id="tool-approval-session-name"></span>';
        document.body.appendChild(toast);
        // approve JavaScript (the browser sandbox) for the session
        const first = requestToolApproval('execute_code', { language: 'javascript', code: '1' });
        await new Promise(r => setTimeout(r, 0));
        (document.getElementById('tool-approval-session') as HTMLInputElement).checked = true;
        W.resolveToolApproval(true);
        expect(await first).toBe(true);
        // bash under the local provider runs on the user's computer: it asks again
        const p = W.executeToolAsync('execute_code', { language: 'bash', code: 'echo hi' }, null);
        await new Promise(r => setTimeout(r, 20));
        expect(toast.style.display).not.toBe('none');
        W.resolveToolApproval(false);
        expect((await p).error).toMatch(/denied/i);
    });
});
