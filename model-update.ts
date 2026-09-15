// model-update.ts — FreeGent: check provider APIs for new/removed free models
// and show a diff-style approval modal so the user can update the catalog.
//
// Invoked via:
//   • /model-update slash command (agent-core.ts handles it like /compact)
//   • "Check for updates" button in Settings → Models

// ── Proxy helpers ─────────────────────────────────────────────────────────

// GET via the same-origin Node.js proxy — avoids CORS and hides the key from the network tab.
async function _proxyGet(url: string): Promise<any> {
    const resp = await fetch(`/api/proxy?url=${encodeURIComponent(url)}`, {
        signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    return resp.json().catch(() => null);
}

// GET-via-POST-proxy — for providers that require Bearer auth (blocked by CORS in browser).
async function _proxyBearer(url: string, key: string): Promise<any> {
    if (!key) return null;
    const resp = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, method: 'GET', headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' } }),
        signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    return resp.json().catch(() => null);
}

// Like _proxyBearer but works without a key (adds Bearer only when key is provided).
// Used for providers that allow anonymous model discovery (e.g. Kilo /models endpoint).
async function _proxyFetch(url: string, key?: string): Promise<any> {
    const hdrs: Record<string, string> = { 'Accept': 'application/json' };
    if (key) hdrs['Authorization'] = `Bearer ${key}`;
    const resp = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, method: 'GET', headers: hdrs }),
        signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    return resp.json().catch(() => null);
}

// ── Types and filter definitions ──────────────────────────────────────────

type ModelEntry = { provider: string; model: string; label: string; note?: string; contextK?: number };
type LiveModel   = { id: string; name?: string; created?: number };  // created = Unix seconds

// Reasons a model can be hidden by a filter. Each maps to one toggle chip in the modal.
type FilterKey = 'non-chat' | 'preview' | 'low-quota' | 'too-old' | 'no-tools';

// Result from each fetcher: models that pass all filters, and models that were rejected with a reason.
type FetchResult = {
    live:     LiveModel[];
    rejected: { model: LiveModel; reason: FilterKey }[];
};

type Proposal = {
    type:       'add' | 'remove';
    provider:   string;
    model:      string;
    label:      string;
    note:       string;
    url:        string;           // link to provider's model page
    spec:       string;           // "provider|model"
    selected:   boolean;
    filteredBy?: FilterKey;       // undefined = visible by default; set = hidden when that filter is active
    cooldownMs?: number;          // per-model cooldown override (e.g. 604800000 for weekly-quota free tiers)
};

// Metadata for the filter toggle chips shown in the modal — order is display order.
const _FILTER_META: { key: FilterKey; label: string; title: string }[] = [
    { key: 'low-quota', label: 'Low quota',   title: 'Models with near-zero free-tier quota (e.g. rpm:10, rpd:500) — usable only on paid plans' },
    { key: 'preview',   label: 'Preview',     title: 'Unstable preview and experimental variants' },
    { key: 'too-old',   label: '>1 yr old',   title: 'Models released more than a year ago' },
    { key: 'non-chat',  label: 'Non-chat',    title: 'Embedding, TTS, image-gen, audio, and other non-conversation models' },
];

// ── Provider fetchers ─────────────────────────────────────────────────────

async function _fetchOpenRouterModels(): Promise<{ id: string; name: string; pricing: any; created?: number }[]> {
    try {
        // OpenRouter has CORS headers — direct browser fetch works
        const resp = await fetch('https://openrouter.ai/api/v1/models', {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(15_000),
        });
        if (!resp.ok) return [];
        const json = await resp.json();
        const all: any[] = Array.isArray(json?.data) ? json.data : [];
        // Keep only text-out, tool-capable, non-router models
        return all.filter((m: any) => {
            const arch = m.architecture ?? {};
            const outMods: string[] = arch.output_modalities ?? ['text'];
            const params: string[] = m.supported_parameters ?? [];
            return (
                outMods.includes('text') &&
                !outMods.includes('audio') &&
                params.includes('tools') &&
                arch.tokenizer !== 'Router'
            );
        });
    } catch {
        return [];
    }
}

// Free models on OpenCode Zen as listed at https://opencode.ai/docs/zen#pricing
// (updated 2026-08-31). Models with a "-free" suffix are also accepted as a
// forward-compatible heuristic — new free models may follow the same convention.
const _OPENCODE_ZEN_FREE = new Set([
    'big-pickle',
    'mimo-v2.5-free',
    'ling-3.0-flash-fin-free',
    'nemotron-3-ultra-free',
    'nemotron-3.5-lightning-free',
    'muse-spark-1.2-contributor-free',
    'laguna-s-2.1-free',
    'deepseek-v4-flash-free',
]);

async function _fetchOpenCodeModels(): Promise<FetchResult> {
    try {
        const key = typeof getOpenCodeKey === 'function' ? getOpenCodeKey() : (localStorage.getItem('fg_opencode_key') ?? '');
        // 'public' is the sentinel key OpenCode itself sends for unauthenticated access
        // to free Zen models. '__nokey__' is unrecognized and may land in a worse bucket.
        const json = await _proxyBearer('https://opencode.ai/zen/v1/models', key || 'public');
        if (!json) return { live: [], rejected: [] };
        const all: any[] = Array.isArray(json?.data) ? json.data : [];
        // Only accept the exact IDs confirmed free in the pricing table.
        const live: LiveModel[] = all
            .filter((m: any) => typeof m.id === 'string' && _OPENCODE_ZEN_FREE.has(m.id))
            .map((m: any) => ({ id: m.id as string, created: m.created as number | undefined }));
        return { live, rejected: [] };
    } catch {
        return { live: [], rejected: [] };
    }
}

// ── TokenHarbor ──────────────────────────────────────────────────────────────
// Free models on TokenHarbor as listed at https://tokenharbor.ai/models (updated 2026-09-01).
// IDs have a `:free` suffix; no provider prefix in the model ID.
const _TOKENHARBOR_FREE = new Set([
    'deepseek-v4-flash:free',
    'mimo-v2.5:free',
]);

async function _fetchTokenHarborModels(): Promise<FetchResult> {
    try {
        const key = typeof getTokenHarborKey === 'function' ? getTokenHarborKey() : (localStorage.getItem('fg_tokenharbor_key') ?? '');
        if (!key) return { live: [], rejected: [] };
        const json = await _proxyBearer('https://tokenharbor.ai/v1/models', key);
        if (!json) return { live: [], rejected: [] };
        const all: any[] = Array.isArray(json?.data) ? json.data : [];
        // Only accept models explicitly in the known-free allowlist (`:free` suffix).
        const live: LiveModel[] = all
            .filter((m: any) => typeof m.id === 'string' && _TOKENHARBOR_FREE.has(m.id))
            .map((m: any) => ({ id: m.id as string, created: m.created as number | undefined }));
        return { live, rejected: [] };
    } catch {
        return { live: [], rejected: [] };
    }
}

// ── Kilo ─────────────────────────────────────────────────────────────────────
// https://kilo.ai — OpenAI-compatible gateway; :free models work without any API key
// (anonymous, 200 req/hour/IP). Authenticated users get the same free models plus more.
// The /models endpoint is public; filter by isFree===true for the free tier.
// Exclude: router meta-models (kilo-auto/*, openrouter/*), no-tools models, domain-specialist ones.
const _KILO_EXCLUDED = new Set([
    'kilo-auto/free', 'kilo-auto/frontier', 'kilo-auto/balanced', 'kilo-auto/fast',
    'openrouter/free',
    'nvidia/nemotron-3.5-content-safety:free', // no tool support
    'inclusionai/ling-3.0-flash-sante:free',   // healthcare-specific
    'inclusionai/ling-3.0-flash-fin:free',     // finance-specific
    'liquid/lfm-2.5-2.6b:free',                // tiny model, 65K ctx — not useful as agent
]);

async function _fetchKiloModels(): Promise<FetchResult> {
    try {
        const key = typeof getKiloKey === 'function' ? getKiloKey() : (localStorage.getItem('fg_kilo_key') ?? '');
        // The /models endpoint is public — no key needed. Include key if available for completeness.
        const json = await _proxyFetch('https://api.kilo.ai/api/gateway/models', key || undefined);
        if (!json) return { live: [], rejected: [] };
        const all: any[] = Array.isArray(json?.data) ? json.data : [];
        const live: LiveModel[] = all
            .filter((m: any) =>
                typeof m.id === 'string' &&
                m.isFree === true &&
                !_KILO_EXCLUDED.has(m.id)
            )
            .map((m: any) => ({ id: m.id as string, name: m.name as string | undefined, created: m.created as number | undefined }));
        return { live, rejected: [] };
    } catch {
        return { live: [], rejected: [] };
    }
}

// ── Vercel AI Gateway ─────────────────────────────────────────────────────────
// https://vercel.com/ai-gateway — OAI-compatible gateway requiring an API key.
// Free models carry tags:["free"] and pricing {input:"0",output:"0"}.
// The aggregate /models list sometimes omits free models, so we probe each known
// free ID individually as a fallback if the list returns nothing tagged "free".
//
// Routing: tool-use ✓ AND not domain-specialist → live
//          domain-specialist (InclusionAI) → rejected "domain-specific"
//          no tool-use (Perplexity Sonar, web-search-only) → rejected "no-tools"
const _VERCEL_FREE_IDS = [
    'poolside/laguna-s-2.1-free',
    'perplexity/sonar',
    'perplexity/sonar-pro',
    'perplexity/sonar-reasoning-pro',
    'inclusionai/ling-3.0-flash-fin',
    'inclusionai/ling-3.0-flash-sante',
];
// Tool-capable but narrow-domain training — opt-in via 'domain-specific' filter chip.
const _VERCEL_DOMAIN_SPECIFIC = new Set([
    'inclusionai/ling-3.0-flash-fin',
    'inclusionai/ling-3.0-flash-sante',
]);

async function _fetchVercelModels(): Promise<FetchResult> {
    try {
        // Primary: scan the aggregate list for models tagged "free".
        // The list endpoint is public (no auth required).
        const listJson = await _proxyFetch('https://ai-gateway.vercel.sh/v1/models');
        const listAll: any[] = Array.isArray(listJson?.data) ? listJson.data : [];
        const listFree = listAll.filter((m: any) =>
            typeof m.id === 'string' &&
            m.type === 'language' &&
            Array.isArray(m.tags) && m.tags.includes('free')
        );

        // Fallback: the aggregate endpoint sometimes omits free models.
        // Probe each known free ID individually and collect what's alive.
        const toProcess: any[] = listFree.length > 0 ? listFree : await (async () => {
            const results = await Promise.allSettled(
                _VERCEL_FREE_IDS.map(id => _proxyFetch(`https://ai-gateway.vercel.sh/v1/models/${id}`))
            );
            return results.flatMap(r => (r.status === 'fulfilled' && r.value?.id ? [r.value] : []));
        })();

        const live: LiveModel[] = [];
        const rejected: { model: LiveModel; reason: FilterKey }[] = [];
        for (const m of toProcess) {
            if (!m.id || m.type !== 'language') continue;
            const lm: LiveModel = { id: m.id as string, name: m.name as string | undefined, created: m.created as number | undefined };
            const hasTool = Array.isArray(m.tags) && m.tags.includes('tool-use');
            if (_VERCEL_DOMAIN_SPECIFIC.has(m.id)) {
                rejected.push({ model: lm, reason: 'non-chat' }); // narrow-domain specialists → treat as non-chat
            } else if (hasTool) {
                live.push(lm);
            } else {
                rejected.push({ model: lm, reason: 'no-tools' });
            }
        }
        return { live, rejected };
    } catch {
        return { live: [], rejected: [] };
    }
}

// Non-chat Google patterns (TTS, image-gen, music, robotics, research agents, omni/audio, custom-tools)
const _GOOGLE_EXCL_NONCHAT = /tts|transcrib|[-/]image\b|-image$|^lyria|robotics|deep[_-]research|computer[_-]use|antigravity|[-/]omni|embed|-customtools/i;
// Unstable preview / experimental variants (separate so it toggles independently)
const _GOOGLE_EXCL_PREVIEW  = /-preview\b/i;

// Google models explicitly removed from the catalog and must not be re-proposed.
// Key: removed because free-tier quota is near-zero (rpm:10, rpd:500 — effectively unusable).
// Also covers floating "-latest" version aliases that duplicate versioned catalog entries.
const _GOOGLE_SKIP = new Set([
    // Low free quota (rpm:10, rpd:500)
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    // Floating version aliases — already represented by versioned entries in the catalog
    'gemini-flash-latest',
    'gemini-flash-lite-latest',
    'gemini-pro-latest',
]);

async function _fetchGoogleModels(): Promise<FetchResult> {
    try {
        const key = typeof getGeminiKey === 'function' ? getGeminiKey() : (localStorage.getItem('fg_gemini_key') ?? '');
        if (!key) return { live: [], rejected: [] };
        // Google uses API key as query param — GET proxy keeps it server-side
        const json = await _proxyGet(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`
        );
        if (!json) return { live: [], rejected: [] };
        const models: any[] = json?.models ?? [];

        const live: LiveModel[] = [];
        const rejected: { model: LiveModel; reason: FilterKey }[] = [];

        for (const m of models) {
            const id = (m.name ?? '').replace(/^models\//, '');
            // Only gemini-* or gemma-* prefixes are general chat/completion models
            if (!/^gemini-|^gemma-/.test(id)) continue;
            // Must support generateContent (chat-style generation)
            if (!Array.isArray(m.supportedGenerationMethods) || !m.supportedGenerationMethods.includes('generateContent')) continue;

            const lm: LiveModel = { id, name: m.displayName ?? m.name };

            if (_GOOGLE_SKIP.has(id)) {
                rejected.push({ model: lm, reason: 'low-quota' });
            } else if (_GOOGLE_EXCL_PREVIEW.test(id)) {
                rejected.push({ model: lm, reason: 'preview' });
            } else if (_GOOGLE_EXCL_NONCHAT.test(id)) {
                rejected.push({ model: lm, reason: 'non-chat' });
            } else {
                live.push(lm);
            }
        }
        return { live, rejected };
    } catch {
        return { live: [], rejected: [] };
    }
}

// Non-chat / alias Mistral model patterns:
//   non-chat: embeddings, OCR, moderation, audio I/O (voxtral), FIM, CLI tools, labs experiments
//   aliases:  -latest suffix creates floating duplicates of date-versioned catalog entries
const _MISTRAL_EXCL = /-embed|-ocr|-moderation|^labs-|vibe-cli|code-agent|-fim|-realtime|-transcribe|-tts\b|^voxtral|-latest$/i;

// ── Alias deduplication ───────────────────────────────────────────────────
// Mistral (and some other providers) expose the same model under multiple IDs:
//   semantic version:  mistral-medium-3.5
//   date snapshot:     mistral-medium-2604  (year 26, month 04)
//   plain version:     mistral-medium-3
//   bare name:         mistral-medium
// Strip the version suffix to get a base name, group by base, then keep only
// the catalog-known ID (or the "best" representative when nothing is catalogued yet).

// Strip Mistral-style version suffixes to get the base model name.
// Applied in order so compound suffixes like "-3.5" don't partially match "-\d+$".
function _aliasBase(id: string): string {
    return id
        .replace(/-\d{2}(0[1-9]|1[0-2])$/, '')   // YYMM date: -2604, -2508, -2501 …
        .replace(/-\d+\.\d+$/, '')                  // X.Y semantic: -3.5, -2.1 …
        .replace(/-\d+$/, '');                       // X plain: -3, -2 …
}

// Among a group of alias IDs, pick the canonical one when none is already in the catalog.
// Preference: semantic (X.Y) > plain (X) > date (YYMM) > bare; newest first within each tier.
function _aliasBest(ids: string[]): string {
    const tier = (id: string) =>
        /\d+\.\d+$/.test(id) ? 0 :
        /-\d{2}(0[1-9]|1[0-2])$/.test(id) ? 2 :
        /-\d+$/.test(id) ? 1 : 3;

    return [...ids].sort((a, b) => {
        const dt = tier(a) - tier(b);
        return dt !== 0 ? dt : b.localeCompare(a);   // same tier → lexicographically newer first
    })[0];
}

// Deduplicate a FetchResult by base name.
// For each base-name group, keep only the catalog-preferred ID in `live`;
// silently drop the aliases (they won't appear even with filters turned off,
// since they add zero information beyond the representative).
// Rejected models are left untouched — they're hidden by default anyway.
function _dedupAliases(result: FetchResult, provider: string, catalogKeys: Set<string>): FetchResult {
    if (result.live.length <= 1) return result;

    // Map base → all live IDs sharing that base
    const byBase = new Map<string, string[]>();
    for (const m of result.live) {
        const base = _aliasBase(m.id);
        (byBase.get(base) ?? (byBase.set(base, []), byBase.get(base)!)).push(m.id);
    }

    // Determine which IDs survive deduplication
    const keepIds = new Set<string>();
    for (const [, ids] of byBase) {
        if (ids.length === 1) {
            keepIds.add(ids[0]);
            continue;
        }
        // Multiple IDs share this base — pick the catalog entry if one exists, else best
        const catalogHit = ids.find(id => catalogKeys.has(`${provider}|${id}`));
        keepIds.add(catalogHit ?? _aliasBest(ids));
    }

    return { live: result.live.filter(m => keepIds.has(m.id)), rejected: result.rejected };
}

async function _fetchMistralModels(): Promise<FetchResult> {
    try {
        const key = typeof getMistralKey === 'function' ? getMistralKey() : (localStorage.getItem('fg_mistral_key') ?? '');
        if (!key) return { live: [], rejected: [] };
        const json = await _proxyBearer('https://api.mistral.ai/v1/models', key);
        if (!json) return { live: [], rejected: [] };
        const data: any[] = json?.data ?? [];

        const live: LiveModel[] = [];
        const rejected: { model: LiveModel; reason: FilterKey }[] = [];

        for (const m of data) {
            if (m.archived) continue;
            const lm: LiveModel = { id: m.id as string, name: m.id as string, created: m.created as number | undefined };
            if (m.capabilities?.completion_chat === false || _MISTRAL_EXCL.test(m.id)) {
                rejected.push({ model: lm, reason: 'non-chat' });
            } else {
                live.push(lm);
            }
        }
        return { live, rejected };
    } catch {
        return { live: [], rejected: [] };
    }
}

// Non-chat Groq model patterns: speech transcription, safety classifiers, TTS, meta-routers
const _GROQ_EXCL = /^whisper|prompt-guard|canopylabs\/orpheus|^groq\/compound|safeguard/i;

async function _fetchGroqModels(): Promise<FetchResult> {
    try {
        const key = typeof getGroqKey === 'function' ? getGroqKey() : (localStorage.getItem('fg_groq_key') ?? '');
        if (!key) return { live: [], rejected: [] };
        const json = await _proxyBearer('https://api.groq.com/openai/v1/models', key);
        if (!json) return { live: [], rejected: [] };
        const data: any[] = json?.data ?? [];

        const live: LiveModel[] = [];
        const rejected: { model: LiveModel; reason: FilterKey }[] = [];

        for (const m of data) {
            const lm: LiveModel = { id: m.id as string, name: m.id as string, created: m.created as number | undefined };
            if (_GROQ_EXCL.test(m.id)) {
                rejected.push({ model: lm, reason: 'non-chat' });
            } else {
                live.push(lm);
            }
        }
        return { live, rejected };
    } catch {
        return { live: [], rejected: [] };
    }
}

async function _fetchCerebrasModels(): Promise<FetchResult> {
    try {
        const key = typeof getCerebrasKey === 'function' ? getCerebrasKey() : (localStorage.getItem('fg_cerebras_key') ?? '');
        if (!key) return { live: [], rejected: [] };
        const json = await _proxyBearer('https://api.cerebras.ai/v1/models', key);
        if (!json) return { live: [], rejected: [] };
        const data: any[] = json?.data ?? [];
        const live = data.map((m: any) => ({ id: m.id as string, name: m.id as string, created: m.created as number | undefined }));
        return { live, rejected: [] };
    } catch {
        return { live: [], rejected: [] };
    }
}

// Non-chat / deprecated / duplicated NVIDIA NIM model patterns.
// Covers: embeddings, safety guards, transcription, vision-only, retrieval, translation,
// parsing, old deprecated model generations, specialised domain models, and models that
// are already available for free via another provider in the catalog.
const _NVIDIA_EXCL = new RegExp(
    // Non-chat capabilities
    'embed|guard|safety|whisper|retriev|translat|nvclip|neva-22b|deplot|kosmos|/vila|' +
    'detect|calibrat|reward|nemotron-parse|riva-|starcoder|codellama|phi-3-vision|' +
    'recurrentgemma|fuyu-8b|diffusiongemma|muse-glimmer|' +
    // Old / deprecated model generations
    'jamba-1\\.5|sea-lion|dbrx|deepseek-coder-6\\.7b|codegemma|' +
    'granite-3\\.0-|granite-34b|granite-8b-code|palmyra|arctic-embed|' +
    'zamba2|llama2\\b|llama-prompt-guard|phi-3\\.5-moe|vlm-embed|nv-embedqa|' +
    'nemotron-embed|chatqa|cosmos-reason2|ai-synthetic|ising-calibr|' +
    'nemotron-4-|llama-3\\.1-nemotron|nemotron-nano-3-|mixtral-8x22b|' +
    'mistral-nemo-minitron|nemotron-3-nano-30b-a3b|nemotron-3\\.5-lightning-30b|' +
    // Old model families from other providers served via NIM (outdated)
    'mistralai/|nv-mistralai/|01-ai/|' +
    // Old small Gemma and Gemma 3 (superseded by Gemma 4 in catalog)
    'google/gemma-2b|google/gemma-3-|' +
    // Old Llama 3.2 (superseded; vision-instruct variants are large/outdated)
    'meta/llama-3\\.2-|' +
    // Models already in catalog via OpenRouter (free) or Groq (free)
    'openai/gpt-oss-|laguna-xs',
    'i'
);

async function _fetchNvidiaModels(): Promise<FetchResult> {
    try {
        const key = typeof getNvidiaKey === 'function' ? getNvidiaKey() : (localStorage.getItem('fg_nvidia_key') ?? '');
        if (!key) return { live: [], rejected: [] };
        const json = await _proxyBearer('https://integrate.api.nvidia.com/v1/models', key);
        if (!json) return { live: [], rejected: [] };
        const data: any[] = json?.data ?? [];

        const live: LiveModel[] = [];
        const rejected: { model: LiveModel; reason: FilterKey }[] = [];

        for (const m of data) {
            const lm: LiveModel = { id: m.id as string, name: m.id as string, created: m.created as number | undefined };
            if (_NVIDIA_EXCL.test(m.id)) {
                rejected.push({ model: lm, reason: 'non-chat' });
            } else {
                live.push(lm);
            }
        }
        return { live, rejected };
    } catch {
        return { live: [], rejected: [] };
    }
}

// Non-chat Nous Portal patterns — embeddings, image-gen, TTS, video, multimodal-gen outputs
const _NOUS_EXCL_NONCHAT = /embed|rerank|tts|speech|image.gen|video.gen|->image|->audio|->video/i;
// Preview / experimental variants
const _NOUS_EXCL_PREVIEW = /\bpreview\b|\bexperimental\b|\balpha\b|\bbeta\b/i;

async function _fetchNousModels(): Promise<FetchResult> {
    try {
        const key = typeof getNousKey === 'function' ? getNousKey() : (localStorage.getItem('fg_nous_key') ?? '');
        if (!key) return { live: [], rejected: [] };
        const json = await _proxyBearer('https://inference-api.nousresearch.com/v1/models', key);
        if (!json) return { live: [], rejected: [] };
        const all: any[] = Array.isArray(json?.data) ? json.data : [];

        const live: LiveModel[] = [];
        const rejected: { model: LiveModel; reason: FilterKey }[] = [];

        for (const m of all) {
            const id: string = m.id ?? '';
            if (!id.endsWith(':free')) continue;  // only free-tier models
            const lm: LiveModel = { id, name: m.name as string | undefined, created: m.created as number | undefined };
            const modality: string = m.architecture?.modality ?? '';
            if (_NOUS_EXCL_NONCHAT.test(id) || (modality && !modality.includes('->text'))) {
                rejected.push({ model: lm, reason: 'non-chat' });
            } else if (_NOUS_EXCL_PREVIEW.test(id)) {
                rejected.push({ model: lm, reason: 'preview' });
            } else {
                live.push(lm);
            }
        }
        return { live, rejected };
    } catch {
        return { live: [], rejected: [] };
    }
}

// ── URL generator (mirrors settings-ui.ts _modelPageUrl) ─────────────────

function _modelPageUrl(provider: string, model: string): string {
    switch (provider) {
        case 'openrouter': return `https://openrouter.ai/${model.replace(/:free$/, '')}`;
        case 'nous':       return model.includes('/')
            ? `https://openrouter.ai/${model.replace(/:free$/, '')}`
            : 'https://portal.nousresearch.com/models';
        case 'nvidia':     return `https://build.nvidia.com/${model}`;
        case 'google':
            if (model.startsWith('gemma')) return 'https://ai.google.dev/gemma/docs/gemma-models';
            return `https://ai.google.dev/gemini-api/docs/models#${model}`;
        case 'mistral': {
            const slug = model.startsWith('ministral')      ? 'ministral'
                       : model.startsWith('codestral')      ? 'codestral'
                       : model.startsWith('pixtral')        ? 'pixtral'
                       : model.startsWith('devstral')       ? 'devstral'
                       : model.startsWith('mistral-large')  ? 'mistral-large'
                       : model.startsWith('mistral-medium') ? 'mistral-medium'
                       : model.startsWith('mistral-small')  ? 'mistral-small'
                       : null;
            return slug ? `https://mistral.ai/models/${slug}/`
                        : 'https://docs.mistral.ai/getting-started/models/all-models/';
        }
        case 'groq':       return 'https://console.groq.com/docs/models';
        case 'cerebras':   return 'https://inference-docs.cerebras.ai/model-catalog';
        case 'opencode':      return 'https://opencode.ai/docs/zen/#endpoints';
        case 'tokenharbor':   return 'https://tokenharbor.ai/models';
        case 'kilo':          return 'https://kilo.ai/models';
        case 'vercel':        return 'https://vercel.com/ai-gateway/models';
        default:              return '';
    }
}

// ── Proposal computation ──────────────────────────────────────────────────

// Models with a known `created` timestamp older than this many seconds are filtered as 'too-old'.
const _ONE_YEAR_SECS = 365 * 24 * 3600;
function _isTooOld(created: number | undefined): boolean {
    if (!created) return false;   // unknown age → include (safe default)
    return created < (Date.now() / 1000) - _ONE_YEAR_SECS;
}

// Generic helper: compare a provider's live model list against the catalog.
// Produces add proposals (for new models) and remove proposals (for missing catalog models).
// Filtered/rejected models appear as add proposals with `filteredBy` set — hidden by default in UI.
// Removal proposals always use the full live+rejected set to avoid false removals.
function _diffProvider(
    provider: string,
    result: FetchResult,
    catalog: ModelEntry[],
    catalogKeys: Set<string>,
    addNote: string,
    addSelected = true,
    removeSelected = false,
): Proposal[] {
    const { live, rejected } = result;
    // Use the full set (live + rejected) for removal detection — we don't want to falsely
    // propose removing a catalog entry just because it was filtered client-side.
    const allLiveIds = new Set([
        ...live.map(m => m.id),
        ...rejected.map(r => r.model.id),
    ]);
    const out: Proposal[] = [];

    // Add proposals for unfiltered live models
    for (const m of live) {
        const spec = `${provider}|${m.id}`;
        if (catalogKeys.has(spec)) continue;
        const tooOld = _isTooOld(m.created);
        out.push({
            type: 'add', provider, model: m.id,
            label: m.name ?? m.id, note: addNote,
            url: _modelPageUrl(provider, m.id), spec,
            selected: tooOld ? false : addSelected,
            filteredBy: tooOld ? 'too-old' : undefined,
        });
    }

    // Add proposals for filtered/rejected models (visible only when their filter chip is off)
    for (const { model: m, reason } of rejected) {
        const spec = `${provider}|${m.id}`;
        if (catalogKeys.has(spec)) continue;
        out.push({
            type: 'add', provider, model: m.id,
            label: m.name ?? m.id, note: addNote,
            url: _modelPageUrl(provider, m.id), spec,
            selected: false, filteredBy: reason,
        });
    }

    // Remove proposals for catalog entries no longer seen from the API
    for (const entry of catalog) {
        if (entry.provider !== provider) continue;
        if (!allLiveIds.has(entry.model)) {
            out.push({
                type: 'remove', provider, model: entry.model,
                label: entry.label, note: `No longer listed by ${provider}`,
                url: _modelPageUrl(provider, entry.model),
                spec: `${provider}|${entry.model}`, selected: removeSelected,
            });
        }
    }

    return out;
}

async function _computeProposals(): Promise<{ proposals: Proposal[]; errors: string[] }> {
    const errors: string[] = [];
    const proposals: Proposal[] = [];

    const catalog: ModelEntry[] = typeof getAllModels === 'function' ? getAllModels() : [];
    const catalogKeys = new Set(catalog.map((m: ModelEntry) => `${m.provider}|${m.model}`));

    // Fetch all providers in parallel
    const [orModels, ocResult, googleResult, mistralResult, groqResult, cerebrasResult, nvidiaResult, thResult, kiloResult, vercelResult, nousResult] =
        await Promise.all([
            _fetchOpenRouterModels(),
            _fetchOpenCodeModels(),
            _fetchGoogleModels(),
            _fetchMistralModels(),
            _fetchGroqModels(),
            _fetchCerebrasModels(),
            _fetchNvidiaModels(),
            _fetchTokenHarborModels(),
            _fetchKiloModels(),
            _fetchVercelModels(),
            _fetchNousModels(),
        ]);

    // ── OpenRouter ────────────────────────────────────────────────────────
    if (!orModels.length) {
        errors.push('OpenRouter: could not fetch model list (network error or timeout)');
    } else {
        const orFree = orModels.filter((m: any) =>
            m.id?.endsWith(':free') ||
            (String(m.pricing?.prompt ?? '1') === '0' && String(m.pricing?.completion ?? '1') === '0')
        );
        // For removal check, compare all OR catalog entries against all OR live IDs (not just free)
        const orAllIds = new Set(orModels.map((m: any) => m.id));
        const orFreeWithName = orFree.map((m: any) => ({ id: m.id, name: m.name, created: m.created as number | undefined }));

        // Add proposals from free models not in catalog — age-filter tagged as 'too-old'
        for (const m of orFreeWithName) {
            if (!catalogKeys.has(`openrouter|${m.id}`)) {
                const tooOld = _isTooOld(m.created);
                proposals.push({
                    type: 'add', provider: 'openrouter', model: m.id,
                    label: m.name ?? m.id, note: 'Free via OpenRouter',
                    url: _modelPageUrl('openrouter', m.id),
                    spec: `openrouter|${m.id}`, selected: !tooOld,
                    filteredBy: tooOld ? 'too-old' : undefined,
                });
            }
        }
        // Remove proposals for catalog entries no longer in any OR model list
        for (const entry of catalog) {
            if (entry.provider !== 'openrouter') continue;
            if (!orAllIds.has(entry.model)) {
                proposals.push({
                    type: 'remove', provider: 'openrouter', model: entry.model,
                    label: entry.label, note: 'No longer listed by OpenRouter',
                    url: _modelPageUrl('openrouter', entry.model),
                    spec: `openrouter|${entry.model}`, selected: false,
                });
            }
        }
    }

    // ── OpenCode ─────────────────────────────────────────────────────────
    if (!ocResult.live.length) {
        errors.push('OpenCode: could not fetch model list (may require API key)');
    } else {
        proposals.push(..._diffProvider('opencode', ocResult, catalog, catalogKeys, 'Free via OpenCode Zen'));
    }

    // ── Google Gemini ─────────────────────────────────────────────────────
    {
        const total = googleResult.live.length + googleResult.rejected.length;
        if (!total) {
            const hasKey = !!(typeof getGeminiKey === 'function' ? getGeminiKey() : localStorage.getItem('fg_gemini_key'));
            if (hasKey) errors.push('Google: could not fetch model list (network error or timeout)');
            // else: no key configured — silently skip
        } else {
            proposals.push(..._diffProvider(
                'google', googleResult, catalog, catalogKeys,
                'Available via Google API — verify free quota before enabling',
            ));
        }
    }

    // ── Mistral ───────────────────────────────────────────────────────────
    {
        const total = mistralResult.live.length + mistralResult.rejected.length;
        if (!total) {
            const hasKey = !!(typeof getMistralKey === 'function' ? getMistralKey() : localStorage.getItem('fg_mistral_key'));
            if (hasKey) errors.push('Mistral: could not fetch model list (network error or timeout)');
        } else {
            // Deduplicate same-model aliases (semantic version, date snapshot, plain name)
            // by base name before diffing — keeps only the catalog-known or best representative.
            const deduped = _dedupAliases(mistralResult, 'mistral', catalogKeys);
            proposals.push(..._diffProvider('mistral', deduped, catalog, catalogKeys, 'Available on your Mistral account'));
        }
    }

    // ── Groq ──────────────────────────────────────────────────────────────
    {
        const total = groqResult.live.length + groqResult.rejected.length;
        if (!total) {
            const hasKey = !!(typeof getGroqKey === 'function' ? getGroqKey() : localStorage.getItem('fg_groq_key'));
            if (hasKey) errors.push('Groq: could not fetch model list (network error or timeout)');
        } else {
            proposals.push(..._diffProvider('groq', groqResult, catalog, catalogKeys, 'Free via Groq'));
        }
    }

    // ── Cerebras ──────────────────────────────────────────────────────────
    {
        const total = cerebrasResult.live.length + cerebrasResult.rejected.length;
        if (!total) {
            const hasKey = !!(typeof getCerebrasKey === 'function' ? getCerebrasKey() : localStorage.getItem('fg_cerebras_key'));
            if (hasKey) errors.push('Cerebras: could not fetch model list (network error or timeout)');
        } else {
            proposals.push(..._diffProvider('cerebras', cerebrasResult, catalog, catalogKeys, 'Free via Cerebras'));
        }
    }

    // ── NVIDIA NIM ────────────────────────────────────────────────────────
    {
        const total = nvidiaResult.live.length + nvidiaResult.rejected.length;
        if (!total) {
            const hasKey = !!(typeof getNvidiaKey === 'function' ? getNvidiaKey() : localStorage.getItem('fg_nvidia_key'));
            if (hasKey) errors.push('NVIDIA: could not fetch model list (network error or timeout)');
        } else {
            proposals.push(..._diffProvider(
                'nvidia', nvidiaResult, catalog, catalogKeys,
                'Available via NVIDIA NIM — check free credits',
            ));
        }
    }

    // ── TokenHarbor ───────────────────────────────────────────────────────────
    {
        if (!thResult.live.length) {
            const hasKey = !!(typeof getTokenHarborKey === 'function' ? getTokenHarborKey() : localStorage.getItem('fg_tokenharbor_key'));
            if (hasKey) errors.push('TokenHarbor: could not fetch model list (network error or timeout)');
            // else: no key configured — silently skip
        } else {
            // Patch cooldownMs onto every add proposal — free-tier models have a weekly quota
            // so the 7-day flat cooldown from the catalog must also apply to newly proposed entries.
            const thProposals = _diffProvider('tokenharbor', thResult, catalog, catalogKeys, 'Free tier via TokenHarbor; weekly quota');
            for (const p of thProposals) {
                if (p.type === 'add' && p.model.endsWith(':free')) p.cooldownMs = 604800000;
            }
            proposals.push(...thProposals);
        }
    }

    // ── Kilo ──────────────────────────────────────────────────────────────────
    {
        const total = kiloResult.live.length + kiloResult.rejected.length;
        if (!total) {
            // Kilo allows anonymous access for free models — always attempt and surface errors.
            errors.push('Kilo: could not fetch model list (network error or timeout)');
        } else {
            proposals.push(..._diffProvider(
                'kilo', kiloResult, catalog, catalogKeys,
                'Free anonymous access via Kilo (200 req/hour/IP; add Kilo key for higher limits)',
            ));
        }
    }

    // ── Vercel AI Gateway ─────────────────────────────────────────────────────
    {
        const total = vercelResult.live.length + vercelResult.rejected.length;
        const hasKey = !!(typeof getVercelKey === 'function' ? getVercelKey() : localStorage.getItem('fg_vercel_key'));
        if (!total) {
            if (hasKey) errors.push('Vercel AI Gateway: could not fetch model list (network error or timeout)');
            // else: no key configured — silently skip (key required for inference)
        } else if (hasKey) {
            proposals.push(..._diffProvider(
                'vercel', vercelResult, catalog, catalogKeys,
                'Free ($0/token) via Vercel AI Gateway; API key required',
            ));
        }
        // If we fetched models but have no key, don't propose — user can't use them yet.
    }

    // ── Nous Portal ────────────────────────────────────────────────────────────
    {
        const total = nousResult.live.length + nousResult.rejected.length;
        if (!total) {
            const hasKey = !!(typeof getNousKey === 'function' ? getNousKey() : localStorage.getItem('fg_nous_key'));
            if (hasKey) errors.push('Nous Portal: could not fetch model list (network error or timeout)');
            // else: no key configured — silently skip
        } else {
            proposals.push(..._diffProvider(
                'nous', nousResult, catalog, catalogKeys,
                'Free tier via Nous Portal (rotating monthly — verify availability)',
            ));
        }
    }

    // Remove proposals the user has previously dismissed (kept unchecked on Apply).
    const suppressed = _getSuppressedRemoves();
    return { proposals: proposals.filter(p => !(p.type === 'remove' && suppressed.has(p.spec))), errors };
}

// ── Modal UI ──────────────────────────────────────────────────────────────

function _esc(s: string): string {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function _getSuppressedRemoves(): Set<string> {
    try { return new Set(JSON.parse(localStorage.getItem('fg_suppressed_removes') || '[]')); }
    catch { return new Set(); }
}
function _saveSuppressedRemoves(s: Set<string>): void {
    localStorage.setItem('fg_suppressed_removes', JSON.stringify([...s]));
}

function _applyProposals(proposals: Proposal[]): void {
    // Record dismissals: unchecked removes are suppressed so they won't reappear;
    // checked removes are cleared from suppression (they're being applied now).
    const suppressed = _getSuppressedRemoves();
    for (const p of proposals.filter(q => q.type === 'remove')) {
        if (p.selected) suppressed.delete(p.spec);
        else suppressed.add(p.spec);
    }
    _saveSuppressedRemoves(suppressed);

    const selected = proposals.filter(p => p.selected);
    if (!selected.length) return;

    const custom: ModelEntry[] = typeof getCustomModels === 'function' ? getCustomModels() : [];
    const mainList: string[]   = typeof getActiveMainModelList === 'function' ? getActiveMainModelList() : [];

    for (const p of selected) {
        if (p.type === 'add') {
            // Check all models (built-ins + custom) to avoid duplicating a built-in entry
            const allModels: ModelEntry[] = typeof getAllModels === 'function' ? getAllModels() : custom;
            const alreadyExists = allModels.some((m: ModelEntry) => m.provider === p.provider && m.model === p.model);
            if (!alreadyExists) {
                custom.push({
                    provider: p.provider,
                    model:    p.model,
                    label:    p.label,
                    contextK: 128,
                    note:     p.note,
                    ...(p.cooldownMs != null ? { cooldownMs: p.cooldownMs } : {}),
                    // opencode uses 'public' key; kilo :free models send no Authorization header
                    ...((p.provider === 'opencode' || (p.provider === 'kilo' && p.model.endsWith(':free'))) ? { noKey: true } : {}),
                });
            }
        } else {
            const idx = custom.findIndex((m: ModelEntry) => m.provider === p.provider && m.model === p.model);
            if (idx !== -1) custom.splice(idx, 1);
            if (typeof saveMainModelList === 'function') {
                saveMainModelList(mainList.filter(k => k !== p.spec));
            }
        }
    }

    if (typeof saveCustomModels === 'function') saveCustomModels(custom);
    if (typeof renderModelCatalogTable === 'function') renderModelCatalogTable();
    if (typeof renderMainModelList === 'function') renderMainModelList();
}

// Render the rows for one section (adds or removes).
// `activeFilters`: when a FilterKey is in this set, proposals with that filteredBy are hidden.
function _renderSectionRows(items: Proposal[], sectionIdx: 'adds' | 'removes', activeFilters: Set<FilterKey>): string {
    const visible = items.filter(p => !p.filteredBy || !activeFilters.has(p.filteredBy));
    if (!visible.length) {
        return `<div style="color:var(--muted);font-size:12px;padding:4px 0">
            ${activeFilters.size ? 'All matches hidden by active filters — disable a filter above to see them.' : 'None.'}
        </div>`;
    }
    const color = sectionIdx === 'adds' ? '#4caf50' : '#e57373';
    return visible.map((p, idx) => {
        const checked   = p.selected ? 'checked' : '';
        const provBadge = `<span style="font-size:10px;background:var(--border);padding:1px 5px;border-radius:3px;margin-right:4px">${_esc(p.provider)}</span>`;
        const _lnk = (text: string) => p.url
            ? `<a href="${_esc(p.url)}" target="_blank" rel="noopener" title="${_esc(p.url)}" style="color:var(--accent);text-decoration:underline">${text}</a>`
            : text;
        const filterTag = p.filteredBy
            ? `<span style="font-size:10px;background:rgba(255,165,0,0.15);color:#f5a623;padding:1px 5px;border-radius:3px;margin-left:4px">${_esc(p.filteredBy)}</span>`
            : '';
        return `<label style="display:flex;align-items:flex-start;gap:8px;padding:5px 0;cursor:pointer;font-size:12px">
            <input type="checkbox" data-spec="${_esc(p.spec)}" data-section="${sectionIdx}" ${checked} style="margin-top:2px;flex-shrink:0">
            <span style="flex:1;min-width:0">
                ${provBadge}<strong style="color:${color}">${_lnk(_esc(p.label))}</strong>
                <span style="color:var(--muted);margin-left:4px">${_lnk(_esc(p.model))}</span>${filterTag}
                <br><span style="color:var(--muted)">${_esc(p.note)}</span>
            </span>
        </label>`;
    }).join('');
}

export function showModelUpdateModal(): void {
    document.getElementById('fg-model-update-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id        = 'fg-model-update-overlay';
    overlay.className = 'fg-modal-overlay';
    overlay.style.zIndex = '9200';

    overlay.innerHTML = `
<div class="fg-modal" style="max-width:640px;width:95vw">
    <div class="fg-modal-header">
        <span class="fg-modal-title">Check for Model Updates</span>
        <button class="fg-modal-close" id="fg-mu-close">✕</button>
    </div>
    <div class="fg-modal-body" id="fg-mu-body" style="padding:16px">
        <div id="fg-mu-loading" style="text-align:center;padding:24px;color:var(--muted)">
            Fetching model lists from providers…
        </div>
    </div>
</div>`;

    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    (overlay.querySelector('#fg-mu-close') as HTMLButtonElement).onclick = () => overlay.remove();
    document.body.appendChild(overlay);

    _computeProposals().then(({ proposals, errors }) => {
        const body = document.getElementById('fg-mu-body');
        if (!body) return;

        // All filters start active (all filtering is on by default)
        const activeFilters = new Set<FilterKey>(['non-chat', 'preview', 'low-quota', 'too-old']);

        const adds    = proposals.filter(p => p.type === 'add');
        const removes = proposals.filter(p => p.type === 'remove');

        // Track proposal selection state by spec (survives re-renders)
        const selectionState = new Map<string, boolean>(proposals.map(p => [p.spec, p.selected]));

        let html = '';

        if (errors.length) {
            html += `<div style="background:rgba(229,115,115,0.1);border:1px solid rgba(229,115,115,0.3);border-radius:4px;padding:8px 12px;margin-bottom:12px;font-size:12px;color:#e57373">`;
            html += errors.map(e => `<div>${_esc(e)}</div>`).join('');
            html += `</div>`;
        }

        const visibleAdds = adds.filter(p => !p.filteredBy);
        const hasAnyProposal = visibleAdds.length || removes.length ||
            adds.some(p => p.filteredBy);   // filtered proposals exist

        if (!hasAnyProposal) {
            html += `<div style="color:var(--muted);font-size:13px;padding:8px 0">`;
            html += errors.length
                ? 'Could not check all providers. No changes proposed from available data.'
                : '✓ Catalog is up to date — no new or removed models found.';
            html += `</div>`;
            body.innerHTML = html;
            return;
        }

        // ── Filter chips ────────────────────────────────────────────────
        const filterCounts: Record<FilterKey, number> = {
            'non-chat': 0, 'preview': 0, 'low-quota': 0, 'too-old': 0, 'no-tools': 0,
        };
        for (const p of adds) {
            if (p.filteredBy) filterCounts[p.filteredBy]++;
        }
        const chipsWithData = _FILTER_META.filter(f => filterCounts[f.key] > 0);

        // ── Main layout ─────────────────────────────────────────────────

        // Build the static removes HTML separately; only the adds section re-renders on filter toggle.
        const removesHtml = removes.length ? `
            <div style="margin-bottom:14px">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
                    <span style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted);flex:1">Models no longer listed</span>
                    <button class="ws-action-btn fg-mu-selall" data-section="removes" data-action="select"   style="font-size:11px;padding:2px 8px">All</button>
                    <button class="ws-action-btn fg-mu-selall" data-section="removes" data-action="deselect" style="font-size:11px;padding:2px 8px">None</button>
                </div>
                <div id="fg-mu-section-removes">${_renderSectionRows(removes, 'removes', new Set())}</div>
            </div>` : '';

        // Only render the adds section if there are any add proposals (filtered or not)
        if (adds.length) {
            // Filter chips sit inline with the section title, before the All/None buttons.
            // Chips start in the "filter active" (hiding) state — grey/subdued.
            // Clicking turns them blue to indicate they're actively showing filtered models.
            const chipsHtml = chipsWithData.map(f =>
                `<button class="fg-mu-chip fg-mu-chip-on" data-filter="${f.key}" title="${_esc(f.title)}"
                    style="font-size:11px;padding:2px 8px;border-radius:12px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer;white-space:nowrap;line-height:1.4;opacity:0.7">
                    ${_esc(f.label)} <span>(${filterCounts[f.key]})</span>
                </button>`
            ).join('');

            html += `<div id="fg-mu-adds-wrapper" style="margin-bottom:14px">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap">
                    <span style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted);flex-shrink:0">New models available</span>
                    ${chipsHtml}
                    <span style="flex:1"></span>
                    <button class="ws-action-btn fg-mu-selall" data-section="adds" data-action="select"   style="font-size:11px;padding:2px 8px">All</button>
                    <button class="ws-action-btn fg-mu-selall" data-section="adds" data-action="deselect" style="font-size:11px;padding:2px 8px">None</button>
                </div>
                <div id="fg-mu-section-adds">${_renderSectionRows(adds, 'adds', activeFilters)}</div>
            </div>`;
        }

        html += removesHtml;

        html += `<div style="display:flex;gap:8px;margin-top:8px;border-top:1px solid var(--border);padding-top:12px">
            <button class="btn-save" id="fg-mu-apply" style="padding:5px 18px;font-size:12px">Apply changes</button>
            <button class="ws-action-btn" id="fg-mu-cancel">Cancel</button>
            <span id="fg-mu-status" style="font-size:12px;color:var(--muted);align-self:center;margin-left:4px"></span>
        </div>`;

        body.innerHTML = html;

        // ── Re-render adds section ──────────────────────────────────────
        function _rerenderAdds() {
            // Persist current checkbox states before re-rendering
            body.querySelectorAll<HTMLInputElement>('#fg-mu-section-adds input[type=checkbox]').forEach(cb => {
                const spec = cb.dataset.spec;
                if (spec) selectionState.set(spec, cb.checked);
            });
            // Apply persisted state to proposals
            adds.forEach(p => { p.selected = selectionState.get(p.spec) ?? p.selected; });
            const container = document.getElementById('fg-mu-section-adds');
            if (container) container.innerHTML = _renderSectionRows(adds, 'adds', activeFilters);
            _bindCheckboxes();
        }

        // ── Checkbox change handler ────────────────────────────────────
        function _bindCheckboxes() {
            body.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(cb => {
                cb.addEventListener('change', () => {
                    const spec = cb.dataset.spec;
                    if (!spec) return;
                    const p = proposals.find(x => x.spec === spec);
                    if (p) p.selected = cb.checked;
                    selectionState.set(spec, cb.checked);
                });
            });
        }
        _bindCheckboxes();

        // ── Filter chip toggle ─────────────────────────────────────────
        body.querySelectorAll<HTMLButtonElement>('.fg-mu-chip').forEach(btn => {
            btn.addEventListener('click', () => {
                const key = btn.dataset.filter as FilterKey;
                if (!key) return;
                if (activeFilters.has(key)) {
                    // Turn filter off → show previously hidden models (unchecked); chip goes blue
                    activeFilters.delete(key);
                    btn.classList.replace('fg-mu-chip-on', 'fg-mu-chip-off');
                    btn.style.background    = 'var(--accent)';
                    btn.style.color         = '#fff';
                    btn.style.borderColor   = 'var(--accent)';
                    btn.style.opacity       = '1';
                } else {
                    // Turn filter on → hide those models and deselect them; chip goes grey
                    activeFilters.add(key);
                    adds.filter(p => p.filteredBy === key).forEach(p => {
                        p.selected = false;
                        selectionState.set(p.spec, false);
                    });
                    btn.classList.replace('fg-mu-chip-off', 'fg-mu-chip-on');
                    btn.style.background    = 'transparent';
                    btn.style.color         = 'var(--muted)';
                    btn.style.borderColor   = 'var(--border)';
                    btn.style.opacity       = '0.7';
                }
                _rerenderAdds();
            });
        });

        // ── Select All / None buttons ──────────────────────────────────
        body.querySelectorAll<HTMLButtonElement>('.fg-mu-selall').forEach(btn => {
            btn.addEventListener('click', () => {
                const section  = btn.dataset.section!;
                const checked  = btn.dataset.action === 'select';
                const group    = section === 'adds' ? adds : removes;
                const visible  = section === 'adds'
                    ? group.filter(p => !p.filteredBy || !activeFilters.has(p.filteredBy))
                    : group;
                visible.forEach(p => {
                    p.selected = checked;
                    selectionState.set(p.spec, checked);
                });
                body.querySelectorAll<HTMLInputElement>(`#fg-mu-section-${section} input[type=checkbox]`)
                    .forEach(cb => { cb.checked = checked; });
            });
        });

        (document.getElementById('fg-mu-cancel') as HTMLButtonElement).onclick = () => overlay.remove();
        (document.getElementById('fg-mu-apply') as HTMLButtonElement).onclick  = () => {
            _applyProposals(proposals);
            overlay.remove();
        };
    });
}

// Window bridge for agent-core (/model-update slash command) and the settings button
Object.assign(window, { showModelUpdateModal });
