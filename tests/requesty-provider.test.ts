import { NULL_TASK_HANDLE } from '../render-adapter.ts';
import { showModelUpdateModal } from '../model-update.ts';
import { modelPageUrl } from '../model-page-url.ts';
import { _endpointCooldown, _markCooldown, getCooldownRemaining } from '../model-router.ts';
import { _httpErrorFromResponse } from '../retry.ts';

const W = window as any;
const LING = 'requesty|novita/ling-3.1-flash';
const ULTRA = 'requesty|nvidia/nemotron-3-ultra-550b-a55b';
const KEY = 'synthetic-requesty-credential';
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
afterEach(() => {
    vi.unstubAllGlobals(); localStorage.clear(); document.body.innerHTML = '';
    for (const k of [..._endpointCooldown.keys()]) _endpointCooldown.delete(k);
});

it('requires credentials, then routes main and worker requests to the Requesty router', () => {
    W.saveMainModelList([LING, ULTRA]);
    expect(W.getActiveMainModelList()).toEqual([]);
    localStorage.setItem('fg_requesty_key', KEY);
    expect(W.getActiveMainModelList()).toEqual([LING, ULTRA]);
    expect(W.oaiEndpoint()).toMatchObject({ provider: 'requesty', model: 'novita/ling-3.1-flash', key: KEY,
        url: 'https://router.requesty.ai/v1/chat/completions' });
    expect(W.resolveWorkerModelSpec(null, null)).toBe(ULTRA);
    expect(modelPageUrl('requesty', 'nvidia/nemotron-3-ultra-550b-a55b')).toBe('https://www.requesty.ai/models/nvidia/nemotron-3-ultra-550b-a55b');
});

it('recognizes Requesty keys by name and by their rqsty- prefix', () => {
    expect(findKeysInText(`REQUESTY_API_KEY="${KEY}"`)).toEqual({ REQUESTY_API_KEY: KEY });
    const bare = 'rqsty-sk-' + 'a'.repeat(40);
    expect(findKeysInText(bare)).toEqual({ REQUESTY_API_KEY: bare });
});

it('sends authentication and reasoning_effort through background and main completion paths', async () => {
    localStorage.setItem('fg_requesty_key', KEY);
    localStorage.setItem('fg_thinking_level', 'medium');
    const request = vi.fn(async () => new Response(JSON.stringify({
        choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 1, cost: 0 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', request);
    expect(await W.callLLMComplete('Reply OK.', { maxTokens: 20, maxAttempts: 1, endpoint: W.specToEndpoint(LING) }, NULL_TASK_HANDLE)).toBe('OK');
    const [url, opts] = request.mock.calls[0] as any;
    expect(url).toBe('https://router.requesty.ai/v1/chat/completions');
    expect(opts.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(opts.body)).toMatchObject({ model: 'novita/ling-3.1-flash', reasoning_effort: 'none' });
    await W.callOAI(() => {}, () => {}, { endpointOverride: W.specToEndpoint(ULTRA),
        localHistory: [{ role: 'user', content: 'Reply OK.' }], toolFilterOverride: new Set(), maxTokens: 100 });
    expect(JSON.parse((request.mock.calls[1] as any)[1].body)).toMatchObject({ reasoning_effort: 'medium' });
});

it.each([[0, 'none'], [1024, 'low'], [8192, 'medium'], [24576, 'high'], [-1, undefined]])(
    'maps thinking budget %s to reasoning_effort %s', (thinkingBudget, effort) => {
        const p = W.buildChatPayload({ provider: 'requesty', model: 'novita/ling-3.1-flash' }, { messages: [{ role: 'user', content: 'hi' }],
            maxTokens: 100, stream: true, thinkingBudget });
        expect(p.reasoning_effort).toBe(effort);
        expect(p.chat_template_kwargs).toBeUndefined();
    });

it('keeps the provider message of a Requesty router error', async () => {
    const body = JSON.stringify({ error: { origin: 'router', message: "Your organization's balance is too low to run this request. Top up at https://app.requesty.ai/settings/billing or enable auto-top-up" } });
    const err = await _httpErrorFromResponse(new Response(body, { status: 402 }));
    expect(err.message).toBe("HTTP 402: Your organization's balance is too low to run this request. Top up at https://app.requesty.ai/settings/billing or enable auto-top-up");
});

describe('Requesty cooldowns', () => {
    it('retries an in-flight limit refusal after 5 seconds on every Requesty model, whatever the generic 429 path would do', async () => {
        const body = JSON.stringify({ error: { origin: 'router', message: "Your organization reached its limit of concurrent requests. The limit scales with your organization's balance, top up at https://app.requesty.ai/settings/billing" } });
        const err = await _httpErrorFromResponse(new Response(body, { status: 429 }));
        expect(err.retryAfterMs).toBe(5_000);
        _markCooldown(W.specToEndpoint(LING), err.retryAfterMs, err);
        expect(getCooldownRemaining(LING)).toBe(5);
        expect(getCooldownRemaining(ULTRA)).toBe(5);
        expect(getCooldownRemaining('kilo|reflection/beam-free')).toBe(0);
    });

    it('cools only the priced model on a low-balance 402, leaving the $0 routes usable', () => {
        localStorage.setItem('fg_custom_models', JSON.stringify([{ provider: 'requesty', model: 'openai/gpt-6-luna', label: 'Paid' }]));
        _markCooldown({ provider: 'requesty', model: 'openai/gpt-6-luna' }, null,
            new Error("HTTP 402: Your organization's balance is too low to run this request."));
        expect(getCooldownRemaining('requesty|openai/gpt-6-luna')).toBe(3_600);
        expect(getCooldownRemaining(LING)).toBe(0);
    });

    it('cools every Requesty model for an hour when the key reaches its monthly spend limit (412)', () => {
        const err = new Error('HTTP 412: Reached monthly spend limit for API key');
        expect(W._isRateLimit(err.message)).toBe(true);
        _markCooldown(W.specToEndpoint(ULTRA), null, err);
        expect(getCooldownRemaining(ULTRA)).toBe(3_600);
        expect(getCooldownRemaining(LING)).toBe(3_600);
    });

    it('leaves an upstream provider 429 to the generic per-model handling', () => {
        _markCooldown(W.specToEndpoint(LING), 30_000, new Error('HTTP 429: Too many requests'));
        expect(getCooldownRemaining(LING)).toBeGreaterThan(0);
        expect(getCooldownRemaining(ULTRA)).toBe(0);
    });
});

describe('Requesty model discovery', () => {
    const listed = [
        { id: 'novita/ling-3.1-flash', api: 'chat', input_price: 0, output_price: 0, context_window: 262144, supports_tool_calling: true, supports_reasoning: false, supports_vision: false, created: 1790553600 },
        { id: 'acme/new-free', api: 'chat', input_price: 0, output_price: 0, context_window: 131072, supports_tool_calling: true, supports_reasoning: true, supports_vision: true, created: 1793000000 },
        { id: 'poolside/laguna-m.1', api: 'chat', input_price: 0, output_price: 0, context_window: 32768, supports_tool_calling: false, created: 1781014014 },
        { id: 'nvidia/nemotron-3-nano-30b-a3b', api: 'chat', input_price: 0, output_price: 0, context_window: 262144, supports_tool_calling: true, created: 1765731275 },
        { id: 'openai/gpt-6-luna', api: 'chat', input_price: 7.5e-8, output_price: 3e-7, context_window: 1048576, supports_tool_calling: true, created: 1790000000 },
    ];
    beforeEach(() => {
        localStorage.setItem('fg_requesty_key', KEY);
        vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: any) => {
            const target = opts?.body ? JSON.parse(opts.body).url : url;
            return { ok: true, json: async () => target === 'https://router.requesty.ai/v1/models' ? { data: listed } : null };
        }));
    });
    const specs = (section: string) => [...document.querySelectorAll<HTMLInputElement>(`#fg-mu-section-${section} input[data-spec]`)]
        .map(b => b.dataset.spec!).filter(s => s.startsWith('requesty|'));

    it('proposes new $0 tool-capable routes with their capabilities, skips priced, no-tools and blacklisted ones', async () => {
        showModelUpdateModal();
        await vi.waitFor(() => expect(document.getElementById('fg-mu-loading')).toBeNull());
        const adds = specs('adds');
        expect(adds).toContain('requesty|acme/new-free');
        expect(adds).not.toContain('requesty|openai/gpt-6-luna');
        expect(adds).not.toContain('requesty|nvidia/nemotron-3-nano-30b-a3b');   // FREE_MODEL_BLACKLIST: HTTP 410
        expect(adds).not.toContain(LING);                                         // already in the catalog
        const box = document.querySelector<HTMLInputElement>('#fg-mu-section-adds input[data-spec="requesty|acme/new-free"]')!;
        box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('fg-mu-apply')!.click();
        expect(W.getAllModels().find((m: any) => m.provider === 'requesty' && m.model === 'acme/new-free'))
            .toMatchObject({ contextK: 131.072, tools: true, thinking: true, media: ['text', 'image'] });
    });
});
