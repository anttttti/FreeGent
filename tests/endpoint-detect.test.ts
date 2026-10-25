import { detectEndpoint, explainDetectError } from '../endpoint-detect.js';

const json = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body }) as any;
const server = (routes: Record<string, any>) => (async (url: any) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    if (!(path in routes)) return json({}, 404);
    return json(routes[path]);
}) as any;

describe('detectEndpoint', () => {
    it('recognises vLLM from max_model_len and reads the context window', async () => {
        const r = await detectEndpoint('http://h:8000/v1', '', { fetch: server({ '/v1/models': { data: [{ id: 'Qwen/Qwen3-32B', max_model_len: 32768 }] } }) });
        expect(r).toMatchObject({ ok: true, server: 'vLLM', apiFormat: 'vllm', models: [{ id: 'Qwen/Qwen3-32B', contextK: 32 }] });
    });
    it('recognises Ollama and takes the context from /api/show', async () => {
        const r = await detectEndpoint('http://h:11434', '', { fetch: server({
            '/v1/models': { data: [{ id: 'llama3.2' }] }, '/api/tags': { models: [{}] },
            '/api/show': { model_info: { 'llama.context_length': 131072 } } }) });
        expect(r).toMatchObject({ ok: true, server: 'Ollama', apiFormat: 'ollama', models: [{ id: 'llama3.2', contextK: 128 }] });
    });
    it('recognises LM Studio and llama.cpp', async () => {
        const lm = await detectEndpoint('http://h:1234/v1', '', { fetch: server({ '/v1/models': { data: [{ id: 'm' }] }, '/api/v0/models': { data: [{ id: 'm', max_context_length: 8192 }] } }) });
        expect(lm).toMatchObject({ server: 'LM Studio', models: [{ contextK: 8 }] });
        const lc = await detectEndpoint('http://h:8080/v1', '', { fetch: server({ '/v1/models': { data: [{ id: 'm' }] }, '/props': { default_generation_settings: { n_ctx: 4096 } } }) });
        expect(lc).toMatchObject({ server: 'llama.cpp', models: [{ contextK: 4 }] });
    });
    it('falls back to plain OpenAI-compatible and sends the key', async () => {
        let auth = '';
        const f = (async (url: any, init: any) => { auth = init.headers.Authorization; return String(url).endsWith('/v1/models') ? json({ data: [{ id: 'x' }] }) : json({}, 404); }) as any;
        const r = await detectEndpoint('http://h/v1/', 'sk-1', { fetch: f });
        expect(r).toMatchObject({ ok: true, server: 'OpenAI-compatible', apiFormat: 'openai' });
        expect(auth).toBe('Bearer sk-1');
    });
    it('explains failures', async () => {
        expect((await detectEndpoint('http://h/v1', '', { fetch: (async () => json({}, 401)) as any })).error).toMatch(/key/);
        expect((await detectEndpoint('http://h/v1', '', { fetch: (async () => json({ data: [] })) as any })).error).toMatch(/no models/);
        expect((await detectEndpoint('nonsense', '', {})).error).toMatch(/http/);
        expect(explainDetectError(new TypeError('x'), 'http://192.168.1.5:8000/v1', 'https:')).toMatch(/mixed content/);
        expect(explainDetectError(new TypeError('x'), 'http://localhost:8000/v1', 'https:')).toMatch(/CORS/);
    });
});
