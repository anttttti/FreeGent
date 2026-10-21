// codex report 8, cases 254/256/257: the skill/rule editor compared each field with the already-overridden value.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

const W: any = window;
beforeAll(async () => {
    W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    await import('../settings-ui.ts');
    await import('../skills.ts');
    W.loadSkills = () => {};   // the editor reloads the list after Save; not needed here
});
beforeEach(() => localStorage.clear());

const stored = () => JSON.parse(localStorage.getItem('fg_skill_triggers') || '{}');
function open(skill: any) {
    const wrap = W._buildSkillTriggerEditor(skill) as HTMLElement;
    document.body.innerHTML = ''; document.body.appendChild(wrap);
    const f = (k: string) => wrap.querySelector(`textarea[data-field="${k}"]`) as HTMLTextAreaElement;
    return { wrap, f, save: () => (wrap.querySelector('.skill-trigger-save-btn') as HTMLElement).click() };
}
// A registry entry as loadSkills leaves it once overrides are applied: current values overridden, defaults remembered.
const overridden = () => ({ name: 'r', body: 'custom body', trigger: 'custom words', __defaults: { body: 'default body', trigger: 'default words' } });

describe('skill and rule editor', () => {
    it('an unchanged Save keeps the stored overrides', () => {
        localStorage.setItem('fg_skill_triggers', JSON.stringify({ r: { body: 'custom body', trigger: 'custom words' } }));
        const e = open(overridden());
        expect(e.f('body').dataset.default).toBe('default body');
        e.save();
        expect(stored().r).toEqual({ body: 'custom body', trigger: 'custom words' });
    });
    it('editing only the body keeps the untouched trigger override, and the other way round', () => {
        localStorage.setItem('fg_skill_triggers', JSON.stringify({ r: { body: 'custom body', trigger: 'custom words' } }));
        let e = open(overridden());
        e.f('body').value = 'newer body'; e.save();
        expect(stored().r).toEqual({ body: 'newer body', trigger: 'custom words' });
        e = open({ ...overridden(), body: 'newer body' });
        e.f('trigger').value = 'newer words'; e.save();
        expect(stored().r).toEqual({ body: 'newer body', trigger: 'newer words' });
    });
    it('a stale editor does not remove an override another tab saved meanwhile', () => {
        const e = open({ name: 'r', body: 'default body', trigger: 'default words' });    // built before any override existed
        localStorage.setItem('fg_skill_triggers', JSON.stringify({ r: { body: 'other tab body' } }));
        e.f('trigger').value = 'my words'; e.save();
        expect(stored().r).toEqual({ body: 'other tab body', trigger: 'my words' });
    });
    it('setting a field back to its default removes just that override', () => {
        localStorage.setItem('fg_skill_triggers', JSON.stringify({ r: { body: 'custom body', trigger: 'custom words' } }));
        const e = open(overridden());
        e.f('body').value = 'default body'; e.save();
        expect(stored().r).toEqual({ trigger: 'custom words' });
    });
});

describe('deleting a custom rule (259)', () => {
    it('removes its stored customisation, so a rule created under the same name starts from its own file', async () => {
        W.agentDeleteFile = async () => {};
        localStorage.setItem('fg_skill_triggers', JSON.stringify({ r: { body: 'old body', trigger: 'old words' }, other: { trigger: 'keep' } }));
        await W._deleteSkillEntry({ name: 'r', type: 'rule' });
        expect(stored()).toEqual({ other: { trigger: 'keep' } });
    });
    it('a failed delete keeps the customisation', async () => {
        W.agentDeleteFile = async () => { throw new Error('nope'); };
        W.alert = () => {};
        localStorage.setItem('fg_skill_triggers', JSON.stringify({ r: { trigger: 'old words' } }));
        await W._deleteSkillEntry({ name: 'r', type: 'rule' });
        expect(stored().r).toEqual({ trigger: 'old words' });
    });
});

describe('an open editor survives a redraw of the list (342/344)', () => {
    it('keeps its open state, unsaved text and focus when an unrelated rule is toggled', () => {
        document.body.innerHTML = '<div id="settings-skills-list"></div><div id="skills-list"></div>';
        W.skillsRegistry.clear();
        W.skillsRegistry.set('mine', { name: 'mine', type: 'rule', path: 'rules/mine/RULE.md', description: '', trigger: 'kw', body: 'original body' });
        W.renderSkillsChecklist();
        const nameBtn = () => document.querySelector('.sr-name-btn[class*="sr-name-btn"]') as HTMLElement;
        const mineBtn = [...document.querySelectorAll('.sr-name-btn')].find(b => b.textContent === '/mine') as HTMLElement;
        mineBtn.click();
        (document.querySelector('.skill-trigger-wrap[data-skill="mine"] .skill-trigger-edit-btn') as HTMLElement).click();
        const ta = () => document.querySelector('.skill-trigger-wrap[data-skill="mine"] textarea[data-field="body"]') as HTMLTextAreaElement;
        ta().value = 'unsaved edit'; ta().focus();
        W.renderSkillsChecklist();                                        // another tab toggled an unrelated rule
        expect(ta().value).toBe('unsaved edit');
        expect((ta().closest('.sr-editor-row') as HTMLElement).style.display).not.toBe('none');
        expect((ta().closest('.skill-trigger-editor') as HTMLElement).style.display).not.toBe('none');
        expect(document.activeElement).toBe(ta());
        void nameBtn;
    });
});

describe('the registry is replaced in one step (343)', () => {
    it('a matching rule is still there while the files are being read again', async () => {
        const real = (await import('../skills.ts')).loadSkills;
        W.skillsRegistry.clear();
        W.skillsRegistry.set('kw-rule', { name: 'kw-rule', type: 'rule', path: 'rules/kw-rule/RULE.md', trigger: 'kw', body: 'B' });
        let release!: () => void; const gate = new Promise<void>(r => { release = r; });
        W.agentListFilesInDir = async (d: string) => { await gate; return d === 'rules' ? [{ name: 'kw-rule/RULE.md' }] : []; };
        W.agentReadFile = async () => '---\nname: kw-rule\ntrigger: kw\n---\nB';
        W.parseFrontmatter = (t: string) => ({ name: 'kw-rule', trigger: 'kw' });
        const loading = real();
        await new Promise(r => setTimeout(r, 5));
        expect(W.skillsRegistry.has('kw-rule')).toBe(true);     // not emptied while reading
        release(); await loading;
        expect(W.skillsRegistry.has('kw-rule')).toBe(true);
        delete W.agentListFilesInDir;
    });
});
