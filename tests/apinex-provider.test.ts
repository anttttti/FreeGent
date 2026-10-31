import { NULL_TASK_HANDLE } from '../render-adapter.ts';
import { showModelUpdateModal } from '../model-update.ts';
import { modelPageUrl } from '../model-page-url.ts';

const W = window as any;
const GLM = 'apinex|free/glm-5.3-flash';
const DEEPSEEK = 'apinex|free/deepseek-v4.1-flash';
const KEY = 'synthetic-apinex-credential';
let findKeysInText: (text: string) => Record<string, string>;
beforeAll(async () => {
    W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    ({ findKeysInText } = await import('../settings-ui.ts'));
    await import('../llm-loops.ts');
});
beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '<div id="model-catalog-table"></div><div id="main-model-list"></div>';
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); document.body.innerHTML = ''; });

it('requires credentials and preserves the free/ route in main and worker requests', () => {
    W.saveMainModelList([GLM, DEEPSEEK]);
    expect(W.getActiveMainModelList()).toEqual([]);
    localStorage.setItem('fg_apinex_key', KEY);
    expect(W.getActiveMainModelList()).toEqual([GLM, DEEPSEEK]);
    expect(W.oaiEndpoint()).toMatchObject({ provider: 'apinex', model: 'free/glm-5.3-flash', key: KEY,
        url: 'https://api.apinex.bond/v1/chat/completions' });
    expect(W.resolveWorkerModelSpec(null, null)).toBe(DEEPSEEK);
    expect(W.specToEndpoint(DEEPSEEK)).toMatchObject({ provider: 'apinex', model: 'free/deepseek-v4.1-flash', key: KEY });
    expect(modelPageUrl('apinex', 'free/glm-5.3-flash')).toBe('https://apinex.bond/models');
});

it('recognizes explicit APINEX_API_KEY assignments without claiming shared bare key prefixes', () => {
    expect(findKeysInText(`APINEX_API_KEY="${KEY}"`)).toEqual({ APINEX_API_KEY: KEY });
    expect(findKeysInText('sk-' + 'a'.repeat(32)).APINEX_API_KEY).toBeUndefined();
});

it('sends authentication and supported effort through background and main completion paths', async () => {
    localStorage.setItem('fg_apinex_key', KEY);
    localStorage.setItem('fg_thinking_level', 'medium');
    const request = vi.fn(async () => new Response(JSON.stringify({
        choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', request);
    expect(await W.callLLMComplete('Reply OK.', { maxTokens: 20, maxAttempts: 1,
        endpoint: W.specToEndpoint(GLM) }, NULL_TASK_HANDLE)).toBe('OK');
    const [url, opts] = request.mock.calls[0] as any;
    expect(url).toBe('https://api.apinex.bond/v1/chat/completions');
    expect(opts.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(opts.body)).toMatchObject({ model: 'free/glm-5.3-flash', reasoning_effort: 'low' });
    await W.callOAI(() => {}, () => {}, { endpointOverride: W.specToEndpoint(DEEPSEEK),
        localHistory: [{ role: 'user', content: 'Reply OK.' }], toolFilterOverride: new Set(), maxTokens: 100 });
    expect(JSON.parse((request.mock.calls[1] as any)[1].body)).toMatchObject({ reasoning_effort: 'medium' });
});

it.each([
    ['free/glm-5.3-flash', 0, 'low'], ['free/deepseek-v4.1-flash', 1024, 'low'],
    ['free/deepseek-v4.1-flash', 8192, 'medium'], ['free/glm-5.3-flash', 24576, 'high'],
    ['free/glm-5.3-flash', -1, undefined], ['free/gpt-6-luna', 24576, undefined],
])('maps %s budget %s to supported effort %s while keeping tools and streams', (model, thinkingBudget, effort) => {
    const p = W.buildChatPayload({ provider: 'apinex', model }, { messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.2, maxTokens: 100, stream: true, thinkingBudget,
        tools: [{ type: 'function', function: { name: 'check', parameters: { type: 'object', properties: {} } } }] });
    expect(p.reasoning_effort).toBe(effort);
    expect(p).toMatchObject({ stream: true, tool_choice: 'auto' });
    expect(p.tools).toHaveLength(1);
    expect(p.chat_template_kwargs).toBeUndefined();
});

it('keeps subscription-only routes out of the free catalog and saved rankings', () => {
    const gated = 'apinex|free/claude-opus-4.6';
    W.saveCustomModels([{ provider: 'apinex', model: 'free/claude-opus-4.6', label: 'Gated' }]);
    W.saveMainModelList([gated, GLM]);
    expect(W.getAllModels().some((m: any) => `${m.provider}|${m.model}` === gated)).toBe(false);
    expect(W.getMainModelList()).toEqual([GLM]);
});

it('discovers only free/ IDs, hides non-chat routes, and leaves additions unchecked', async () => {
    localStorage.setItem('fg_apinex_key', KEY);
    W.hideBuiltinModel(GLM);
    const request = vi.fn(async (_url: string, opts?: any) => {
        const target = opts?.body ? JSON.parse(opts.body).url : '';
        return { ok: true, json: async () => target === 'https://api.apinex.bond/v1/models' ? { data: [
            { id: 'free/glm-5.3-flash' }, { id: 'free/glm-5.3-flash' },
            { id: 'free/new-model' }, { id: 'glm-5.3-flash' }, { id: 'paid/new-model' },
            { id: 'free/claude-opus-4.6' }, { id: 'free/jev-1.13' }, { id: 'free/minimax-m3.1-flash' },
        ] } : null };
    });
    vi.stubGlobal('fetch', request);
    showModelUpdateModal();
    await vi.waitFor(() => expect(document.getElementById('fg-mu-apply')).not.toBeNull());
    const boxes = [...document.querySelectorAll<HTMLInputElement>('#fg-mu-section-adds input[type=checkbox][data-spec]')]
        .filter(b => b.dataset.spec?.startsWith('apinex|'));
    expect(boxes.map(b => b.dataset.spec).sort()).toEqual([GLM, 'apinex|free/new-model', 'apinex|free/minimax-m3.1-flash'].sort());
    expect(boxes.every(b => !b.checked)).toBe(true);
    expect(document.getElementById('fg-mu-body')?.textContent).not.toContain('claude-opus-4.6');
});
