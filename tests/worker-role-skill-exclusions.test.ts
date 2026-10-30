// codex R222/R223: a skill injected into a worker by its `roles` ignored `exclude_roles` (main-agent roles) and `exclude_mode`.
import { describe, it, expect, afterEach } from 'vitest';
import { setMainAgentRoleObject } from '../state.ts';
const W = globalThis as any;

describe('worker role skills honour the skill exclusions', () => {
    afterEach(() => { W.skillsRegistry.delete('zz-excl'); setMainAgentRoleObject(null); });
    it('exclude_roles: not for a worker the Director launched, still for one an Agent launched', () => {
        W.skillsRegistry.set('zz-excl', { name: 'zz-excl', roles: 'coder', exclude_roles: 'director', body: 'ZZ-EXCL-BODY' });
        setMainAgentRoleObject({ name: 'director' } as any);
        expect(W._roleSkillBodies('coder')).not.toContain('ZZ-EXCL-BODY');
        setMainAgentRoleObject({ name: 'agent' } as any);
        expect(W._roleSkillBodies('coder')).toContain('ZZ-EXCL-BODY');
    });
    it('exclude_mode: browser keeps it out of a worker in the WebUI', () => {
        W.skillsRegistry.set('zz-excl', { name: 'zz-excl', roles: 'coder', exclude_mode: 'browser', body: 'ZZ-EXCL-BODY' });
        expect(W._roleSkillBodies('coder')).not.toContain('ZZ-EXCL-BODY');
        W.skillsRegistry.set('zz-excl', { name: 'zz-excl', roles: 'coder', exclude_mode: 'container', body: 'ZZ-EXCL-BODY' });
        expect(W._roleSkillBodies('coder')).toContain('ZZ-EXCL-BODY');
    });
});
