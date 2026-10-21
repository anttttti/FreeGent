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
