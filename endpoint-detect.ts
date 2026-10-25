// Detects what an OpenAI-compatible model server is: its models, its API flavour and the context window, so that the
// Settings → Models forms need not be filled in by hand. One address and key go in; nothing is scanned.

export interface DetectedModel { id: string; contextK?: number }
export interface DetectResult {
    ok: boolean;
    models: DetectedModel[];
    apiFormat: 'openai' | 'vllm' | 'ollama';
    server: string;          // 'vLLM' | 'Ollama' | 'llama.cpp' | 'LM Studio' | 'OpenAI-compatible'
    error?: string;
}

export const LOCAL_ENDPOINT_PRESETS = [
    { label: 'vLLM', url: 'http://localhost:8000/v1' },
    { label: 'Ollama', url: 'http://localhost:11434/v1' },
    { label: 'LM Studio', url: 'http://localhost:1234/v1' },
    { label: 'llama.cpp', url: 'http://localhost:8080/v1' },
];

const kOf = (tokens: any): number | undefined => {
    const n = Number(tokens);
    return Number.isFinite(n) && n > 0 ? Math.max(1, Math.round(n / 1024)) : undefined;
};

async function getJson(f: typeof fetch, url: string, headers: Record<string, string>, timeoutMs: number, init: RequestInit = {}): Promise<any> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const r = await f(url, { ...init, headers: { ...headers, ...(init.headers as any) }, signal: ctl.signal });
        if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
        return await r.json();
    } finally { clearTimeout(t); }
}

// Why a request failed, in words a person can act on.
export function explainDetectError(e: any, url: string, pageProtocol = ''): string {
    if (e?.status === 401 || e?.status === 403) return `The server refused the request (HTTP ${e.status}): an API key is needed, or the key is wrong.`;
    if (e?.status === 404) return 'Nothing answered at /models. Check the address (it usually ends in /v1).';
    if (e?.status) return `The server answered HTTP ${e.status}.`;
    if (e?.name === 'AbortError') return 'The server did not answer in time.';
    if (pageProtocol === 'https:' && /^http:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url))
        return 'The browser blocks a plain-http address from an https page (mixed content). Use https for the server, or open FreeGent over http.';
    if (/^https:\/\//i.test(url))
        return 'Could not connect over https. If the server has no TLS certificate (vLLM and llama.cpp serve plain http unless started with --ssl-keyfile/--ssl-certfile; its log then shows "Invalid HTTP request"), use http:// for localhost, or put a TLS proxy (Caddy, tailscale serve) in front.';
    return 'Could not connect. Is the server running, and does it allow this page\'s origin (CORS)? Ollama: set OLLAMA_ORIGINS.';
}

export async function detectEndpoint(rawUrl: string, key = '', opts: { fetch?: typeof fetch; timeoutMs?: number; pageProtocol?: string } = {}): Promise<DetectResult> {
    const f = opts.fetch ?? fetch;
    const timeoutMs = opts.timeoutMs ?? 6000;
    const base = rawUrl.trim().replace(/\/+$/, '');
    const fail = (error: string): DetectResult => ({ ok: false, models: [], apiFormat: 'openai', server: '', error });
    if (!/^https?:\/\//i.test(base)) return fail('Enter an address starting with http:// or https://.');
    const root = base.replace(/\/(?:v1|api)$/, '');
    const v1 = /\/v1$/.test(base) ? base : `${root}/v1`;
    const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};

    let list: any;
    try { list = await getJson(f, `${v1}/models`, headers, timeoutMs); }
    catch (e: any) { return fail(explainDetectError(e, base, opts.pageProtocol)); }
    const data: any[] = Array.isArray(list?.data) ? list.data : Array.isArray(list?.models) ? list.models : [];
    if (!data.length) return fail('The server answered, but lists no models (is a model loaded?).');
    const models: DetectedModel[] = data.map(m => ({ id: String(m.id ?? m.name ?? m.model), contextK: kOf(m.max_model_len) })).filter(m => m.id && m.id !== 'undefined');

    let server = 'OpenAI-compatible';
    let apiFormat: DetectResult['apiFormat'] = 'openai';
    if (data.some(m => m.max_model_len != null)) { server = 'vLLM'; apiFormat = 'vllm'; }
    else {
        // Ollama: its native tag list; the context of a model comes from /api/show.
        try {
            const tags = await getJson(f, `${root}/api/tags`, headers, timeoutMs);
            if (Array.isArray(tags?.models)) {
                server = 'Ollama'; apiFormat = 'ollama';
                await Promise.all(models.map(async m => {
                    try {
                        const info = await getJson(f, `${root}/api/show`, headers, timeoutMs, { method: 'POST', body: JSON.stringify({ model: m.id }), headers: { 'Content-Type': 'application/json' } });
                        const ctxKey = Object.keys(info?.model_info ?? {}).find(k => k.endsWith('.context_length'));
                        m.contextK = kOf(ctxKey ? info.model_info[ctxKey] : undefined);
                    } catch { /* the context stays unknown */ }
                }));
            }
        } catch { /* not Ollama */ }
        if (server === 'OpenAI-compatible') {
            try {
                const lm = await getJson(f, `${root}/api/v0/models`, headers, timeoutMs);
                if (Array.isArray(lm?.data)) {
                    server = 'LM Studio';
                    for (const m of models) m.contextK = kOf(lm.data.find((x: any) => x.id === m.id)?.max_context_length) ?? m.contextK;
                }
            } catch { /* not LM Studio */ }
        }
        if (server === 'OpenAI-compatible') {
            try {
                const props = await getJson(f, `${root}/props`, headers, timeoutMs);
                const n = props?.default_generation_settings?.n_ctx ?? props?.n_ctx;
                if (n != null) { server = 'llama.cpp'; for (const m of models) m.contextK = kOf(n); }
            } catch { /* not llama.cpp */ }
        }
    }
    return { ok: true, models, apiFormat, server };
}
