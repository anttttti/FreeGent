// Settings → Models → Model Selections (settings-ui.ts, config.ts): Worker Model and Utility Model mark models that
// cannot be called with "no key", a picked model without a key gives way to the next usable one in the list (the
// choice itself is kept), and Defaults resets the priority list and both selections.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

const W = window as any;
beforeAll(async () => {
    W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    await import('../settings-ui.ts');
    document.body.insertAdjacentHTML('beforeend', '<div id="worker-model-selector"></div><div id="utility-model-selector"></div><div id="main-model-list"></div>');
});
afterEach(() => {
    for (const k of ['fg_groq_key', 'fg_kilo_key', 'fg_worker_model', 'fg_utility_model', 'fg_main_models', 'fg_privacy_level']) localStorage.removeItem(k);
});

const list = () => W.textModelChoices() as string[];
const firstOf = (provider: string) => list().find(s => s.startsWith(provider + '|'))!;

describe('model selections', () => {
    it('a picked model without a key gives way to the next usable one in the list, wrapping around', () => {
        localStorage.setItem('fg_groq_key', 'gsk-test');
        const kilo = firstOf('kilo');
        expect(W.modelChoiceUsable(kilo)).toBe(false);
        const next = W.usableModelChoice(kilo);
        expect(W.modelChoiceUsable(next)).toBe(true);
        const order = list(), from = order.indexOf(kilo);
        const expected = [...order.slice(from + 1), ...order.slice(0, from)].find(s => W.modelChoiceUsable(s) && !W.isBlacklistedModel(s));
        expect(next).toBe(expected);
        // A usable choice and the fixed choices are kept as they are.
        expect(W.usableModelChoice(firstOf('groq'))).toBe(firstOf('groq'));
        for (const fixed of ['', 'priority', 'none']) expect(W.usableModelChoice(fixed)).toBe(fixed);
    });

    it('keeps the saved choice, so it applies again once its key is set', () => {
        const kilo = firstOf('kilo');
        localStorage.setItem('fg_worker_model', kilo);
        localStorage.setItem('fg_groq_key', 'gsk-test');
        expect(W.getEffectiveWorkerModel()).not.toBe(kilo);
        expect(W.getWorkerModel()).toBe(kilo);
        localStorage.setItem('fg_kilo_key', 'sk-kilo');
        expect(W.getEffectiveWorkerModel()).toBe(kilo);
    });

    it("leaves the Utility Model's built-in default alone (it already falls back to the priority list)", () => {
        localStorage.setItem('fg_privacy_level', 'routed');
        expect(W.getEffectiveUtilityModel()).toBe(W.getUtilityModel());
    });

    it('lists only usable models, and says which model is used instead of a picked one that lost its key', () => {
        localStorage.setItem('fg_groq_key', 'gsk-test');
        const kilo = firstOf('kilo');
        localStorage.setItem('fg_utility_model', kilo);
        W.renderUtilityModelSelector();
        const combo = document.getElementById('utility-model-combo')!;
        const values = JSON.parse(combo.dataset.options!).map((o: any) => o.value);
        expect(values).toContain(firstOf('groq'));
        expect(values).not.toContain(kilo);
        expect(values.filter((v: string) => v.includes('|')).every((v: string) => W.modelChoiceUsable(v))).toBe(true);
        expect((combo.querySelector('.model-combo-value') as HTMLInputElement).value).toBe(W.getEffectiveUtilityModel());
        expect(document.getElementById('utility-model-selector')!.textContent).toMatch(/has no API key: .+ is used instead/);
    });

    it('"Search to add models" offers only usable models', () => {
        localStorage.setItem('fg_groq_key', 'gsk-test');
        localStorage.setItem('fg_main_models', JSON.stringify([]));
        W.renderMainModelList();
        const values = JSON.parse(document.getElementById('main-model-list-add-combo')!.dataset.options!).map((o: any) => o.value);
        expect(values).toContain(firstOf('groq'));
        expect(values).not.toContain(firstOf('kilo'));
        expect(values.every((v: string) => W.modelChoiceUsable(v))).toBe(true);
    });

    it('Defaults resets the priority list, Worker Model and Utility Model', () => {
        localStorage.setItem('fg_worker_model', 'priority');
        localStorage.setItem('fg_utility_model', 'none');
        localStorage.setItem('fg_main_models', JSON.stringify([firstOf('groq')]));
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        try { W.resetModelPriorityDefaults(); } finally { confirm.mockRestore(); }
        expect(W.getWorkerModel()).toBe('');
        expect(localStorage.getItem('fg_utility_model')).toBe('');
        expect(W.getMainModelList()).not.toEqual([firstOf('groq')]);
    });
});
