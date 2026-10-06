// model-update.ts — FreeGent: check provider APIs for new/removed free models
// and show a diff-style approval modal so the user can update the catalog.
//
// Invoked via:
//   • /model-update slash command (agent-core.ts handles it like /compact)
//   • "Check for updates" button in Settings → Models

// ── Proxy helpers ─────────────────────────────────────────────────────────

// Returns the active proxy base URL — CF Worker on GitHub Pages, local /api/proxy otherwise.
import { escapeHtml } from './html-escape.js';
function _proxyBase(): string {
    return typeof getLocalApiProxy === 'function' ? getLocalApiProxy() : '/api/proxy';
}

// GET via proxy — avoids CORS and hides the key from the network tab.
async function _proxyGet(url: string): Promise<any> {
    const resp = await fetch(`${_proxyBase()}?url=${encodeURIComponent(url)}`, {
        signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    return resp.json().catch(() => null);
}

// GET-via-POST-proxy — for providers that require Bearer auth (blocked by CORS in browser).
async function _proxyBearer(url: string, key: string): Promise<any> {
    if (!key) return null;
    return _proxyFetch(url, key);
}

// Like _proxyBearer but works without a key (adds Bearer only when key is provided).
// Used for providers that allow anonymous model discovery (e.g. Kilo /models endpoint).
async function _proxyFetch(url: string, key?: string): Promise<any> {
    const hdrs: Record<string, string> = { 'Accept': 'application/json' };
    if (key) hdrs['Authorization'] = `Bearer ${key}`;
    const resp = await fetch(_proxyBase(), {
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

// Some /models endpoints put one constant in `created` for every model instead of a release
// date (seen 2026-09-29: NVIDIA 735790403 = 1993-04-26, TokenHarbor 1700000000 = 2023-11-14,
// Vercel 2025-08-21), which made the '>1 yr old' filter hide new models. Returns a reader for
// one provider's full model list: a value shared by more than half the models, or older than
// 2020, reads as undefined (unknown age).
const _MIN_REAL_CREATED = Date.UTC(2020, 0, 1) / 1000;
function _createdReader(all: any[]): (m: any) => number | undefined {
    const counts = new Map<number, number>();
    for (const m of all) if (typeof m?.created === 'number') counts.set(m.created, (counts.get(m.created) ?? 0) + 1);
    return (m: any) => {
        const c = m?.created;
        if (typeof c !== 'number' || c < _MIN_REAL_CREATED) return undefined;
        return all.length >= 3 && counts.get(c)! > all.length / 2 ? undefined : c;
    };
}

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

// ── TokenHarbor ──────────────────────────────────────────────────────────────
// https://tokenharbor.ai/models?category=free. The /v1/models list marks free models itself: an id
// ending in `:free` with zero input and output price (no provider prefix in the id). It also
// carries a label and tool_call flag. This used to be a hardcoded allowlist dated 2026-09-01,
// which hid every free model added since (deepseek-v4.1-flash:free, mimo-v2.6-flash:free).
const _isTokenHarborFree = (m: any): boolean =>
    typeof m?.id === 'string' && m.id.endsWith(':free') &&
    (m.pricing == null || (Number(m.pricing.input_usd_per_1m) === 0 && Number(m.pricing.output_usd_per_1m) === 0));

async function _fetchTokenHarborModels(): Promise<FetchResult> {
    try {
        const key = typeof getTokenHarborKey === 'function' ? getTokenHarborKey() : (localStorage.getItem('fg_tokenharbor_key') ?? '');
        if (!key) return { live: [], rejected: [] };
        const json = await _proxyBearer('https://tokenharbor.ai/v1/models', key);
        if (!json) return { live: [], rejected: [] };
        const all: any[] = Array.isArray(json?.data) ? json.data : [];
        const created = _createdReader(all);
        const live: LiveModel[] = [];
        const rejected: FetchResult['rejected'] = [];
        for (const m of all.filter(_isTokenHarborFree)) {
            const entry: LiveModel = { id: m.id as string, name: typeof m.label === 'string' ? m.label : undefined, created: created(m) };
            if (m.tool_call === false) rejected.push({ model: entry, reason: 'no-tools' });
            else live.push(entry);
        }
        return { live, rejected };
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
        const created = _createdReader(all);
        const live: LiveModel[] = all
            .filter((m: any) =>
                typeof m.id === 'string' &&
                m.isFree === true &&
                !_KILO_EXCLUDED.has(m.id)
            )
            .map((m: any) => ({ id: m.id as string, name: m.name as string | undefined, created: created(m) }));
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
// Only used when the aggregate list shows nothing free; each result is still checked for $0
// pricing below, because ids that were free once (perplexity/sonar, ling-3.0-flash-sante) are
// priced now and must not be accepted just for being on this list.
const _VERCEL_FREE_IDS = [
    'poolside/laguna-s-2.1-free',
    'inclusionai/ling-3.1-flash-free',
];
// Tool-capable but narrow-domain training — opt-in via 'domain-specific' filter chip.
const _VERCEL_DOMAIN_SPECIFIC = new Set([
    'inclusionai/ling-3.0-flash-fin',
    'inclusionai/ling-3.0-flash-sante',
]);

const _isVercelFree = (m: any): boolean => {
    const zero = (v: any) => v != null && Number(v) === 0;
    return (Array.isArray(m?.tags) && m.tags.includes('free')) || (zero(m?.pricing?.input) && zero(m?.pricing?.output));
};

async function _fetchVercelModels(): Promise<FetchResult> {
    try {
        // Primary: scan the aggregate list for models tagged "free".
        // The list endpoint is public (no auth required).
        const listJson = await _proxyFetch('https://ai-gateway.vercel.sh/v1/models');
        const listAll: any[] = Array.isArray(listJson?.data) ? listJson.data : [];
        // Stealth models (stealth/pixel-canary) are $0 but carry no "free" tag.
        const listFree = listAll.filter((m: any) => typeof m.id === 'string' && m.type === 'language' && _isVercelFree(m));

        // Fallback: the aggregate endpoint sometimes omits free models.
        // Probe each known free ID individually and collect what's alive.
        const toProcess: any[] = listFree.length > 0 ? listFree : await (async () => {
            const results = await Promise.allSettled(
                _VERCEL_FREE_IDS.map(id => _proxyFetch(`https://ai-gateway.vercel.sh/v1/models/${id}`))
            );
            return results.flatMap(r => (r.status === 'fulfilled' && r.value?.id && _isVercelFree(r.value) ? [r.value] : []));
        })();

        const created = _createdReader(listAll.length ? listAll : toProcess);
        const live: LiveModel[] = [];
        const rejected: { model: LiveModel; reason: FilterKey }[] = [];
        for (const m of toProcess) {
            if (!m.id || m.type !== 'language') continue;
            const lm: LiveModel = { id: m.id as string, name: m.name as string | undefined, created: created(m) };
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

// Non-chat Groq model patterns: speech transcription, safety classifiers, TTS, meta-routers
const _GROQ_EXCL = /^whisper|prompt-guard|canopylabs\/orpheus|^groq\/compound|safeguard/i;

async function _fetchGroqModels(): Promise<FetchResult> {
    try {
        const key = typeof getGroqKey === 'function' ? getGroqKey() : (localStorage.getItem('fg_groq_key') ?? '');
        if (!key) return { live: [], rejected: [] };
        const json = await _proxyBearer('https://api.groq.com/openai/v1/models', key);
        if (!json) return { live: [], rejected: [] };
        const data: any[] = json?.data ?? [];
        const created = _createdReader(data);

        const live: LiveModel[] = [];
        const rejected: { model: LiveModel; reason: FilterKey }[] = [];

        for (const m of data) {
            const lm: LiveModel = { id: m.id as string, name: m.id as string, created: created(m) };
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
        const created = _createdReader(data);

        const live: LiveModel[] = [];
        const rejected: { model: LiveModel; reason: FilterKey }[] = [];

        for (const m of data) {
            const lm: LiveModel = { id: m.id as string, name: m.id as string, created: created(m) };
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
        const created = _createdReader(all);

        const live: LiveModel[] = [];
        const rejected: { model: LiveModel; reason: FilterKey }[] = [];

        for (const m of all) {
            const id: string = m.id ?? '';
            // Free-tier models: ":free" ids, or $0 pricing (stealth/space-bunny-alpha has no suffix).
            const _zero = (v: any) => v != null && Number(v) === 0;
            if (!id.endsWith(':free') && !(_zero(m.pricing?.prompt) && _zero(m.pricing?.completion))) continue;
            const lm: LiveModel = { id, name: m.name as string | undefined, created: created(m) };
            const modality: string = m.architecture?.modality ?? '';
            if (_NOUS_EXCL_NONCHAT.test(id) || (modality && !modality.includes('->text'))) {
                rejected.push({ model: lm, reason: 'non-chat' });
            } else if (_NOUS_EXCL_PREVIEW.test(id) && !id.startsWith('stealth/')) {
                // Stealth models are named "-alpha" by convention, not because they are unstable variants.
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
        case 'groq':       return 'https://console.groq.com/docs/models';
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
    const [orModels, googleResult, groqResult, nvidiaResult, thResult, kiloResult, vercelResult, nousResult] =
        await Promise.all([
            _fetchOpenRouterModels(),
            _fetchGoogleModels(),
            _fetchGroqModels(),
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
        const orCreated = _createdReader(orModels);
        const orFreeWithName = orFree.map((m: any) => ({ id: m.id, name: m.name, created: orCreated(m) }));

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

    // Remove proposals the user has previously dismissed (kept unchecked on Apply), and add
    // proposals for blacklisted models (FREE_MODEL_BLACKLIST in config.ts: listed as free, but
    // every request fails).
    const suppressed = _getSuppressedRemoves();
    return { proposals: proposals.filter(p =>
        !(p.type === 'remove' && suppressed.has(p.spec)) &&
        !(p.type === 'add' && typeof isBlacklistedModel === 'function' && isBlacklistedModel(p.spec))), errors };
}

// ── Modal UI ──────────────────────────────────────────────────────────────


function _getSuppressedRemoves(): Set<string> {
    try { return new Set(JSON.parse(localStorage.getItem('fg_suppressed_removes') || '[]')); }
    catch { return new Set(); }
}
function _saveSuppressedRemoves(s: Set<string>): void {
    try { localStorage.setItem('fg_suppressed_removes', JSON.stringify([...s])); } catch {}  // best-effort
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
    // Reconcile the saved ranking, not just currently routable models: paused entries
    // and providers without a key must keep their positions when another model is removed.
    const mainList: string[]   = typeof getMainModelList === 'function' ? getMainModelList() : [];
    const removedSpecs = new Set<string>();

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
                    // Kilo proposals are all isFree models, which work without a key. Not all carry
                    // a ":free" suffix (stealth/space-bunny-alpha does not).
                    ...(p.provider === 'kilo' ? { noKey: true } : {}),
                });
            }
        } else {
            const idx = custom.findIndex((m: ModelEntry) => m.provider === p.provider && m.model === p.model);
            if (idx !== -1) custom.splice(idx, 1);
            removedSpecs.add(p.spec);
        }
    }

    // Persist custom entries before changing visibility/ranking; storage errors leave those intact.
    if (typeof saveCustomModels === 'function') saveCustomModels(custom);
    for (const p of selected) {
        // Built-ins cannot be deleted from the source catalog. Use the same exclusion
        // set as manual deletion so they stay absent after re-rendering or resetting defaults.
        if (p.type === 'remove' && typeof hideBuiltinModel === 'function') hideBuiltinModel(p.spec);
        if (p.type === 'add' && typeof unhideBuiltinModel === 'function') unhideBuiltinModel(p.spec);
    }
    if (removedSpecs.size && typeof saveMainModelList === 'function') {
        saveMainModelList(mainList.filter(k => !removedSpecs.has(k)));
        if (typeof getPausedMainModels === 'function' && typeof savePausedMainModels === 'function') {
            savePausedMainModels(getPausedMainModels().filter(k => !removedSpecs.has(k)));
        }
    }
    if (typeof renderModelCatalogTable === 'function') renderModelCatalogTable();
    if (typeof renderMainModelList === 'function') renderMainModelList();
    if (typeof updateActiveModelDisplay === 'function') updateActiveModelDisplay();
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
        const provBadge = `<span style="font-size:10px;background:var(--border);padding:1px 5px;border-radius:3px;margin-right:4px">${escapeHtml(p.provider)}</span>`;
        const _lnk = (text: string) => p.url
            ? `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener" title="${escapeHtml(p.url)}" style="color:var(--accent);text-decoration:underline">${text}</a>`
            : text;
        const filterTag = p.filteredBy
            ? `<span style="font-size:10px;background:rgba(255,165,0,0.15);color:#f5a623;padding:1px 5px;border-radius:3px;margin-left:4px">${escapeHtml(p.filteredBy)}</span>`
            : '';
        return `<label style="display:flex;align-items:flex-start;gap:8px;padding:5px 0;cursor:pointer;font-size:12px">
            <input type="checkbox" data-spec="${escapeHtml(p.spec)}" data-section="${sectionIdx}" ${checked} style="margin-top:2px;flex-shrink:0">
            <span style="flex:1;min-width:0">
                ${provBadge}<strong style="color:${color}">${_lnk(escapeHtml(p.label))}</strong>
                <span style="color:var(--muted);margin-left:4px">${_lnk(escapeHtml(p.model))}</span>${filterTag}
                <br><span style="color:var(--muted)">${escapeHtml(p.note)}</span>
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
            html += errors.map(e => `<div>${escapeHtml(e)}</div>`).join('');
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
                `<button class="fg-mu-chip fg-mu-chip-on" data-filter="${f.key}" title="${escapeHtml(f.title)}"
                    style="font-size:11px;padding:2px 8px;border-radius:12px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer;white-space:nowrap;line-height:1.4;opacity:0.7">
                    ${escapeHtml(f.label)} <span>(${filterCounts[f.key]})</span>
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
            try {
                _applyProposals(proposals);
            } catch (e: any) {
                const status = document.getElementById('fg-mu-status');
                if (status) { status.textContent = e?.message || String(e); status.style.color = '#e57373'; }
                return;
            }
            overlay.remove();
        };
    });
}

// Window bridge for agent-core (/model-update slash command) and the settings button
Object.assign(window, { showModelUpdateModal });
