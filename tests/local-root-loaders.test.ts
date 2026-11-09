import { describe, it, expect, beforeAll, afterEach } from 'vitest';

// codex R394-R396: the attached Local Folder's AGENTS.md, skills, rules and roles were not loaded, and writing them did not reload.
const W = window as any;
let saved: Record<string, any> = {};
let files: Record<string, string>;
const SKILL = (name: string) => `---\nname: ${name}\ndescription: d\ntrigger: x\n---\nBody of ${name}\n`;
beforeAll(async () => { await import('../skills.ts'); await import('../workers.ts'); await import('../workspace.ts'); });
afterEach(() => { for (const [k, v] of Object.entries(saved)) W[k] = v; saved = {}; localStorage.clear(); });
const stub = (k: string, v: any) => { if (!(k in saved)) saved[k] = W[k]; W[k] = v; };

describe('Local Folder setup files', () => {
    it('skills and rules under local/ are loaded; a workspace file of the same name wins', async () => {
        files = {
            'local/skills/folder-only/SKILL.md': SKILL('folder-only'),
            'local/rules/folder-rule.rule.md': SKILL('folder-rule'),
            'skills/shared/SKILL.md': SKILL('shared'),
            'local/skills/shared/SKILL.md': SKILL('shared'),
        };
        stub('agentListFilesInDir', async (dir: string) => Object.keys(files).filter(n => n.startsWith(dir + '/')).map(n => ({ name: n.slice(dir.length + 1) })));
        stub('agentReadFile', async (p: string) => { if (!(p in files)) throw new Error('File not found: ' + p); return files[p]; });
        await W.loadSkills();
        expect(W.skillsRegistry.get('folder-only')?.path).toBe('local/skills/folder-only/SKILL.md');
        expect(W.skillsRegistry.get('folder-rule')).toBeTruthy();
        expect(W.skillsRegistry.get('shared')?.path).toBe('skills/shared/SKILL.md');
        const { _skillNameConflicts } = await import('../skills.ts');
        expect(_skillNameConflicts).toEqual([]);
    });
});

describe('AGENTS.md and the reload on a write', () => {
    it('reads the workspace AGENTS.md first and the folder\'s when the workspace has none', async () => {
        await import('../llm-shared.ts');
        stub('agentReadFile', async (p: string) => { if (!(p in files)) throw new Error('File not found: ' + p); return files[p]; });
        files = { 'local/AGENTS.md': 'folder rules' };
        await W.loadAgentsContext();
        expect(W.agentsContext).toBe('folder rules');
        files['AGENTS.md'] = 'workspace rules';
        await W.loadAgentsContext();
        expect(W.agentsContext).toBe('workspace rules');
    });

    it('writing local/AGENTS.md, local/roles/x.md and local/skills/x/SKILL.md reloads them', async () => {
        const calls: string[] = [];
        stub('loadAgentsContext', () => calls.push('agents')); stub('loadRoles', () => calls.push('roles')); stub('loadSkills', () => calls.push('skills'));
        const { _reloadSetupFor } = await import('../workspace.ts');
        for (const p of ['local/AGENTS.md', 'local/roles/x.md', 'local/skills/x/SKILL.md', 'local/rules/r.rule.md']) _reloadSetupFor(p);
        expect(calls).toEqual(['agents', 'roles', 'skills', 'skills']);
    });
});
