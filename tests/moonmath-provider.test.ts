import { NULL_TASK_HANDLE } from '../render-adapter.ts';
import { showModelUpdateModal } from '../model-update.ts';
import { modelPageUrl } from '../model-page-url.ts';
import { stripThinkingFields } from '../payload-builder.ts';

const W = window as any;
const DEEPSEEK = 'moonmath|deepseek-v4.1-flash';
const GLM = 'moonmath|glm-5.3-flash';
const KEY = 'synthetic-moonmath-credential';
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
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); document.body.innerHTML = ''; });

it('keeps MoonMath inactive without credentials, then routes main and worker requests to its own endpoint', () => {
    W.saveMainModelList([DEEPSEEK, GLM]);
    expect(W.getActiveMainModelList()).toEqual([]);
    localStorage.setItem('fg_moonmath_key', KEY);
    expect(W.getActiveMainModelList()).toEqual([DEEPSEEK, GLM]);
    expect(W.oaiEndpoint()).toMatchObject({ provider: 'moonmath', model: 'deepseek-v4.1-flash', key: KEY,
        url: 'https://zro.moonmath.ai/v1/chat/completions' });
    expect(W.resolveWorkerModelSpec(null, null)).toBe(GLM);
    expect(W.specToEndpoint(GLM)).toMatchObject({ provider: 'moonmath', model: 'glm-5.3-flash', key: KEY });
    expect(modelPageUrl('moonmath', 'zro/glm-5.3-flash')).toBe('https://zro.moonmath.ai/docs/models/glm-5.3-flash');
});

it('recognizes explicit MOONMATH_API_KEY assignments without guessing the provider of a bare sk- key', () => {
    expect(findKeysInText(`MOONMATH_API_KEY="${KEY}"`)).toEqual({ MOONMATH_API_KEY: KEY });
    expect(findKeysInText('sk-' + 'a'.repeat(32)).MOONMATH_API_KEY).toBeUndefined();
});

it('can discover models directly when privacy settings disable the proxy', async () => {
    localStorage.setItem('fg_moonmath_key', KEY);
    W.hideBuiltinModel(GLM);
    vi.spyOn(W, 'getLocalApiProxy').mockReturnValue('');
    const request = vi.fn(async (url: string) => ({ ok: true, json: async () =>
        url === 'https://zro.moonmath.ai/v1/models' ? { data: [{ id: 'glm-5.3-flash', max_input_tokens: 1000000 }] } : null }));
    vi.stubGlobal('fetch', request);
    showModelUpdateModal();
    await vi.waitFor(() => expect(document.getElementById('fg-mu-apply')).not.toBeNull());
    const call = request.mock.calls.find(([url]) => url === 'https://zro.moonmath.ai/v1/models') as any;
    expect(call[1]).toMatchObject({ method: 'GET', headers: { Authorization: `Bearer ${KEY}` } });
    document.getElementById('fg-mu-apply')!.click();
    expect(W.getAllModels().find((m: any) => m.provider === 'moonmath' && m.model === 'glm-5.3-flash'))
        .toMatchObject({ contextK: 1000, media: ['text', 'image'], tools: true, thinking: true });
});

it('passes the selected thinking level through the main agent request path', async () => {
    localStorage.setItem('fg_moonmath_key', KEY);
    localStorage.setItem('fg_thinking_level', 'medium');
    const request = vi.fn(async () => new Response(JSON.stringify({
        choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', request);
    await W.callOAI(() => {}, () => {}, { endpointOverride: W.specToEndpoint(DEEPSEEK),
        localHistory: [{ role: 'user', content: 'Reply OK.' }], toolFilterOverride: new Set(), maxTokens: 100 });
    expect(JSON.parse((request.mock.calls[0] as any)[1].body)).toMatchObject({ reasoning_effort: 'high' });
});

it('uses the shared completion path with MoonMath authentication and background reasoning disabled', async () => {
    localStorage.setItem('fg_moonmath_key', KEY);
    localStorage.setItem('fg_thinking_level', 'medium');
    const request = vi.fn(async () => new Response(JSON.stringify({
        choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', request);
    expect(await W.callLLMComplete('Reply OK.', { maxTokens: 20, maxAttempts: 1,
        endpoint: W.specToEndpoint(DEEPSEEK) }, NULL_TASK_HANDLE)).toBe('OK');
    expect(request).toHaveBeenCalledTimes(1);
    const [url, opts] = request.mock.calls[0] as any;
    expect(url).toBe('https://zro.moonmath.ai/v1/chat/completions');
    expect(opts.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(opts.body)).toMatchObject({ model: 'deepseek-v4.1-flash', reasoning_effort: 'none' });
});

it.each([
    ['deepseek-v4.1-flash', 0, 'none'], ['glm-5.3-flash', 0, 'low'],
    ['deepseek-v4.1-flash', 1024, 'low'], ['glm-5.3-flash', 8192, 'high'], ['deepseek-v4.1-flash', 24576, 'max'],
])('maps %s budget %s to supported effort %s while preserving streaming and tools', (model, thinkingBudget, effort) => {
    const p = W.buildChatPayload({ provider: 'moonmath', model }, { messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.2, maxTokens: 100, stream: true, thinkingBudget,
        tools: [{ type: 'function', function: { name: 'check', parameters: { type: 'object', properties: {} } } }] });
    expect(p).toMatchObject({ reasoning_effort: effort, stream: true, tool_choice: 'auto' });
    expect(p.tools).toHaveLength(1);
    expect(p.chat_template_kwargs).toBeUndefined();
});

it('leaves default reasoning to MoonMath', () => {
    const p = W.buildChatPayload({ provider: 'moonmath', model: 'deepseek-v4.1-flash' },
        { messages: [], temperature: 0.2, maxTokens: 100, thinkingBudget: -1 });
    expect(p.reasoning_effort).toBeUndefined();
});

it('removes MoonMath effort when the shared retry path disables rejected thinking fields', () => {
    expect(stripThinkingFields({ model: 'deepseek-v4.1-flash', reasoning_effort: 'high', max_tokens: 100 }))
        .toEqual({ model: 'deepseek-v4.1-flash', max_tokens: 100 });
});

it('discovers only advertised Free-plan IDs, deduplicates aliases, and excludes paid models', async () => {
    localStorage.setItem('fg_moonmath_key', KEY);
    W.hideBuiltinModel(DEEPSEEK);
    W.hideBuiltinModel(GLM);
    const request = vi.fn(async (_url: string, opts?: any) => {
        const target = opts?.body ? JSON.parse(opts.body).url : '';
        return { ok: true, json: async () => target === 'https://zro.moonmath.ai/v1/models' ? { data: [
            { id: 'deepseek-v4.1-flash' }, { id: 'zro/deepseek-v4.1-flash' },
            { id: 'glm-5.3-flash' }, { id: 'glm-5.3' }, { id: 'dolly-2-security' },
        ] } : null };
    });
    vi.stubGlobal('fetch', request);
    showModelUpdateModal();
    await vi.waitFor(() => expect(document.getElementById('fg-mu-apply')).not.toBeNull());
    const boxes = [...document.querySelectorAll<HTMLInputElement>('#fg-mu-section-adds input[type=checkbox][data-spec]')];
    expect(boxes.map(b => b.dataset.spec).filter(s => s?.startsWith('moonmath|')).sort()).toEqual([DEEPSEEK, GLM].sort());
    expect(document.getElementById('fg-mu-body')?.textContent).not.toContain('dolly-2-security');
});
