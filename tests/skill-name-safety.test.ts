// codex R265: a skill's frontmatter name became its folder unchecked; `name: ../notes` overwrote notes/SKILL.md.
import { describe, it, expect, vi } from 'vitest';
const W = globalThis as any;

describe('skill and rule names', () => {
    it('refuses a name that is not one plain folder name', async () => {
        const { unsafeSkillName } = await import('../skills.ts');
        for (const n of ['../notes', 'a/b', '..', '.hidden', 'x/../y', '']) expect(unsafeSkillName(n), n).not.toBeNull();
        for (const n of ['commit', 'pdf-tools', 'v1.2_x']) expect(unsafeSkillName(n), n).toBeNull();
    });
    it('an imported skill with such a name is skipped, and nothing is written', async () => {
        await import('../skills.ts');
        const writes: string[] = [];
        const savedWrite = W.agentWriteFile; W.agentWriteFile = async (p: string) => { writes.push(p); };
        const alert = vi.fn(); vi.stubGlobal('alert', alert);
        const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
            Object.defineProperty(this, 'files', { configurable: true, value: [{ name: 'evil.md', text: async () => '---\nname: ../notes\n---\nbody' }] });
            void (this.onchange as any)?.(new Event('change'));
        });
        try {
            await W.installSkillFromFiles();
            await vi.waitFor(() => expect(alert).toHaveBeenCalled());
            expect(alert.mock.calls[0][0]).toMatch(/Skipped evil\.md: "\.\.\/notes" is not a usable name/);
            expect(writes).toEqual([]);
        } finally { click.mockRestore(); W.agentWriteFile = savedWrite; vi.unstubAllGlobals(); }
    });
});

// codex R266: a skill and a rule with one name replaced each other in whatever order their reads finished.
describe('a name used by two workspace files', () => {
    it('the skill keeps it whatever the read order, and the rule is reported', async () => {
        const { _skillNameConflicts } = await import('../skills.ts');
        const files: Record<string, string> = { 'skills/foo/SKILL.md': '---\nname: foo\n---\nSKILL BODY', 'rules/foo/RULE.md': '---\nname: foo\n---\nRULE BODY' };
        const saved = { dir: W.agentListFilesInDir, read: W.agentReadFile };
        W.agentListFilesInDir = async (d: string) => Object.keys(files).filter(n => n.startsWith(d + '/')).map(n => ({ name: n.slice(d.length + 1) }));
        for (const slowFirst of ['skills/foo/SKILL.md', 'rules/foo/RULE.md']) {
            W.agentReadFile = async (p: string) => { if (p === slowFirst) await new Promise(r => setTimeout(r, 20)); return files[p]; };
            await W.loadSkills();
            expect(W.skillsRegistry.get('foo')?.body).toBe('SKILL BODY');
            expect(_skillNameConflicts.join()).toMatch(/rules\/foo\/RULE\.md \(also skills\/foo\/SKILL\.md\)/);
        }
        Object.assign(W, { agentListFilesInDir: saved.dir, agentReadFile: saved.read });
        await W.loadSkills();
    });
});
