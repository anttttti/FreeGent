// The "Ollama" API format of a custom model (codex campaign 7, cases 039-040): its requests must go to an endpoint whose
// reply FreeGent can read, i.e. Ollama's OpenAI-compatible /v1/chat/completions, not the native /api/chat.
const W = globalThis as any;
let router: any;
beforeAll(async () => { await import('../config.ts'); router = await import('../model-router.ts'); });
beforeEach(() => localStorage.clear());

const endpointFor = (url: string, apiFormat?: string) => {
    localStorage.setItem('fg_custom_models', JSON.stringify([{ provider: 'custom', model: 'qwen-t', name: 'Q', contextK: 32, url, ...(apiFormat ? { apiFormat } : {}) }]));
    return router.specToEndpoint('custom|qwen-t');
};

describe('custom model API format', () => {
    it('Ollama format posts to /v1/chat/completions, whichever address form was typed', () => {
        for (const u of ['http://localhost:11434', 'http://localhost:11434/', 'http://localhost:11434/api', 'http://localhost:11434/v1'])
            expect(endpointFor(u, 'ollama').url, u).toBe('http://localhost:11434/v1/chat/completions');
    });
    it('the default format is unchanged', () => {
        expect(endpointFor('http://localhost:8000/v1').url).toBe('http://localhost:8000/v1/chat/completions');
        expect(endpointFor('http://localhost:8000/v1', 'vllm').provider).toBe('vllm');
    });
});
