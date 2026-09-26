/**
 * Agent tests — pure utilities, history conversion, search routing,
 * settings, checkpoints, retry logic.
 */
import { IDBFactory } from 'fake-indexeddb';

const W = window;

beforeEach(() => {
    localStorage.clear();
    window.fetch.mockReset();
    // Reset internal agent state (histories, streaming flag, etc.)
    window.newChat?.();
    // Null out mainAgentRole so buildSystemPrompt returns the base template, not a role body.
    window.mainAgentRole = null;
});

// ── estimateTokens ────────────────────────────────────────────────────────────

describe('estimateTokens', () => {
    it('is ceil(JSON.stringify.length / 4)', () => {
        const obj = { text: 'abcd' };
        const expected = Math.ceil(JSON.stringify(obj).length / 4);
        expect(W.estimateTokens(obj)).toBe(expected);
    });

    it('handles empty object', () => {
        expect(W.estimateTokens({})).toBe(Math.ceil('{}'.length / 4));
    });

    it('handles string values', () => {
        const s = 'hello world';
        expect(W.estimateTokens(s)).toBeGreaterThan(0);
    });
});

// ── toolLabel ─────────────────────────────────────────────────────────────────

describe('toolLabel', () => {
    it('read_file', () => expect(W.toolLabel('read_file', { path: 'foo.txt' })).toBe('read:foo.txt'));
    it('write_file', () => expect(W.toolLabel('write_file', { path: 'bar.md' })).toBe('write:bar.md'));
    it('delete_file', () => expect(W.toolLabel('delete_file', { path: 'x.txt' })).toBe('del:x.txt'));
    it('list_files', () => expect(W.toolLabel('list_files', {})).toBe('list_files'));
    it('execute_code', () => expect(W.toolLabel('execute_code', { language: 'bash' })).toBe('exec(bash)'));
    it('web_search truncates at 28 chars', () => {
        const label = W.toolLabel('web_search', { query: 'a'.repeat(50) });
        expect(label.startsWith('search:')).toBe(true);
        expect(label.length).toBeLessThanOrEqual(35);
    });
    it('unknown tool returns name', () => expect(W.toolLabel('mystery', {})).toBe('mystery'));
    it('fetch_url strips protocol', () => {
        const label = W.toolLabel('fetch_url', { url: 'https://example.com/path' });
        expect(label.startsWith('fetch:')).toBe(true);
        expect(label).not.toContain('https://');
    });
});

// ── cleanResponse ─────────────────────────────────────────────────────────────

describe('cleanResponse', () => {
    it('strips <think> blocks', () => {
        expect(W.cleanResponse('<think>internal</think>visible')).toBe('visible');
    });
    it('strips <thinking> blocks', () => {
        expect(W.cleanResponse('<thinking>hidden</thinking>shown')).toBe('shown');
    });
    it('strips multi-line think blocks', () => {
        const r = W.cleanResponse('<thinking>\nline1\nline2\n</thinking>Answer');
        expect(r).toBe('Answer');
    });
    it('collapses 3+ newlines to 2', () => {
        expect(W.cleanResponse('a\n\n\n\nb')).toBe('a\n\nb');
    });
    it('trims leading/trailing whitespace', () => {
        expect(W.cleanResponse('   hello   ')).toBe('hello');
    });
    it('leaves normal text unchanged', () => {
        expect(W.cleanResponse('Hello world')).toBe('Hello world');
    });
});

// ── isTransient ───────────────────────────────────────────────────────────────

describe('isTransient', () => {
    it.each([
        'HTTP 500', 'HTTP 503', 'HTTP 529',
        'Internal error', 'Failed to fetch', 'NetworkError', 'Load failed',
    ])('matches %s', (msg) => {
        expect(W.isTransient(new Error(msg))).toBe(true);
    });

    it.each([
        'HTTP 400', 'HTTP 401', 'HTTP 403', 'HTTP 404', 'Invalid API key', 'Bad request',
    ])('does not match %s', (msg) => {
        expect(W.isTransient(new Error(msg))).toBe(false);
    });
});

// ── renderMarkdown ────────────────────────────────────────────────────────────

describe('renderMarkdown', () => {
    beforeEach(() => {
        // Provide a passthrough DOMPurify so tests exercise the sanitized path
        (window as any).DOMPurify = { sanitize: (html: string, _opts?: any) => html };
    });
    afterEach(() => { delete (window as any).DOMPurify; });

    it('uses marked.parse when marked is available', () => {
        window.marked = { parse: (t) => `<p>${t}</p>` };
        expect(W.renderMarkdown('hello')).toBe('<p>hello</p>');
    });

    it('adds target=_blank to links', () => {
        window.marked = { parse: () => '<a href="http://x.com">link</a>' };
        const result = W.renderMarkdown('text');
        expect(result).toContain('target="_blank"');
        expect(result).toContain('rel="noopener noreferrer"');
    });

    it('escapes HTML when DOMPurify is absent', () => {
        delete (window as any).DOMPurify;
        window.marked = { parse: () => '<script>alert(1)</script>' };
        const result = W.renderMarkdown('x');
        expect(result).not.toContain('<script>');
        expect(result).toContain('&lt;script&gt;');
    });

    it('falls back to basic renderer when marked absent', () => {
        const saved = window.marked;
        delete window.marked;
        const r = W.renderMarkdown('**bold** and `code`');
        expect(r).toContain('<strong>bold</strong>');
        expect(r).toContain('<code>code</code>');
        window.marked = saved;
    });

    it('escapes HTML in fallback', () => {
        const saved = window.marked;
        delete window.marked;
        const r = W.renderMarkdown('<script>xss</script>');
        expect(r).not.toContain('<script>');
        expect(r).toContain('&lt;script');
        window.marked = saved;
    });
});

// ── buildSystemPrompt ─────────────────────────────────────────────────────────

describe('buildSystemPrompt', () => {
    // The outer beforeEach nulls mainAgentRole; restore it to Director so
    // buildSystemPrompt() returns the real role body (the roleless path is dead).
    beforeEach(() => { W.setMainAgentRole?.('director'); });
    afterEach(() => { W.mainAgentRole = null; });

    it('mentions FreeGent', () => {
        expect(W.buildSystemPrompt()).toContain('FreeGent');
    });

    it.todo('does not mention execute_code without sandbox — execute_code appears in skill/tool list regardless of sandbox; re-evaluate when prompt template is split');

    it('mentions execute_code when local sandbox is set', () => {
        localStorage.setItem('fg_sandbox_provider', 'local');
        expect(W.buildSystemPrompt()).toContain('execute_code');
        localStorage.setItem('fg_sandbox_provider', 'none');
    });

    it('adds Wikipedia-only note when provider is wikipedia', () => {
        localStorage.setItem('fg_search_provider', 'wikipedia');
        expect(W.buildSystemPrompt()).toContain('Wikipedia only');
    });

    it('adds Tavily note when provider is tavily', () => {
        localStorage.setItem('fg_search_provider', 'tavily');
        expect(W.buildSystemPrompt()).toContain('Tavily');
    });

    it('adds Brave note when provider is brave', () => {
        localStorage.setItem('fg_search_provider', 'brave');
        expect(W.buildSystemPrompt()).toContain('Brave');
    });
});

// ── Settings helpers ──────────────────────────────────────────────────────────

describe('settings helpers — defaults', () => {
    // Default comes from _DEFAULT_MAIN_MODELS[0] which is a kilo free model (noKey:true).
    it('getProvider defaults to kilo', () => expect(W.getProvider()).toBe('kilo'));
    it('getGeminiModel defaults to gemini-2.5-flash', () => expect(W.getGeminiModel()).toBe('gemini-2.5-flash'));
    it('getOAIModel defaults to mistral-medium-3.5', () => expect(W.getOAIModel()).toBe('mistral-medium-3.5'));
    it('getOAIUrl defaults to openai base', () => expect(W.getOAIUrl()).toBe('https://api.openai.com/v1'));
    it('getSearchProvider defaults to auto', () => expect(W.getSearchProvider()).toBe('auto'));
    it('getTavilyKey returns empty string by default', () => expect(W.getTavilyKey()).toBe(''));
    it('getSearchProxy returns empty string by default', () => expect(W.getSearchProxy()).toBe(''));
    it('getBraveKey returns empty string by default', () => expect(W.getBraveKey()).toBe(''));
    it('getSandboxProvider returns wasm by default', () => expect(W.getSandboxProvider()).toBe('wasm'));
});

describe('settings helpers — reads localStorage', () => {
    it('reads provider', () => {
        localStorage.setItem('fg_provider', 'google');
        expect(W.getProvider()).toBe('google');
    });
    it('strips trailing slash from OAI URL', () => {
        localStorage.setItem('fg_openai_url', 'http://localhost:8000/v1/');
        expect(W.getOAIUrl()).toBe('http://localhost:8000/v1');
    });
    it('reads Tavily key', () => {
        localStorage.setItem('fg_tavily_key', 'tvly-abc');
        expect(W.getTavilyKey()).toBe('tvly-abc');
    });
});

// ── getMistralKey / getMistralModel ───────────────────────────────────────────

describe('getMistralKey / getMistralModel defaults', () => {
    it('getMistralKey returns empty string by default', () => {
        expect(W.getMistralKey()).toBe('');
    });

    it('getMistralModel defaults to mistral-medium-3.5', () => {
        expect(W.getMistralModel()).toBe('mistral-medium-3.5');
    });

    it('getMistralKey reads from localStorage', () => {
        localStorage.setItem('fg_mistral_key', 'msk-test');
        expect(W.getMistralKey()).toBe('msk-test');
    });

    it('getMistralModel reads from localStorage', () => {
        localStorage.setItem('fg_mistral_model', 'mistral-small-latest');
        expect(W.getMistralModel()).toBe('mistral-small-latest');
    });
});

// ── oaiEndpoint ───────────────────────────────────────────────────────────────

describe('oaiEndpoint', () => {
    it('returns custom URL for custom provider', () => {
        // Use fg_provider legacy path since 'custom' is not in catalog and would be pruned
        localStorage.setItem('fg_openai_url', 'https://api.openai.com/v1');
        localStorage.setItem('fg_openai_key', 'sk-test');
        // Default provider is google; force an OAI endpoint via oaiEndpoint with provider override
        // by setting a non-google main model that routes through the custom branch
        const ep = W.oaiEndpoint();
        // With default google provider, oaiEndpoint falls through to custom branch
        expect(ep.url).toContain('/chat/completions');
    });

    it('returns Mistral URL for mistral provider', () => {
        localStorage.setItem('fg_provider', 'mistral');
        localStorage.setItem('fg_mistral_key', 'msk-abc');
        localStorage.setItem('fg_mistral_model', 'mistral-small-latest');
        const ep = W.oaiEndpoint();
        expect(ep.url).toBe('https://api.mistral.ai/v1/chat/completions');
        expect(ep.key).toBe('msk-abc');
        expect(ep.model).toBe('mistral-small-latest');
    });

    it('strips trailing slash from custom OAI URL', () => {
        // getProvider() reads from getActiveMainModelList(), not fg_provider, so we must
        // register a custom model spec in fg_custom_models and set fg_main_models to point at
        // it — only then does oaiEndpoint() call _customEndpoint(), which reads fg_openai_url.
        localStorage.setItem('fg_custom_models', JSON.stringify([
            { provider: 'custom', model: 'local', label: 'local', released: '', contextK: 8, params: 0, media: ['text'], tools: true, thinking: false, note: '' }
        ]));
        localStorage.setItem('fg_main_models', JSON.stringify(['custom|local']));
        localStorage.setItem('fg_openai_url', 'http://localhost:8000/v1/');
        const ep = W.oaiEndpoint();
        expect(ep.url).toBe('http://localhost:8000/v1/chat/completions');
    });
});

// ── getActiveModel ────────────────────────────────────────────────────────────

describe('getActiveModel', () => {
    // getProvider()/getActiveModel() now read from getActiveMainModelList(), which
    // filters by specHasKey.  Specs without a configured key are excluded, so tests
    // must supply the matching key AND set fg_main_models to the specific model.

    it('returns gemini model for google provider', () => {
        localStorage.setItem('fg_gemini_key', 'AIza-test');
        localStorage.setItem('fg_main_models', JSON.stringify(['google|gemma-4-31b-it']));
        expect(W.getActiveModel()).toBe('gemma-4-31b-it');
    });

    it('returns mistral model for mistral provider (via legacy fg_provider migration path)', () => {
        // Setting fg_provider without fg_main_models triggers the migration path that
        // builds ['mistral|{fg_mistral_model}'] from per-provider localStorage keys.
        localStorage.setItem('fg_provider', 'mistral');
        localStorage.setItem('fg_mistral_key', 'msk-test');
        localStorage.setItem('fg_mistral_model', 'mistral-small-latest');
        expect(W.getActiveModel()).toBe('mistral-small-latest');
    });

    it('returns mistral model when mistral is in main list', () => {
        localStorage.setItem('fg_mistral_key', 'msk-test');
        localStorage.setItem('fg_main_models', JSON.stringify(['mistral|mistral-small-latest']));
        expect(W.getActiveModel()).toBe('mistral-small-latest');
    });
});

// ── activeTools ───────────────────────────────────────────────────────────────

describe('activeTools', () => {
    // write_file and delete_file are OPT_IN_TOOLS (disabled by default); enable them
    // for tests that verify they appear in the active set when enabled.
    beforeEach(() => {
        W.enabledTools.add('write_file');
        W.enabledTools.add('delete_file');
    });
    afterEach(() => {
        W.enabledTools.delete('write_file');
        W.enabledTools.delete('delete_file');
    });

    it('always includes core tools for main agent (no role active)', () => {
        // Tests pre-seed mainAgentRole=null so no role filter is active — baseline check.
        const names = W.activeTools().map(t => t.name);
        expect(names).toContain('list_files');
        expect(names).toContain('write_file');
        expect(names).toContain('web_search');
        expect(names).toContain('fetch_url');
        // delete_file is opt-in; even when enabled, it is excluded for main-agent (not forWorker).
        // The activeTools() role ceiling for a nil role allows all enabled tools, but
        // delete_file has no special main-agent exclusion beyond the OPT_IN gate — so
        // when we've explicitly enabled it above, it IS present for the main agent.
        // We do not assert its absence here; the worker-specific test below covers forWorker.
    });

    it('Researcher role restricts to its tool set', () => {
        const researcherRole = { name: 'researcher', tools: new Set(['list_files', 'web_search', 'fetch_url', 'read_file', 'search_workspace']) };
        W.mainAgentRole = researcherRole;
        const names = W.activeTools().map(t => t.name);
        expect(names).toContain('list_files');
        expect(names).toContain('web_search');
        expect(names).toContain('read_file');
        expect(names).not.toContain('run_workers');  // not in Researcher's tools set
        expect(names).not.toContain('replace_in_file');
        W.mainAgentRole = null;
    });

    it('includes delete_file for worker (forWorker=true)', () => {
        const names = W.activeTools(true).map(t => t.name);
        expect(names).toContain('delete_file');
    });

    it('excludes execute_code without sandbox', () => {
        localStorage.setItem('fg_sandbox_provider', 'none');
        const names = W.activeTools().map(t => t.name);
        expect(names).not.toContain('execute_code');
    });

    it('includes execute_code for worker with local sandbox', () => {
        localStorage.setItem('fg_sandbox_provider', 'local');
        const names = W.activeTools(true).map(t => t.name);
        expect(names).toContain('execute_code');
        localStorage.setItem('fg_sandbox_provider', 'none');
    });
});

// ── Search routing — performWebSearch ─────────────────────────────────────────

describe('performWebSearch routing', () => {
    beforeEach(() => localStorage.clear());

    it('auto + Tavily key → calls Tavily API (via same-origin proxy in test env)', async () => {
        // tavilySearch routes through getEffectiveProxy() when available — in jsdom the
        // origin is http://localhost so it uses /api/proxy.  The proxy envelope wraps the
        // real Tavily call; the key is passed as Authorization: Bearer, not in the body.
        localStorage.setItem('fg_search_provider', 'auto');
        localStorage.setItem('fg_tavily_key', 'tvly-test');
        window.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ results: [{ title: 'T', url: 'http://t.com', content: 'snip' }] }),
        });
        const r = await W.performWebSearch('cats');
        expect(r.source).toBe('Tavily');
        const [, opts] = window.fetch.mock.calls[0];
        const envelope = JSON.parse(opts.body);
        // Outer envelope targets Tavily
        expect(envelope.url).toBe('https://api.tavily.com/search');
        // Key forwarded as Authorization header (not in body)
        expect(envelope.headers['Authorization']).toBe('Bearer tvly-test');
        // Inner body carries the query
        const inner = JSON.parse(envelope.body);
        expect(inner.query).toBe('cats');
    });

    it('auto + no keys → falls back to Wikipedia', async () => {
        localStorage.setItem('fg_search_provider', 'auto');
        window.fetch
            .mockResolvedValueOnce({ ok: true, json: async () => [null, ['Cat'], [], []] })
            .mockResolvedValueOnce({ ok: true, json: async () => ({
                title: 'Cat', extract: 'A mammal.',
                content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Cat' } }
            }) });
        const r = await W.performWebSearch('cats');
        expect(r.source).toBe('Wikipedia');
    });

    it('auto + proxy but no Tavily key → calls Brave proxy', async () => {
        localStorage.setItem('fg_search_provider', 'auto');
        localStorage.removeItem('fg_tavily_key');
        localStorage.setItem('fg_search_proxy', 'https://proxy.example.com');
        window.fetch.mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
        await W.performWebSearch('dogs');
        const callUrl = window.fetch.mock.calls[0][0];
        expect(callUrl).toMatch(/^https:\/\/proxy\.example\.com/);
    });

    it('explicit "wikipedia" → calls Wikipedia', async () => {
        localStorage.setItem('fg_search_provider', 'wikipedia');
        window.fetch
            .mockResolvedValueOnce({ ok: true, json: async () => [null, ['Dog'], [], []] })
            .mockResolvedValueOnce({ ok: true, json: async () => ({
                title: 'Dog', extract: 'A pet.',
                content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Dog' } }
            }) });
        const r = await W.performWebSearch('dogs');
        expect(r.source).toBe('Wikipedia');
    });

    it('explicit "tavily" without key → error', async () => {
        localStorage.setItem('fg_search_provider', 'tavily');
        localStorage.removeItem('fg_tavily_key');
        const r = await W.performWebSearch('q');
        expect(r).toHaveProperty('error');
    });

    it('explicit "brave" without proxy → error', async () => {
        localStorage.setItem('fg_search_provider', 'brave');
        localStorage.removeItem('fg_search_proxy');
        const r = await W.performWebSearch('q');
        expect(r).toHaveProperty('error');
    });
});

// ── tavilySearch ─────────────────────────────────────────────────────────────

describe('tavilySearch', () => {
    it('returns error when no key configured', async () => {
        localStorage.removeItem('fg_tavily_key');
        const r = await W.tavilySearch('query');
        expect(r).toHaveProperty('error');
    });

    it('POSTs to Tavily with correct payload (via proxy envelope)', async () => {
        // In jsdom getEffectiveProxy() returns the same-origin /api/proxy, so tavilySearch
        // wraps the call in a proxy envelope.  Key goes in Authorization, inner body
        // carries the Tavily-specific fields.
        localStorage.setItem('fg_tavily_key', 'tvly-xyz');
        window.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ results: [{ title: 'X', url: 'http://x.com', content: 'snip' }] }),
        });
        const r = await W.tavilySearch('best pizza');
        expect(r.source).toBe('Tavily');
        expect(r.results[0].title).toBe('X');
        const envelope = JSON.parse(window.fetch.mock.calls[0][1].body);
        expect(envelope.url).toBe('https://api.tavily.com/search');
        expect(envelope.headers['Authorization']).toBe('Bearer tvly-xyz');
        const inner = JSON.parse(envelope.body);
        expect(inner.query).toBe('best pizza');
        expect(inner.search_depth).toBe('basic');
        expect(inner.max_results).toBe(5);
    });

    it('returns error on HTTP failure', async () => {
        localStorage.setItem('fg_tavily_key', 'tvly-xyz');
        window.fetch.mockResolvedValue({ ok: false, status: 401 });
        const r = await W.tavilySearch('q');
        expect(r.error).toContain('401');
    });

    it('truncates snippet to 400 chars', async () => {
        localStorage.setItem('fg_tavily_key', 'tvly-xyz');
        window.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ results: [{ title: 'T', url: 'http://t.com', content: 'x'.repeat(600) }] }),
        });
        const r = await W.tavilySearch('q');
        expect(r.results[0].snippet.length).toBeLessThanOrEqual(400);
    });
});

// ── braveSearch ───────────────────────────────────────────────────────────────

describe('braveSearch', () => {
    it('returns error when no proxy configured', async () => {
        localStorage.removeItem('fg_search_proxy');
        const r = await W.braveSearch('query');
        expect(r).toHaveProperty('error');
    });

    it('calls proxy with encoded query', async () => {
        localStorage.setItem('fg_search_proxy', 'https://proxy.example.com');
        localStorage.removeItem('fg_brave_key');
        window.fetch.mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
        await W.braveSearch('my query');
        const url = window.fetch.mock.calls[0][0];
        expect(url).toContain('q=my%20query');
    });

    it('sends X-Brave-Key header when key is set', async () => {
        localStorage.setItem('fg_search_proxy', 'https://proxy.example.com');
        localStorage.setItem('fg_brave_key', 'BSA-testkey');
        window.fetch.mockResolvedValue({ ok: true, json: async () => ({}) });
        await W.braveSearch('test');
        const headers = window.fetch.mock.calls[0][1].headers;
        expect(headers['X-Brave-Key']).toBe('BSA-testkey');
    });

    it('does not send X-Brave-Key when key is empty', async () => {
        localStorage.setItem('fg_search_proxy', 'https://proxy.example.com');
        localStorage.removeItem('fg_brave_key');
        window.fetch.mockResolvedValue({ ok: true, json: async () => ({}) });
        await W.braveSearch('test');
        const headers = window.fetch.mock.calls[0][1].headers;
        expect(headers['X-Brave-Key']).toBeUndefined();
    });

    it('returns error on HTTP failure', async () => {
        localStorage.setItem('fg_search_proxy', 'https://proxy.example.com');
        window.fetch.mockResolvedValue({ ok: false, status: 429 });
        const r = await W.braveSearch('test');
        expect(r.error).toContain('429');
    });
});

// ── wikipediaSearch ───────────────────────────────────────────────────────────

describe('wikipediaSearch', () => {
    it('returns results from Wikipedia API', async () => {
        window.fetch
            .mockResolvedValueOnce({ ok: true, json: async () => [null, ['Cat'], [], []] })
            .mockResolvedValueOnce({ ok: true, json: async () => ({
                title: 'Cat', extract: 'A domestic animal.',
                content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Cat' } }
            }) });
        const r = await W.wikipediaSearch('cat');
        expect(r.source).toBe('Wikipedia');
        expect(r.results[0].title).toBe('Cat');
        expect(r.results[0].snippet).toContain('domestic');
    });

    it('returns empty results array when no titles found', async () => {
        window.fetch.mockResolvedValueOnce({ ok: true, json: async () => [null, [], [], []] });
        const r = await W.wikipediaSearch('xyzzyquux');
        expect(r.source).toBe('Wikipedia');
        expect(r.results).toEqual([]);
    });

    it('returns error on HTTP failure', async () => {
        window.fetch.mockResolvedValueOnce({ ok: false, status: 503 });
        const r = await W.wikipediaSearch('q');
        expect(r).toHaveProperty('error');
    });
});

// ── saveCheckpoint ────────────────────────────────────────────────────────────
// saveCheckpoint lives in agent-core.js which requires a full browser env to load.
// Mark all four tests as todo until agent-core.js can be stubbed in setup.js.

describe('saveCheckpoint', () => {
    it.todo('returns a non-empty string ID');
    it.todo('stores checkpoint data in localStorage');
    it.todo('adds ID to checkpoint list');
    it.todo('caps checkpoint list at 50 and removes oldest');
});

// ── withRetry ─────────────────────────────────────────────────────────────────

describe('withRetry', () => {
    it('returns result immediately on success', async () => {
        const fn = vi.fn(async () => 'ok');
        expect(await W.withRetry(fn)).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does not retry non-transient errors', async () => {
        const fn = vi.fn(async () => { throw new Error('HTTP 400 Bad Request'); });
        await expect(W.withRetry(fn)).rejects.toThrow('HTTP 400');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries transient errors and succeeds', async () => {
        vi.useFakeTimers();
        let calls = 0;
        const fn = vi.fn(async () => {
            if (++calls < 3) throw new Error('HTTP 503');
            return 'done';
        });
        const promise = W.withRetry(fn);
        await vi.runAllTimersAsync();
        expect(await promise).toBe('done');
        expect(fn).toHaveBeenCalledTimes(3);
        vi.useRealTimers();
    });

    it('throws after exhausting max retries', async () => {
        vi.useFakeTimers();
        const fn = vi.fn(async () => { throw new Error('HTTP 500'); });
        // maxAttempts=3 → attempt 0,1,2 → fn called 3 times, throws after attempt 2
        const promise = W.withRetry(fn, undefined, 3);
        const assertion = expect(promise).rejects.toThrow('HTTP 500');
        await vi.runAllTimersAsync();
        await assertion;
        expect(fn).toHaveBeenCalledTimes(3);
        vi.useRealTimers();
    });

    it('calls onRetry callback with attempt index and error', async () => {
        vi.useFakeTimers();
        const retries = [];
        const fn = vi.fn(async () => { throw new Error('HTTP 502'); });
        const onRetry = (n, e) => retries.push({ n, msg: e.message });
        // maxAttempts=2 → attempt 0 retries once (onRetry called), attempt 1 throws
        const promise = W.withRetry(fn, onRetry, 2);
        const assertion = expect(promise).rejects.toThrow();
        await vi.runAllTimersAsync();
        await assertion;
        expect(retries).toHaveLength(1);
        expect(retries[0].n).toBe(0);
        expect(retries[0].msg).toContain('502');
        vi.useRealTimers();
    });
});
