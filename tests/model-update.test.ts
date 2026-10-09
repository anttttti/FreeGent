import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { showModelUpdateModal } from '../model-update.ts';

const W = window as any;
const removed = 'openrouter|poolside/laguna-xs-2.1:free';
const kept = 'kilo|dots-studio/dots-3-note-preview:free';
const paused = 'kilo|nvidia/nemotron-3-ultra-550b-a55b:free';
const noKey = 'nvidia|nvidia/nemotron-3-ultra-550b-a55b';
const custom = 'openrouter|test/retired:free';

beforeAll(async () => {
    W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    await import('../settings-ui.ts');
});

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '<div id="model-catalog-table"></div><div id="main-model-list"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    document.body.innerHTML = '';
});

async function openUpdate(missing: string[], extraLive: string[] = []) {
    // Exercise the real discovery, checkbox, Apply, persistence and rendering paths.
    const live = W.getAllModels().filter((m: any) => m.provider === 'openrouter'
        && !missing.includes(`openrouter|${m.model}`)).map((m: any) => m.model);
    vi.stubGlobal('fetch', vi.fn(async (input: string) => ({
        ok: true,
        json: async () => input === 'https://openrouter.ai/api/v1/models'
            ? { data: [...live, ...extraLive].map((id: string) => ({ id, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] })) }
            : null,
    })));
    showModelUpdateModal();
    await vi.waitFor(() => expect(document.querySelector('#fg-mu-apply')).not.toBeNull());
}

function selectRemove(spec: string) {
    const cb = Array.from(document.querySelectorAll<HTMLInputElement>('#fg-mu-section-removes input'))
        .find(el => el.dataset.spec === spec)!;
    expect(cb).toBeTruthy();
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
}

function apply() { document.querySelector<HTMLButtonElement>('#fg-mu-apply')!.click(); }

describe('catalog updates reconcile Model Priority', () => {
    it('removes built-ins from the catalog and ranking, preserving paused/no-key models and order', async () => {
        W.saveMainModelList([noKey, removed, paused, kept]);
        W.savePausedMainModels([paused, removed]);
        W.renderMainModelList();
        await openUpdate([removed]);
        selectRemove(removed);
        apply();

        expect(W.getAllModels().map((m: any) => `${m.provider}|${m.model}`)).not.toContain(removed);
        expect(W.getMainModelList()).toEqual([noKey, paused, kept]);
        expect(JSON.parse(localStorage.getItem('fg_main_models')!)).toEqual([noKey, paused, kept]);
        expect(W.getPausedMainModels()).toEqual([paused]);
        expect(document.querySelectorAll('#main-model-list .model-priority-row')).toHaveLength(3);
        expect(document.querySelector(`#model-catalog-table [data-key="${removed}"]`)).toBeNull();
        W.renderMainModelList(); // Reopening/re-rendering must not resurrect the model.
        expect(W.getMainModelList()).not.toContain(removed);
        W.resetMainModelList();
        expect(W.getMainModelList()).not.toContain(removed);
    });

    it('removes custom entries without dropping unrelated inactive priority entries', async () => {
        W.saveCustomModels([{ provider: 'openrouter', model: 'test/retired:free', label: 'Retired' }]);
        W.saveMainModelList([paused, custom, noKey, kept]);
        W.savePausedMainModels([paused]);
        await openUpdate([custom]);
        selectRemove(custom);
        apply();
        expect(W.getCustomModels()).toEqual([]);
        expect(W.getMainModelList()).toEqual([paused, noKey, kept]);
    });

    it('keeps unchecked removal proposals in both the catalog and ranking', async () => {
        W.saveMainModelList([removed, kept]);
        await openUpdate([removed]);
        apply();
        expect(W.getMainModelList()).toEqual([removed, kept]);
        expect(W.getAllModels().some((m: any) => `${m.provider}|${m.model}` === removed)).toBe(true);
    });

    it('makes a previously removed built-in available again when its addition is accepted', async () => {
        W.hideBuiltinModel(removed);
        W.saveMainModelList([kept]);
        await openUpdate([], [removed.slice(removed.indexOf('|') + 1)]);
        const cb = Array.from(document.querySelectorAll<HTMLInputElement>('#fg-mu-section-adds input'))
            .find(el => el.dataset.spec === removed)!;
        expect(cb).toBeTruthy();
        expect(cb.checked).toBe(true);
        apply();
        expect(W.getAllModels().filter((m: any) => `${m.provider}|${m.model}` === removed)).toHaveLength(1);
        expect(W.getHiddenModels().has(removed)).toBe(false);
        expect(W.getMainModelList()).toEqual([kept]);
    });
});

describe('TokenHarbor discovery follows the API, not a fixed list', () => {
    it('offers a new :free model with zero price, and not paid or no-tools ones', async () => {
        localStorage.setItem('fg_tokenharbor_key', 'thk_live_test');
        const free = (id: string, extra: any = {}) => ({ id, label: id, created: 1700000000, tool_call: true,
            pricing: { input_usd_per_1m: 0, output_usd_per_1m: 0 }, ...extra });
        const models = [
            free('deepseek-v4.1-flash:free'),                                   // already in the catalog
            free('future-model-9:free', { label: 'Future Model 9 (Free)' }),    // new and free
            free('chat-only:free', { tool_call: false }),                       // free, no tools
            free('paid-model', { pricing: { input_usd_per_1m: 1, output_usd_per_1m: 2 } }),
            free('paid-model:free', { pricing: { input_usd_per_1m: 1, output_usd_per_1m: 2 } }),
        ];
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: any) => {
            const target = init?.body ? JSON.parse(init.body).url : '';
            return { ok: true, json: async () => target === 'https://tokenharbor.ai/v1/models' ? { data: models } : null };
        }));
        showModelUpdateModal();
        await vi.waitFor(() => expect(document.querySelector('#fg-mu-apply')).not.toBeNull());
        const adds = Array.from(document.querySelectorAll<HTMLInputElement>('#fg-mu-section-adds input')).map(el => el.dataset.spec);
        expect(adds).toContain('tokenharbor|future-model-9:free');
        expect(adds).not.toContain('tokenharbor|paid-model');
        expect(adds).not.toContain('tokenharbor|paid-model:free');
        expect(adds).not.toContain('tokenharbor|deepseek-v4.1-flash:free');
    });
});
