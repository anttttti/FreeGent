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

function mockDiscovery(ids: string[], metadata: any[] | null) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: any) => {
        const target = opts?.body ? JSON.parse(opts.body).url : new URL(url, 'https://test.invalid').searchParams.get('url');
        return { ok: true, json: async () => target === 'https://api.apinex.bond/v1/models'
            ? { data: ids.map(id => ({ id })) }
            : target === 'https://apinex.bond/api/public/models' && metadata ? { models: metadata } : null };
    }));
}
const freeMetadata = (id: string, allowFree = true) => ({ id, allowFree, dollarsPer1M: 0, outputDollarsPer1M: 0, supportsTools: true });
async function openDiscovery() {
    showModelUpdateModal();
    await vi.waitFor(() => expect(document.getElementById('fg-mu-loading')).toBeNull());
}

function acceptAddition(spec: string) {
    const box = [...document.querySelectorAll<HTMLInputElement>('#fg-mu-section-adds input[data-spec]')]
        .find(b => b.dataset.spec === spec)!;
    expect(box).toBeTruthy();
    box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('fg-mu-apply')!.click();
}

it('preserves discovered context, vision, tools and thinking when saving a new model', async () => {
    localStorage.setItem('fg_apinex_key', KEY);
    const id = 'free/deepseek-discovery-probe';
    mockDiscovery([id], [{ ...freeMetadata(id), contextWindow: '1M', supportsVision: true }]);
    await openDiscovery(); acceptAddition('apinex|' + id);
    expect(W.getCustomModels()).toContainEqual(expect.objectContaining({ provider: 'apinex', model: id,
        contextK: 1000, media: ['text', 'image'], tools: true, thinking: true }));
    expect(W.modelSupportsThinking('apinex', id)).toBe(true);
});

it('keeps the two routes that rejected image input text-only despite advertised vision', async () => {
    localStorage.setItem('fg_apinex_key', KEY);
    W.hideBuiltinModel('apinex|free/glm-5.3');
    mockDiscovery(['free/glm-5.3'], [{ ...freeMetadata('free/glm-5.3'), contextWindow: '1M', supportsVision: true }]);
    await openDiscovery(); acceptAddition('apinex|free/glm-5.3');
    expect(W.getAllModels().find((m: any) => m.provider === 'apinex' && m.model === 'free/glm-5.3').media).toEqual(['text']);
});

it('filters no-tools models by default and preserves the restriction if explicitly selected', async () => {
    localStorage.setItem('fg_apinex_key', KEY);
    const id = 'free/chat-without-tools';
    mockDiscovery(['free/glm-5.3-flash', id], [freeMetadata('free/glm-5.3-flash'), { ...freeMetadata(id), supportsTools: false, contextWindow: '64K' }]);
    await openDiscovery();
    expect(document.querySelector(`[data-spec="apinex|${id}"]`)).toBeNull();
    (document.querySelector('[data-filter="no-tools"]') as HTMLButtonElement).click();
    acceptAddition('apinex|' + id);
    expect(W.getCustomModels()).toContainEqual(expect.objectContaining({ model: id, contextK: 64, tools: false }));
    expect(W.getModelToolFormat('apinex', id)).toBe('none');
});

it.each([false, true])('uses current allowFree=%s metadata for a previously subscription-only model', async (allowFree) => {
    localStorage.setItem('fg_apinex_key', KEY);
    const id = 'free/claude-opus-4.6';
    mockDiscovery(['free/glm-5.3-flash', id], [freeMetadata('free/glm-5.3-flash'), freeMetadata(id, allowFree)]);
    await openDiscovery();
    const adds = [...document.querySelectorAll<HTMLInputElement>('#fg-mu-section-adds input[data-spec]')];
    expect(adds.some(b => b.dataset.spec === 'apinex|' + id)).toBe(allowFree);
});

it('proposes removing a saved model when live eligibility becomes subscription-only', async () => {
    localStorage.setItem('fg_apinex_key', KEY);
    const id = 'free/claude-opus-4.6';
    W.saveCustomModels([{ provider: 'apinex', model: id, label: 'Gated' }]);
    W.saveMainModelList(['apinex|' + id, GLM]);
    mockDiscovery(['free/glm-5.3-flash', id], [freeMetadata('free/glm-5.3-flash'), freeMetadata(id, false)]);
    await openDiscovery();
    const removes = [...document.querySelectorAll<HTMLInputElement>('#fg-mu-section-removes input[data-spec]')];
    expect(removes.find(b => b.dataset.spec === 'apinex|' + id)?.checked).toBe(true);
    document.getElementById('fg-mu-apply')!.click();
    expect(W.getMainModelList()).toEqual([GLM]);
});

it('leaves the saved catalog intact when public eligibility metadata is unavailable', async () => {
    localStorage.setItem('fg_apinex_key', KEY);
    mockDiscovery(['free/new-model'], null);
    await openDiscovery();
    const boxes = [...document.querySelectorAll<HTMLInputElement>('input[data-spec]')];
    expect(boxes.some(b => b.dataset.spec?.startsWith('apinex|'))).toBe(false);
    expect(W.getAllModels().some((m: any) => m.provider === 'apinex' && m.model === 'free/glm-5.3-flash')).toBe(true);
});

it('discovers only free/ IDs, hides non-chat routes, and leaves additions unchecked', async () => {
    localStorage.setItem('fg_apinex_key', KEY);
    W.hideBuiltinModel(GLM);
    const ids = ['free/glm-5.3-flash', 'free/glm-5.3-flash', 'free/new-model', 'glm-5.3-flash',
        'paid/new-model', 'free/claude-opus-4.6', 'free/jev-1.13', 'free/minimax-m3.1-flash'];
    mockDiscovery(ids, ids.map(id => ({ ...freeMetadata(id, id !== 'free/claude-opus-4.6'),
        ...(id === 'free/jev-1.13' ? { tags: ['decision'], supportsTools: false } : {}) })));
    showModelUpdateModal();
    await vi.waitFor(() => expect(document.getElementById('fg-mu-apply')).not.toBeNull());
    const boxes = [...document.querySelectorAll<HTMLInputElement>('#fg-mu-section-adds input[type=checkbox][data-spec]')]
        .filter(b => b.dataset.spec?.startsWith('apinex|'));
    expect(boxes.map(b => b.dataset.spec).sort()).toEqual([GLM, 'apinex|free/new-model', 'apinex|free/minimax-m3.1-flash'].sort());
    expect(boxes.every(b => !b.checked)).toBe(true);
    expect(document.getElementById('fg-mu-body')?.textContent).not.toContain('claude-opus-4.6');
});
