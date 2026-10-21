// prefs.ts and its first users (codex report 8, cases 243-253).
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { setPref, patchPrefs, onPrefChange } from '../prefs.ts';

const W: any = window;
beforeEach(() => localStorage.clear());

describe('prefs', () => {
    it('notifies matching listeners once per patch, with only the keys that changed', () => {
        const seen: any[] = [];
        const off = onPrefChange(/^fg_a/, (k, o) => seen.push([k, o]));
        localStorage.setItem('fg_a1', 'x');
        patchPrefs({ fg_a1: 'x', fg_a2: '2', fg_b: '3' });
        expect(seen).toEqual([[['fg_a2'], 'local']]);
        setPref('fg_a2', null);
        expect(seen.at(-1)).toEqual([['fg_a2'], 'local']);
        expect(localStorage.getItem('fg_a2')).toBeNull();
        off(); setPref('fg_a3', '1');
        expect(seen).toHaveLength(2);
    });
    it('prefix match and another tab\'s storage event', () => {
        const fn = vi.fn(); onPrefChange('fg_agent_*', fn);
        window.dispatchEvent(new StorageEvent('storage', { key: 'fg_agent_x', storageArea: localStorage }));
        window.dispatchEvent(new StorageEvent('storage', { key: 'fg_other', storageArea: localStorage }));
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith(['fg_agent_x'], 'remote');
    });
    it('a throwing listener does not stop the others', () => {
        const ok = vi.fn();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        onPrefChange('fg_t', () => { throw new Error('x'); }); onPrefChange('fg_t', ok);
        setPref('fg_t', '1');
        expect(ok).toHaveBeenCalled();
    });
});

describe('saveSettings writes only what this form changed', () => {
    beforeAll(async () => {
        W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        await import('../settings-ui.ts');
        for (const n of ['renderModelCatalogTable', 'renderMainModelList', 'updateModelLabel', 'updateActiveModelDisplay']) W[n] ??= () => {};
    });
    it('a stale form does not write its old provider or key over another tab\'s newer value', () => {
        document.body.innerHTML = `<select id="search-provider"><option>auto</option><option>wikipedia</option></select>
            <select id="sandbox-provider"><option>wasm</option><option>local</option></select>
            <input id="groq-key" type="password">`;
        const sp = document.getElementById('search-provider') as HTMLSelectElement;
        const gk = document.getElementById('groq-key') as HTMLInputElement;
        sp.value = 'auto'; sp.dataset.fgBase = 'auto';
        gk.value = 'old-key'; gk.dataset.fgBase = 'old-key'; gk.dataset.fgLoaded = '1';
        // another tab stores newer values
        localStorage.setItem('fg_search_provider', 'wikipedia');
        localStorage.setItem('fg_groq_key', 'new-key');
        // this tab edits only the sandbox provider
        const sb = document.getElementById('sandbox-provider') as HTMLSelectElement;
        sb.dataset.fgBase = 'wasm'; sb.value = 'local';
        W.saveSettings();
        expect(localStorage.getItem('fg_sandbox_provider')).toBe('local');
        expect(localStorage.getItem('fg_search_provider')).toBe('wikipedia');
        expect(localStorage.getItem('fg_groq_key')).toBe('new-key');
    });
    it('a control the user did change is written', () => {
        document.body.innerHTML = '<select id="search-provider"><option>auto</option><option>wikipedia</option></select>';
        const sp = document.getElementById('search-provider') as HTMLSelectElement;
        sp.dataset.fgBase = 'auto'; sp.value = 'wikipedia';
        W.saveSettings();
        expect(localStorage.getItem('fg_search_provider')).toBe('wikipedia');
        expect(sp.dataset.fgBase).toBe('wikipedia');
    });
});

describe('rules and skills follow stored preferences (251-255)', () => {
    beforeAll(async () => {
        W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        await import('../settings-ui.ts'); await import('../skills.ts');
    });
    it('a profile-style patch updates the live enabled sets; a later toggle starts from the stored set', async () => {
        const name = (W.BUILTIN_RULES[0] as any).name, other = (W.BUILTIN_RULES[1] as any).name;
        patchPrefs({ fg_builtin_rules: JSON.stringify([name]) });
        await vi.waitFor(() => expect(W.skillsRegistry.has(name)).toBe(true));
        expect(W.skillsRegistry.has(other)).toBe(false);
        // another tab turns `other` on; this tab then toggles something else off
        window.dispatchEvent(new StorageEvent('storage', { key: 'fg_builtin_rules', storageArea: localStorage }));
        localStorage.setItem('fg_builtin_rules', JSON.stringify([name, other]));
        window.dispatchEvent(new StorageEvent('storage', { key: 'fg_builtin_rules', storageArea: localStorage }));
        await vi.waitFor(() => expect(W.skillsRegistry.has(other)).toBe(true));
    });
});

describe('the model button follows another tab\'s model change (250)', () => {
    beforeAll(async () => {
        W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        await import('../settings-ui.ts'); await import('../config.ts');
    });
    it('a storage event for the model list re-renders the button', async () => {
        localStorage.setItem('fg_groq_key', 'k');
        document.body.innerHTML = '<button id="input-model-btn"></button>';
        W.updateInputModelBtn();
        const before = document.getElementById('input-model-btn')!.textContent;
        const next = 'groq|openai/gpt-oss-120b';
        localStorage.setItem('fg_main_models', JSON.stringify([next]));
        window.dispatchEvent(new StorageEvent('storage', { key: 'fg_main_models', newValue: JSON.stringify([next]), storageArea: localStorage }));
        await vi.waitFor(() => expect(document.getElementById('input-model-btn')!.textContent).not.toBe(before));
        expect(document.getElementById('input-model-btn')!.textContent).toMatch(/gpt-oss/i);
    });
});
