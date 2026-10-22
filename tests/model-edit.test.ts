// codex report 8, cases 349-351, 357: the model edit dialog writes what its form changed, onto what is stored now.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const W: any = window;
beforeAll(async () => {
    W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    await import('../settings-ui.ts');
});
beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '<div id="model-catalog-table"></div><div id="main-model-list"></div>';
    W.alert = () => {};
    localStorage.setItem('fg_custom_models', JSON.stringify([{ provider: 'custom', model: 'mine', label: 'Mine', contextK: 128, tools: true, thinking: false, note: '', params: 7, rpm: 15, rpd: 100, released: '2026-09', url: 'http://x/v1', apiFormat: 'openai' }]));
});
const stored = () => JSON.parse(localStorage.getItem('fg_custom_models') || '[]');
const set = (id: string, v: string) => { (document.getElementById(id) as HTMLInputElement).value = v; };

describe('model edit dialog', () => {
    it('a label-only Save keeps the context and note another tab saved meanwhile (357)', () => {
        W.openEditModelDialog('custom|mine');
        localStorage.setItem('fg_custom_models', JSON.stringify([{ ...stored()[0], contextK: 256, note: 'newer note' }]));   // the other tab
        set('emd-label', 'Renamed');
        W.saveEditModel();
        expect(stored()[0]).toMatchObject({ label: 'Renamed', contextK: 256, note: 'newer note' });
    });
    it('clearing the optional fields removes them (351)', () => {
        W.openEditModelDialog('custom|mine');
        for (const id of ['emd-params', 'emd-rpm', 'emd-rpd', 'emd-released']) set(id, '');
        W.saveEditModel();
        const e = stored()[0];
        expect('params' in e || 'rpm' in e || 'rpd' in e).toBe(false);
        expect(e.released).not.toBe('2026-09');      // cleared (a missing date may be estimated again later, by design)
        W.openEditModelDialog('custom|mine');
        expect((document.getElementById('emd-rpm') as HTMLInputElement).value).toBe('');
    });
    it('clearing the API key and the address removes them (opencode §9)', () => {
        localStorage.setItem('fg_custom_models', JSON.stringify([{ ...stored()[0], key: 'OLD-CUSTOM-KEY' }]));
        W.openEditModelDialog('custom|mine');
        set('emd-api-key', ''); set('emd-url', '');
        W.saveEditModel();
        const e = stored()[0];
        expect('key' in e).toBe(false);
        expect('url' in e).toBe(false);
    });
    it('an unrelated edit leaves the key and address alone', () => {
        localStorage.setItem('fg_custom_models', JSON.stringify([{ ...stored()[0], key: 'KEEP-ME' }]));
        W.openEditModelDialog('custom|mine');
        set('emd-label', 'Renamed');
        W.saveEditModel();
        expect(stored()[0]).toMatchObject({ key: 'KEEP-ME', url: 'http://x/v1', label: 'Renamed' });
    });
    it('Save after the model was deleted elsewhere writes nothing (349)', () => {
        W.openEditModelDialog('custom|mine');
        localStorage.setItem('fg_custom_models', '[]');
        set('emd-label', 'Zombie');
        W.saveEditModel();
        expect(stored()).toEqual([]);
        expect(JSON.parse(localStorage.getItem('fg_hidden_models') || '[]')).toEqual([]);
    });
    it('editing a built-in model keeps it visible under the same key (350)', () => {
        const builtin = W.getAllModels().find((m: any) => m.provider !== 'custom');
        const key = `${builtin.provider}|${builtin.model}`;
        W.openEditModelDialog(key);
        set('emd-label', 'My label');
        W.saveEditModel();
        const again = W.getAllModels().find((m: any) => `${m.provider}|${m.model}` === key);
        expect(again).toBeTruthy();
        expect(again.label).toBe('My label');
        expect(W.getAllModels().filter((m: any) => `${m.provider}|${m.model}` === key)).toHaveLength(1);
    });
});
