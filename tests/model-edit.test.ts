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
    it('can declare image, audio or video input, so the model can be chosen for them (codex R259)', () => {
        W.openEditModelDialog('custom|mine');
        (document.getElementById('emd-media-image') as HTMLInputElement).checked = true;
        W.saveEditModel();
        expect(stored()[0].media).toEqual(['text', 'image']);
        W.openEditModelDialog('custom|mine');
        expect((document.getElementById('emd-media-image') as HTMLInputElement).checked).toBe(true);
        set('emd-label', 'Renamed'); W.saveEditModel();
        expect(stored()[0].media).toEqual(['text', 'image']);   // an unrelated edit keeps it
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

describe('detection results (EV031, EV032)', () => {
    const catalogs: Record<string, any> = {
        'http://a.test/v1/models': { data: [{ id: 'model-a', max_model_len: 163840 }] },
        'http://b.test/v1/models': { data: [{ id: 'model-b' }] },
    };
    const stubServers = (late: Record<string, Promise<void>> = {}) => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        await late[url];
        return catalogs[url] ? { ok: true, json: async () => catalogs[url] } : { ok: false, status: 404, json: async () => ({}) };
    }));
    const addForm = () => {
        document.body.insertAdjacentHTML('beforeend', '<div id="add-custom-model-form"><input id="new-model-url"><input id="new-model-key"><input id="new-model-api"><input id="new-model-id"><input id="new-model-label"><input id="new-model-ctx"><input id="new-model-note"><span id="new-model-detect-status"></span></div>');
    };
    it('a late answer for another address does not fill the form, and a detected address is saved as the one probed', async () => {
        addForm();
        let release!: () => void;
        stubServers({ 'http://a.test/v1/models': new Promise<void>(r => { release = r; }) });
        set('new-model-url', 'http://a.test');
        const first = W.detectNewModel();
        set('new-model-url', 'http://b.test');
        await W.detectNewModel();
        release(); await first;
        expect((document.getElementById('new-model-id') as HTMLInputElement).value).toBe('model-b');
        expect((document.getElementById('new-model-url') as HTMLInputElement).value).toBe('http://b.test/v1');
        expect((document.getElementById('new-model-ctx') as HTMLInputElement).value).not.toBe('160');
    });
    it('a late re-detection does not change the model of a dialog opened since', async () => {
        let release!: () => void;
        stubServers({ 'http://x/v1/models': new Promise<void>(r => { release = r; }) });
        catalogs['http://x/v1/models'] = { data: [{ id: 'mine', max_model_len: 163840 }] };
        W.openEditModelDialog('custom|mine');
        const pending = W.redetectEditModel();
        W.openEditModelDialog('custom|mine');   // the dialog is built again: the old answer is not for it
        release(); await pending;
        expect((document.getElementById('emd-ctx') as HTMLInputElement).value).toBe('128');
        delete catalogs['http://x/v1/models'];
    });
});
