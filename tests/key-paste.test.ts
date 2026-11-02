// Settings → API Credentials paste box: keys are recognised by prefix anywhere in pasted text
// (settings-ui.ts findKeysInText).
import { describe, it, expect, beforeAll } from 'vitest';

const W = window as any;
let M: any;
beforeAll(async () => {
    W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    M = await import('../settings-ui.ts');
});

const pad = (p: string) => p + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';

describe('adding hosted models from Settings', () => {
    beforeEach(() => {
        localStorage.clear();
        document.body.innerHTML = '<div id="model-catalog-table"></div><div id="main-model-list"></div>';
    });
    afterEach(() => { localStorage.clear(); document.body.innerHTML = ''; });

    it.each([['moonmath-key', 'fg_moonmath_key'], ['requesty-key', 'fg_requesty_key']])('can clear a freshly entered override in %s without reopening Settings', (id, key) => {
        document.body.insertAdjacentHTML('beforeend', `<input id="${id}" type="password">`);
        const input = document.getElementById(id) as HTMLInputElement;
        input.value = 'synthetic-override'; W.saveSettings();
        expect(localStorage.getItem(key)).toBe('synthetic-override');
        input.value = ''; W.saveSettings();
        expect(localStorage.getItem(key)).toBe('');
    });

    it.each([
        ['moonmath', 'glm-5.3-flash-settings-probe', 'fg_moonmath_key', 'https://zro.moonmath.ai/v1/chat/completions'],
        ['requesty', 'acme/settings-probe', 'fg_requesty_key', 'https://router.requesty.ai/v1/chat/completions'],
    ])('adds a %s model through the provider selector and routes it using the saved key', (provider, model, key, url) => {
        localStorage.setItem(key, 'synthetic-settings-credential');
        W.renderModelCatalogTable();
        W.showAddCustomModelForm();
        const select = document.getElementById('new-model-provider') as HTMLSelectElement;
        select.value = provider;
        expect(select.value).toBe(provider);
        W._onNewModelProviderChange();
        expect(document.getElementById('new-model-url-row')!.style.display).toBe('none');
        (document.getElementById('new-model-id') as HTMLInputElement).value = model;
        W.addCustomModel();
        expect(W.getCustomModels()).toEqual(expect.arrayContaining([expect.objectContaining({ provider, model })]));
        expect(W.specToEndpoint(`${provider}|${model}`)).toMatchObject({ provider, model, url, key: 'synthetic-settings-credential' });
    });
});

describe('findKeysInText', () => {
    it('recognizes bare Requesty keys without treating a generic sk- key as MoonMath', () => {
        expect(M.findKeysInText(pad('rqsty-'))).toEqual({ REQUESTY_API_KEY: pad('rqsty-') });
        expect(M.findKeysInText(pad('sk-')).MOONMATH_API_KEY).toBeUndefined();
    });
    it('finds bare keys in any order, separated by anything', () => {
        const text = `${pad('gsk_')}, ${pad('AIza')}\n"${pad('tvly-')}"  here's github: ${pad('github_pat_')}.`;
        expect(M.findKeysInText(text)).toEqual({
            GROQ_API_KEY: pad('gsk_'),
            GEMINI_API_KEY: pad('AIza'),
            TAVILY_API_KEY: pad('tvly-'),
            GITHUB_TOKEN: pad('github_pat_'),
        });
    });

    it('recognises Nous Portal keys (sk-nous-…, and the older nsk-…) without taking other sk- keys', () => {
        const r = M.findKeysInText(`${pad('sk-nous-')} ${pad('sk-or-v1-')} ${pad('sk-kilo-')}`);
        expect(r).toEqual({ NOUSPORTAL_API_KEY: pad('sk-nous-'), OPENROUTER_API_KEY: pad('sk-or-v1-'), KILO_API_KEY: pad('sk-kilo-') });
        expect(M.findKeysInText(pad('nsk-')).NOUSPORTAL_API_KEY).toBe(pad('nsk-'));
    });

    it('distinguishes providers sharing a prefix stem', () => {
        const r = M.findKeysInText(`${pad('sk-kilo-')} ${pad('sk-or-v1-')}`);
        expect(r.KILO_API_KEY).toBe(pad('sk-kilo-'));
        expect(r.OPENROUTER_API_KEY).toBe(pad('sk-or-v1-'));
    });

    it('reads .env lines, including prefix-less keys, and ignores variable names', () => {
        const r = M.findKeysInText(`export HF_API_KEY="${pad('hf_')}"\nSTACKEXCHANGE_API_KEY=abc123xyz((\n# fg_hf_key_placeholder_value`);
        expect(r).toEqual({ HF_API_KEY: pad('hf_'), STACKEXCHANGE_API_KEY: 'abc123xyz((' });
    });

    it('ignores short tokens and keeps the first key per provider', () => {
        expect(M.findKeysInText('hf_short gsk_x')).toEqual({});
        expect(M.findKeysInText(`${pad('nvapi-')} ${pad('nvapi-')}Z`).NVIDIA_API_KEY).toBe(pad('nvapi-'));
    });
});

describe('pasting over a saved key', () => {
    const KEY = 'fg_groq_key';
    const setup = () => {
        document.body.innerHTML = '<textarea id="key-paste"></textarea><div id="key-paste-status"></div>';
        localStorage.setItem(KEY, 'old-saved-key');
    };
    afterEach(() => { vi.restoreAllMocks(); localStorage.removeItem(KEY); });

    it('keeps the saved key when the user declines', () => {
        setup();
        vi.spyOn(window, 'confirm').mockReturnValue(false);
        W.onKeyPasteInput(Object.assign(document.getElementById('key-paste') as HTMLTextAreaElement, { value: pad('gsk_') }));
        expect(localStorage.getItem(KEY)).toBe('old-saved-key');
        expect(document.getElementById('key-paste-status')!.textContent).toMatch(/Cancelled/);
    });

    it('replaces it on confirm, and does not ask for an empty slot or the same key', () => {
        setup();
        const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
        W.onKeyPasteInput(Object.assign(document.getElementById('key-paste') as HTMLTextAreaElement, { value: pad('gsk_') }));
        expect(localStorage.getItem(KEY)).toBe(pad('gsk_'));
        expect(ask).toHaveBeenCalledTimes(1);
        W.onKeyPasteInput(Object.assign(document.getElementById('key-paste') as HTMLTextAreaElement, { value: pad('gsk_') }));
        expect(ask).toHaveBeenCalledTimes(1);
    });
});
