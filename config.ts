// config.js — FreeGent: global state, settings helpers, model catalog, pyodide, utilities
// Loaded first; all other modules depend on this.
import { KEYS, roleBodyKey, roleBodyFnKey } from './storage-keys.js';
export { KEYS } from './storage-keys.js';

export const MAX_STEPS = 100; // hard ceiling on ReAct steps within a single turn

// ── Session state ──────────────────────────────────────────────────────────
let agentsContext       = ''; // content of AGENTS.md, injected at top of system prompt
let _pyodideImageStore: Record<string, any> = {}; // image store for browser UI rendering
export const skillsRegistry     = new Map(); // name → { name, description, body, path }
const activeSkills       = new Set(JSON.parse(localStorage.getItem(KEYS.ACTIVE_SKILLS) || '[]'));
const disabledRoles      = new Set(JSON.parse(localStorage.getItem(KEYS.DISABLED_ROLES) || '[]'));
export function isRoleEnabled(name) { return !disabledRoles.has(name); }
export function getRoleBody(name)   { return localStorage.getItem(roleBodyKey(name)) || null; }
function setRoleBody(name, body) {
    if (body !== null && body !== undefined) localStorage.setItem(roleBodyKey(name), body);
    else localStorage.removeItem(roleBodyKey(name));
}
// Saved JS source for body_fn roles.  Stored as the full "method() { … }" string returned
// by body_fn.toString(); executed at runtime via new Function to produce the rendered body.
export function getRoleBodyFn(name)  { return localStorage.getItem(roleBodyFnKey(name)) || null; }
function setRoleBodyFn(name, code) {
    if (code !== null && code !== undefined) localStorage.setItem(roleBodyFnKey(name), code);
    else localStorage.removeItem(roleBodyFnKey(name));
}
// Order: default-on tools first (shown checked on fresh install), opt-in tools after.
export const ALL_TOOL_NAMES = [
    // Default-on
    'list_files', 'read_file', 'search_workspace',
    'execute_code',
    'web_search', 'fetch_url',
    'run_workers',
    'generate_image',
    // Opt-in: filesystem writes
    'write_file', 'replace_in_file', 'apply_patch', 'append_file', 'delete_file', 'undo_write',
    // Opt-in: specialist
    'deep_research', 'academic_search', 'package_search', 'context7_docs',
    'repo_map', 'run_git', 'ast_query',
    'update_task_status',
];

// Tools disabled by default — enabled only by explicit user action in Settings → Tools.
// NOT added by roles, LLM classifier, or skill triggers — activeTools() bypasses
// those gates for this set: when enabled they are always present; when disabled, never.
//   • Filesystem write/edit tools: agent uses execute_code (bash) for file I/O by default.
//     read_file and search_workspace are NOT opt-in — they provide deduplication and
//     compaction-survival benefits that execute_code (cat/grep) cannot replicate.
//   • Heavy/specialist tools: opt-in only; too expensive or narrow for default use.
export const OPT_IN_TOOLS = new Set([
    // Filesystem write/edit tools — replaced by bash by default.
    // list_files is NOT opt-in: all roles include it in their ceiling.
    'write_file', 'undo_write',
    'replace_in_file', 'apply_patch', 'delete_file', 'append_file',
    // Specialist / narrow tools — off by default; enable when needed.
    'deep_research', 'repo_map',
    'academic_search',   // academic literature — niche; use web_search for general queries
    'package_search',    // registry lookup — rarely needed; packages found via web_search
    'context7_docs',     // library docs via remote MCP service
    'run_git',           // git operations — only useful with local sandbox + git enabled
    'ast_query',         // AST code structure — only useful with AST enabled
    // Task-status tool — useful only when the tasks skill is active; off by default
    // so agents don't wastefully call it on tasks that aren't managed via the skill.
    'update_task_status',
]);

// Persist DISABLED tools rather than enabled ones, so tools shipped in a later version
// default to on instead of staying invisible until the user re-checks them. (A saved
// fg_enabled_tools from an older build is migrated to the new key on first load.)
export const enabledTools = (() => {
    const disabled = JSON.parse(localStorage.getItem(KEYS.DISABLED_TOOLS) || 'null');
    if (disabled) return new Set(ALL_TOOL_NAMES.filter(t => !disabled.includes(t)));
    const legacyEnabled = JSON.parse(localStorage.getItem(KEYS.ENABLED_TOOLS) || 'null');
    if (legacyEnabled) {
        const legacyDisabled = ALL_TOOL_NAMES.filter(t => !legacyEnabled.includes(t));
        localStorage.setItem(KEYS.DISABLED_TOOLS, JSON.stringify(legacyDisabled));
        return new Set(ALL_TOOL_NAMES.filter(t => !legacyDisabled.includes(t)));
    }
    // Fresh install (no saved prefs): opt-in tools disabled by default.
    return new Set(ALL_TOOL_NAMES.filter(t => !OPT_IN_TOOLS.has(t)));
})();

// ── Mode ───────────────────────────────────────────────────────────────────
// Global UX mode: 'chat' (default) | 'cowork'.
// Cowork mode activates task-management tools (update_task_status) and injects
// task context into the system prompt, even if the user hasn't explicitly
// enabled those tools in Settings → Tools.
export type AppMode = 'chat' | 'cowork';

export function getMode(): AppMode {
    return (localStorage.getItem(KEYS.MODE) as AppMode) || 'chat';
}

export function setMode(m: AppMode): void {
    if (m === 'chat') localStorage.removeItem(KEYS.MODE);
    else localStorage.setItem(KEYS.MODE, m);
    // Keep select in sync (may be called programmatically)
    const sel = document.getElementById('hdr-mode') as HTMLSelectElement | null;
    if (sel && sel.value !== m) sel.value = m;
    // Visual indicator on the toolbar: add/remove a class on the toolbar element
    const tb = sel?.closest('.chat-toolbar');
    tb?.classList.toggle('mode-cowork', m === 'cowork');
}

// Tools activated by Cowork mode in addition to user's tool prefs.
// write_file is required so the tasks skill can actually create task files.
const COWORK_TOOLS = new Set<string>(['update_task_status', 'write_file']);

// Drop-in replacement for enabledTools.has() used in tool and skill filtering:
// returns true when the tool is in enabledTools OR when the current mode
// activates it (so callers don't need to know about mode logic).
export function isToolActive(name: string): boolean {
    return enabledTools.has(name) || (getMode() === 'cowork' && COWORK_TOOLS.has(name));
}

// ── Chat state ─────────────────────────────────────────────────────────────
let chatsDropdownOpen = false;

// ── Pyodide state ──────────────────────────────────────────────────────────
let pyodideWorker       = null;
let pyodideReadyPromise = null;
export let pyodideStatus       = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
const pyodideCallbacks  = {};
let pyodideMsgId        = 0;

// ── Settings helpers ───────────────────────────────────────────────────────

// Keys loaded from the Python server (env vars / .env file). Populated by
// loadServerKeys() at startup. Only used when localStorage has no value for a key.
const _serverKeys = {};

// Fetch API keys from the local server and store in _serverKeys.
// Two sources are checked in order; both are merged so neither wins exclusively:
//
//  1. DOM-injected tag — <script id="fg-server-keys" type="application/json"> embedded
//     by the fg-key-inject Vite plugin in vite.config.ts.  Available synchronously and
//     survives SSL cert failures: mobile browsers that accept the navigation warning for
//     a self-signed cert (basicSsl is localhost-only; LAN-IP fetch() is refused) can
//     still read keys that were baked into the HTML.
//
//  2. /api/keys fetch — picks up keys changed after page load (dev hot-reload) and works
//     in static builds where the inject plugin isn't present.
//
// The fetch result overwrites the DOM values so runtime changes are always picked up.
async function loadServerKeys() {
    try {
        const el = document.getElementById('fg-server-keys');
        if (el?.textContent) Object.assign(_serverKeys, JSON.parse(el.textContent));
    } catch {}
    try {
        // Skip on static hosts (GitHub Pages, CF Pages) — no local /api/keys server.
        const host = typeof window !== 'undefined' ? window.location.hostname : '';
        if (host.endsWith('.github.io') || host.endsWith('.pages.dev')) return;
        const r = await fetch('/api/keys', { signal: AbortSignal.timeout(2000) });
        if (r.ok) Object.assign(_serverKeys, await r.json());
    } catch {}
}

// localStorage with server-key fallback. If a key has never been stored in
// localStorage (returns null), the value from _serverKeys is used instead.
// Reads go through a cache — getters call ls() on hot paths (several times per agent
// step). Any write through localStorage invalidates the key via the wrappers below,
// so cached values cannot go stale. Raw values are cached (including null) so the
// _serverKeys/default fallback still applies per call.
const _lsCache = new Map();
{
    // Storage is a browser global; under Node import (headless) it is undefined, and the
    // bootstrap windowProxy binds function props (bound fns have no .prototype), so the
    // class can't be reached via window.Storage either. Derive the prototype from the
    // localStorage instance — works in browser, JSDOM, and any future environment.
    const _StorageProto = typeof Storage !== 'undefined' ? Storage.prototype
        : (typeof localStorage !== 'undefined' ? Object.getPrototypeOf(localStorage) : null);
    if (_StorageProto?.setItem) {
        const _origSetItem = _StorageProto.setItem;
        const _origRemoveItem = _StorageProto.removeItem;
        const _origClear = _StorageProto.clear;
        _StorageProto.setItem    = function (k, v) { _lsCache.delete(String(k)); return _origSetItem.call(this, k, v); };
        _StorageProto.removeItem = function (k)    { _lsCache.delete(String(k)); return _origRemoveItem.call(this, k); };
        _StorageProto.clear      = function ()     { _lsCache.clear(); return _origClear.call(this); };
    }
}
export const ls = (k, def = '') => {
    let v;
    if (_lsCache.has(k)) v = _lsCache.get(k);
    else { v = localStorage.getItem(k); _lsCache.set(k, v); }
    // Treat both null (never set) and '' (accidentally written by old saveSettings bug)
    // as absent — fall through to _serverKeys so env-loaded values are never blocked
    // by an empty-string entry that was written when the Settings form saved too early.
    return (v !== null && v !== '') ? v : (_serverKeys[k] ?? def);
};

export function getProvider() {
    const list = getActiveMainModelList();
    if (list.length) { const i = list[0].indexOf('|'); return i >= 0 ? list[0].slice(0, i) : 'google'; }
    return ls('fg_provider', 'google');
}
export function getGeminiKey()      { return ls('fg_gemini_key'); }
export function getGeminiModel()    {
    const list = getActiveMainModelList();
    if (list.length && list[0].startsWith('google|')) return list[0].slice(7);
    return ls('fg_gemini_model', 'gemini-2.5-flash');
}
function getOAIUrl()         { return ls('fg_openai_url', 'https://api.openai.com/v1').replace(/\/$/, ''); }
function getOAIKey()         { return ls('fg_openai_key'); }
function getOAIModel()       { return ls('fg_openai_model', 'mistral-medium-3.5'); }
export function getOAIContextTokens()   { return parseInt(ls('fg_openai_context',  '50000'), 10); }
function getMistralKey()     { return ls('fg_mistral_key'); }
function getMistralModel()   { return ls('fg_mistral_model', 'mistral-medium-3.5'); }
function getGroqKey()        { return ls('fg_groq_key'); }
function getCerebrasKey()    { return ls('fg_cerebras_key'); }
function getNvidiaKey()      { return ls('fg_nvidia_key'); }
function getNvidiaModel()    { return ls(KEYS.NVIDIA_MODEL, 'nvidia/nemotron-3-super-120b-a12b'); }
function getOpenRouterKey()  { return ls('fg_openrouter_key'); }
function getOpenRouterModel(){ return ls('fg_openrouter_model', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'); }
function getOpenCodeKey()    { return ls('fg_opencode_key'); }
function getTokenHarborKey() { return ls('fg_tokenharbor_key'); }
function getKiloKey()        { return ls('fg_kilo_key'); }
function getVercelKey()      { return ls('fg_vercel_key'); }
function getNousKey()        { return ls('fg_nous_key'); }
function getSearchProvider() { return ls('fg_search_provider', 'auto'); }
// Generic thinking level: 'default' | 'off' | 'low' | 'medium' | 'high' (provider-agnostic, stored in fg_thinking_level).
// 'default' = no thinking argument sent to the endpoint (endpoint uses its own default behaviour).
// Legacy fg_reasoning_budget / fg_custom_thinking are superseded by this.
export function getThinkingLevel() { return ls('fg_thinking_level', 'default'); }
// LLM sampling temperature (0–2). Stored as string; null/empty → use provider default (0.2).
export function getTemperature() {
    const v = ls('fg_temperature', '0.6');
    if (v === '' || v === null) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
}
export function getTopP() {
    const v = ls('fg_top_p', '0.95');
    if (v === '' || v === null) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
}
export function getTopK() {
    const v = ls('fg_top_k', '20');
    if (v === '' || v === null) return null;
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
}
function getMinP() {
    const v = ls('fg_min_p', '0.0');
    if (v === '' || v === null) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
}
function getPresencePenalty() {
    const v = ls('fg_presence_penalty', '0.0');
    if (v === '' || v === null) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
}
function getRepetitionPenalty() {
    const v = ls('fg_repetition_penalty', '1.0');
    if (v === '' || v === null) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
}
// Returns a flat object of all non-null sampling params for injection into OpenAI-compatible payloads.
export function getSamplingParams() {
    const p: any = {};
    const t = getTemperature(); if (t !== null) p.temperature = t;
    const tp = getTopP(); if (tp !== null) p.top_p = tp;
    const tk = getTopK(); if (tk !== null) p.top_k = tk;
    const mp = getMinP(); if (mp !== null) p.min_p = mp;
    const pp = getPresencePenalty(); if (pp !== null) p.presence_penalty = pp;
    const rp = getRepetitionPenalty(); if (rp !== null) p.repetition_penalty = rp;
    return p;
}
const _THINK_BUDGETS = {
    google: { off: 0, low: 1024,  medium: 8192,  high: 24576 },
    nvidia: { off: 0, low: 4096,  medium: 16384, high: 32768 },
    custom: { off: 0, low: 4096,  medium: 6144,  high: 12288 }, // vllm: sent as thinking_token_budget; 'custom': gates enable_thinking only
};
export function thinkingLevelBudget(provider) {
    const level = getThinkingLevel();
    // 'default' means "don't send any thinking field to the endpoint" — sentinel -1 signals
    // payload-builder to skip _thinkingFields() entirely so the endpoint uses its own default.
    if (level === 'default') return -1;
    return (_THINK_BUDGETS[provider] ?? _THINK_BUDGETS.google)[level] ?? 0;
}
function getTavilyKey()      { return ls('fg_tavily_key'); }
function getHFKey()          { return ls('fg_hf_key'); }
// Normalizes a missing scheme (e.g. "myworker.workers.dev" pasted without "https://") —
// unprefixed, fetch() resolves it as a path relative to the current page's own origin
// instead of the intended host, silently hitting the local app instead of the proxy.
function getSearchProxy() {
    const v = ls('fg_search_proxy');
    return v && !/^https?:\/\//i.test(v) ? `https://${v}` : v;
}
// The default CF Worker — used when the user hasn't configured their own proxy
// and the app is running on GitHub Pages (no local /api/proxy server available).
// Secured by origin + domain allowlist in cf-worker/worker.js.
const DEFAULT_CF_WORKER = 'https://fg-proxy.antti-puurula.workers.dev';
function getEffectiveProxy() {
    const manual = getSearchProxy();
    if (manual) return manual;
    try {
        const host = window.location.hostname;
        // On GitHub Pages there is no local server — use the default CF Worker.
        if (host.endsWith('.github.io')) return DEFAULT_CF_WORKER;
        // Always fall back to the same-origin /api/proxy so LAN-IP access
        // (e.g. https://192.168.1.28:5000) routes fetch_url plain GETs through
        // the local server and avoids cross-origin CORS blocks.
        return `${window.location.origin}/api/proxy`;
    } catch {}
    return '';
}

// Returns the active CORS proxy URL for LLM POST calls.
// Priority: user-configured proxy → default CF Worker (GitHub Pages) → same-origin /api/proxy.
// The same-origin fallback lets LAN-IP deployments (mobile on local network) reach the
// backend without CORS errors. A configured CF Worker URL covers GitHub Pages deployments
// where there is no local server — see cf-worker/ for the deployable Worker script.
export function getLocalApiProxy() {
    const configured = typeof getSearchProxy === 'function' ? getSearchProxy() : '';
    if (configured) return configured.replace(/\/$/, '');
    try {
        const host = window.location.hostname;
        // On GitHub Pages there is no local server — use the default CF Worker.
        if (host.endsWith('.github.io')) return DEFAULT_CF_WORKER;
        return `${window.location.origin}/api/proxy`;
    } catch {}
    return '';
}
function getBraveKey()       { return ls('fg_brave_key'); }
function getGithubToken()      { return ls('fg_github_token'); }
function getStackExchangeKey() { return ls('fg_stackexchange_key'); }
export function getSandboxProvider()  { return ls('fg_sandbox_provider', 'wasm'); }

// ── Geo / IP cache ────────────────────────────────────────────────────────
// Fetches https://ipinfo.io/json once at startup and caches the result in
// localStorage keyed by IP.  Re-fetches when the stored IP differs from the
// current one (detected on the next startup after an IP change) or after 7 days.
const GEO_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function getGeoCache(): { ip?:string; city?:string; region?:string; country?:string; timezone?:string; org?:string } | null {
    try {
        const raw = localStorage.getItem(KEYS.GEO_CACHE);
        if (!raw) return null;
        const d = JSON.parse(raw);
        if (!d || typeof d !== 'object') return null;
        // Expire after TTL
        if (typeof d.ts === 'number' && Date.now() - d.ts > GEO_TTL_MS) return null;
        return d;
    } catch { return null; }
}

export async function prefetchGeoCache(): Promise<void> {
    try {
        const cached = getGeoCache();
        if (cached?.ip) return; // still fresh
        const res  = await fetch('https://ipinfo.io/json');
        if (!res.ok) return;
        const data = await res.json();
        const entry = {
            ip:       data.ip       ?? '',
            city:     data.city     ?? '',
            region:   data.region   ?? '',
            country:  data.country  ?? '',
            timezone: data.timezone ?? '',
            org:      data.org      ?? '',
            ts:       Date.now(),
        };
        localStorage.setItem(KEYS.GEO_CACHE, JSON.stringify(entry));
    } catch { /* network unavailable — silently skip */ }
}

// ── Agent loop settings ────────────────────────────────────────────────────
function getAgentToolTruncation()   { return ls('fg_agent_tool_result_truncation', 'true') !== 'false'; }
function getAgentMaxToolResult()    { return parseInt(ls('fg_agent_max_tool_result', '100000'), 10); }
function getDirectorMaxToolResult() { return parseInt(ls('fg_director_max_tool_result', '20000'), 10); } // 0 = disabled
export function getAgentProactiveCompact() { return ls('fg_agent_proactive_compact', 'true') !== 'false'; }
export function getAgentCompactAt()        { return parseFloat(ls('fg_agent_compact_at', '0.75')); }
export function getAgentCompactTokens()    { return parseInt(ls('fg_agent_compact_tokens', '80000'), 10); }

function getAgentPlanMode()         { return ls('fg_agent_plan_mode', 'false') !== 'false'; }
export function getAgentMaxSteps()           { return parseInt(ls('fg_agent_max_rounds', '100'), 10); }
export function getAgentLeanWorkers()        { return ls('fg_agent_lean_workers', 'true') !== 'false'; }
export function getAgentWorkerHistory()      { return ls('fg_agent_worker_history', 'true') !== 'false'; }
function getAgentPromptTemplate()     { return ls('fg_agent_prompt_template', ''); }
export function getAgentConcisePrompts()     { return ls('fg_agent_concise_prompts', 'true') !== 'false'; }
export function getAgentWorkerReduce()       { return ls('fg_agent_worker_reduce', 'true') !== 'false'; }
function getAgentRoleModelRouting()   { return ls('fg_agent_role_model_routing', 'true') !== 'false'; }
export function getEndpointRotation()        { return ls('fg_endpoint_rotation', 'false') !== 'false'; }
function getRotationStepN()           { return Math.max(1, parseInt(ls('fg_rotation_step_n', '5'), 10)); }
function getAgentMaxDelegationDepth() { return parseInt(ls('fg_agent_max_delegation_depth', '1'), 10); }
function getAgentLedger()             { return ls('fg_agent_ledger', 'true') !== 'false'; }
function getAgentReviewLogs()         { return ls('fg_agent_review_logs', 'false') !== 'false'; }
// (entity memory removed)
function getAgentMaxReplans()         { return parseInt(ls('fg_agent_max_replans', '2'), 10); }
function getIntentValidation() { return ls(KEYS.INTENT_VALIDATION, 'heuristic'); } // 'off' | 'heuristic'
function setIntentValidation(value) { localStorage.setItem(KEYS.INTENT_VALIDATION, value); }
function getToolApproval() { return ls('fg_tool_approval', 'off'); } // 'off' | 'high' | 'all'


function getRunnerMaxConsecutiveFails() { return parseInt(ls('fg_agent_loop_max_consecutive_failures', '5'), 10); }
function getRateLimitCooldownMs()             { return parseInt(ls('fg_rate_limit_cooldown_min', '2'), 10) * 60_000; }
function getRunnerQa()        { return ls('fg_agent_loop_qa',        'true')  !== 'false'; }
function getGitEnabled()         { return ls('fg_git_enabled',           'false') !== 'false'; }
function getAstEnabled()         { return ls('fg_ast_enabled',            'false') !== 'false'; }
function getQaEnabled()          { return ls('fg_qa_enabled',          'true')  !== 'false'; }
function getQaTestRunner()       { return ls('fg_qa_test_runner',       'true')  !== 'false'; }
function getQaAcceptanceReview() { return ls('fg_qa_acceptance_review', 'true')  !== 'false'; }
function getQaRegressionGuard()  { return ls('fg_qa_regression_guard',  'false') !== 'false'; }
function getQaReworkLimit()      { return parseInt(ls('fg_qa_rework_limit', '3'), 10); }
function getShowNudges()     { return ls('fg_show_nudges', 'false') !== 'false'; }
function getEditReviewEnabled()  { return ls('fg_edit_review_enabled', 'false') !== 'false'; }
// Worker thinking budget: token count, or -1 to inherit from main model setting. Default: 24576 (high).
export function getWorkerThinkingBudget()  {
    const v = parseInt(ls('fg_worker_thinking_budget', '24576'), 10);
    return v === -1 ? thinkingLevelBudget('google') : v;
}
// preserve_thinking: pass reasoning_content back to vLLM so the chat template re-inserts
// <think> blocks in subsequent turns (multi-turn reasoning continuity). Default on.
// Only has effect for provider:vllm with a thinking budget > 0.
export function getPreserveThinking() { return ls('fg_preserve_thinking', 'true') !== 'false'; }

// ── Model catalog ──────────────────────────────────────────────────────────

// Built-in models — never mutated at runtime.
// rpm/rpd: known free-tier limits (requests per minute / per day). Absent = unlimited/unknown.
// These are conservative minimums — actual paid-tier limits are higher.
const MODEL_CATALOG = [
    // ── Google (free tier via AI Studio) ──────────────────────────────────────
    // https://ai.google.dev/gemini-api/docs/models
    { provider:'google',     model:'gemini-3.5-flash-lite',                               label:'Gemini 3.5 Flash Lite',         released:'2026-05', contextK:1048, params:null, media:['text','image'],                tools:true,  thinking:true,  rpm:30,  rpd:1500, note:'Efficient Gemini; thinking mode' },
    { provider:'google',     model:'gemini-2.5-flash-lite',                               label:'Gemini 2.5 Flash Lite',         released:'2025-07', contextK:1048, params:null, media:['text','image'],                tools:true,  thinking:true,  rpm:30,  rpd:1500, note:'Prior generation; fastest Gemini; supports thinking mode' },
    { provider:'google',     model:'gemma-4-31b-it',                                      label:'Gemma 4 31B',                   released:'2026-04', contextK:256,  params:31,   media:['text','image'],                tools:true,  thinking:false, rpm:30,  rpd:1500, note:'Strong open model; 256K context; native tool use; runs locally at 24GB VRAM' },
    { provider:'google',     model:'gemma-4-26b-a4b-it',                                  label:'Gemma 4 MoE 27B',               released:'2026-04', contextK:256,  params:27,   media:['text','image'],                tools:true,  thinking:false, rpm:30,  rpd:1500, note:'MoE open model; fast inference (3.8B active params); 256K context' },
    // ── Mistral (free tier — free mode is the default; limits visible in admin panel) ──────────────
    // https://mistral.ai/docs/models
    { provider:'mistral',    model:'mistral-large-2512',                                  label:'Mistral Large 3',               released:'2025-12', contextK:128,  params:675,  media:['text','image'],                tools:true,  thinking:false, note:'Mistral Large 3; stable versioned alias' },
    { provider:'mistral',    model:'mistral-medium-3.5',                                  label:'Mistral Medium 3.5',            released:'2026-04', contextK:128,  params:128,  media:['text','image'],                tools:true,  thinking:false, note:'Good speed/quality; vision capable' },
    { provider:'mistral',    model:'mistral-small-latest',                                label:'Mistral Small',                 released:'2026-03', contextK:32,   params:24,   media:['text'],                        tools:true,  thinking:false, note:'Fast and cost-effective' },
    { provider:'mistral',    model:'mistral-small-2603',                                  label:'Mistral Small 2603',            released:'2026-03', contextK:32,   params:24,   media:['text'],                        tools:true,  thinking:false, note:'Versioned alias for Mistral Small March 2026' },
    { provider:'mistral',    model:'ministral-8b-latest',                                 label:'Ministral 8B',                  released:'2026-01', contextK:128,  params:8,    media:['text'],                        tools:true,  thinking:false, note:'Efficient 8B edge model; fast and cost-effective' },
    // ── Groq (free tier) ──────────────────────────────────────────────────────
    // https://console.groq.com/docs/models
    { provider:'groq',       model:'openai/gpt-oss-120b',                                 label:'GPT-OSS 120B (Groq)',           released:'2025-05', contextK:128,  params:120,  media:['text'],                        tools:true,  thinking:false, rpm:30,  rpd:14400, note:'OpenAI open-weight model served on Groq infrastructure' },
    { provider:'groq',       model:'openai/gpt-oss-20b',                                  label:'GPT-OSS 20B (Groq)',            released:'2026-06', contextK:128,  params:20,   media:['text'],                        tools:true,  thinking:false, rpm:30,  rpd:14400, note:'Ultra-fast ~1000 T/s; OpenAI open-weight 20B on Groq infrastructure' },
    // ── NVIDIA NIM ────────────────────────────────────────────────────────────
    // https://build.nvidia.com/models
    { provider:'nvidia',     model:'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',       label:'Nemotron Nano Omni 30B',        released:'2026-04', contextK:128,  params:30,   media:['text','image'],                tools:false, thinking:true,  note:'Multimodal (text, image); cloud endpoint silently drops data: audio URLs — use OpenRouter or Voxtral for audio' },
    { provider:'nvidia',     model:'nvidia/nemotron-3-super-120b-a12b',                   label:'Nemotron Super 120B',           released:'2026-03', contextK:128,  params:120,  media:['text'],                        tools:false, thinking:true,  note:'High-capability reasoning model' },
    { provider:'nvidia',     model:'nvidia/nemotron-3-ultra-550b-a55b',                   label:'Nemotron Ultra 550B',           released:'2026-06', contextK:1000, params:550,  media:['text'],                        tools:true,  thinking:true,  note:'550B MoE (55B active); 1M context; highest-capability Nemotron reasoning model; fn-tag tool calls' },
    { provider:'nvidia',     model:'nvidia/llama-3.3-nemotron-super-49b-v1.5',           label:'Nemotron Super 49B',            released:'2026-06', contextK:128,  params:49,   media:['text'],                        tools:false, thinking:false, note:'49B Llama-based Nemotron; efficient alternative to Nemotron Super 120B' },
    { provider:'nvidia',     model:'stepfun-ai/step-3.7-flash',                          label:'Step 3.7 Flash',                released:'2026-06', contextK:32,   params:198,  media:['text'],                        tools:false, thinking:false, note:'198B MoE (11B active); fast agentic model from Stepfun via NVIDIA NIM' },
    { provider:'nvidia',     model:'moonshotai/kimi-k2.6',                               label:'Kimi K2.6 (NVIDIA)',            released:'2026-06', contextK:128,  params:1000, media:['text'],                        tools:false, thinking:false, note:'1T MoE (32B active); coding agent; 256K context; Moonshot AI via NVIDIA NIM' },
    // ── OpenRouter (free tier only) ───────────────────────────────────────────
    // https://openrouter.ai/models
    { provider:'openrouter', model:'nvidia/nemotron-3-ultra-550b-a55b:free',             label:'Nemotron Ultra 550B (free)',    released:'2026-06', contextK:1000, params:550,  media:['text'],                        tools:true,  thinking:true,  rpm:20,  rpd:50,   note:'550B MoE (55B active); 1M context; highest-capability Nemotron reasoning; fn-tag tool calls; free via OpenRouter' },
    { provider:'openrouter', model:'nvidia/nemotron-3.5-lightning:free',                 label:'Nemotron 3.5 Lightning (free)', released:'2026-07', contextK:1000, params:30,   media:['text'],                        tools:true,  thinking:false, rpm:20,  rpd:50,   note:'30B MoE (3B active); 1M context; fast tool-capable model; free via OpenRouter' },
    { provider:'openrouter', model:'nvidia/nemotron-3-super-120b-a12b:free',              label:'Nemotron Super 120B (free)',    released:'2026-03', contextK:262,  params:120,  media:['text'],                        tools:false, thinking:true,  rpm:20,  rpd:50,   note:'High-capability reasoning; 262K context; free via OpenRouter' },
    { provider:'openrouter', model:'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', label:'Nemotron Nano Omni 30B (free)',released:'2026-04', contextK:256,  params:30,   media:['text','image'],                tools:false, thinking:true,  rpm:20,  rpd:50,   note:'Multimodal reasoning; 256K context; free via OpenRouter' },
    { provider:'openrouter', model:'google/gemma-4-31b-it:free',                         label:'Gemma 4 31B (free)',           released:'2026-04', contextK:262,  params:31,   media:['text','image'],                tools:true,  thinking:false, rpm:20,  rpd:50,   note:'Google Gemma 4 31B; 262K context; free via OpenRouter' },
    { provider:'openrouter', model:'google/gemma-4-26b-a4b-it:free',                     label:'Gemma 4 MoE 27B (free)',       released:'2026-04', contextK:262,  params:27,   media:['text','image'],                tools:true,  thinking:false, rpm:20,  rpd:50,   note:'Google Gemma 4 MoE (3.8B active); 262K context; free via OpenRouter' },
    { provider:'openrouter', model:'poolside/laguna-s-2.1:free',                          label:'Laguna S 2.1 (free)',          released:'2026-07', contextK:262,  params:118,  media:['text'],                        tools:true,  thinking:false, rpm:20,  rpd:50,   note:'Poolside Laguna S; 118B MoE (8B active); code-focused; 262K context; free via OpenRouter' },
    { provider:'openrouter', model:'poolside/laguna-xs-2.1:free',                         label:'Laguna XS 2.1 (free)',         released:'2026-07', contextK:262,  params:33,   media:['text'],                        tools:true,  thinking:false, rpm:20,  rpd:50,   note:'Poolside Laguna XS; 33B MoE (3B active); smallest Laguna; 262K context; free via OpenRouter' },
    { provider:'openrouter', model:'cohere/north-mini-code:free',                         label:'North Mini Code (free)',       released:'2026-07', contextK:256,  params:30,   media:['text'],                        tools:true,  thinking:false, rpm:20,  rpd:50,   note:'Cohere North Mini Code; 30B MoE (3B active); code specialist; 256K context; free via OpenRouter' },
    { provider:'openrouter', model:'z-ai/glm-5.2:free',                                  label:'GLM-5.2 (free)',               released:'2026-07', contextK:256,  params:744,  media:['text'],                        tools:true,  thinking:false, rpm:20,  rpd:50,   note:'ZhipuAI GLM-5.2; 744B MoE (40B active); fn-tag tool calls (<tool_use><tool_name>name</tool_name><arguments>{json}</arguments></tool_use>); free via OpenRouter' },
    { provider:'openrouter', model:'inclusionai/ling-3.0-flash-fin:free',               label:'Ling 3.0 Flash Fin (free)',     released:'2026-08', contextK:262,  params:124,  media:['text'],                        tools:true,  thinking:false, rpm:20,  rpd:50,   note:'Finance-focused MoE; 124B total (5.1B active); 262K context; free via OpenRouter' },
    { provider:'openrouter', model:'inclusionai/ling-3.0-flash-sante:free',             label:'Ling 3.0 Flash Sante (free)',   released:'2026-09', contextK:262,  params:124,  media:['text'],                        tools:true,  thinking:true,  rpm:20,  rpd:50,   note:'Health/medicine-focused MoE; 124B total (5.1B active); 262K context; free via OpenRouter' },
    { provider:'openrouter', model:'dots-studio/dots-3-note-preview:free',              label:'Dots3-Note Preview (free)',     released:'2026-08', contextK:512,  params:280,  media:['text'],                        tools:true,  thinking:false, rpm:20,  rpd:50,   note:'280B MoE (16B active); 512K context; free via OpenRouter' },
    { provider:'openrouter', model:'liquid/lfm-2.5-2.6b:free',                         label:'LFM2.5-2.6B (free)',           released:'2026-08', contextK:65,   params:2.6,  media:['text'],                        tools:true,  thinking:false, rpm:20,  rpd:50,   note:'LiquidAI compact reasoning model; 2.6B; agent/RAG-focused; free via OpenRouter' },
    { provider:'openrouter', model:'thinkingmachines/inkling-small:free',               label:'Inkling Small (free)',          released:'2026-07', contextK:1024, params:276,  media:['text','image'],                tools:true,  thinking:false, rpm:20,  rpd:50,   note:'Thinking Machines; 276B MoE (12B active); 1M context; multimodal; free via OpenRouter' },
    { provider:'openrouter', model:'thinkingmachines/inkling:free',                     label:'Inkling (free)',                released:'2026-07', contextK:1024, params:975,  media:['text','image'],                tools:true,  thinking:false, rpm:20,  rpd:50,   note:'Thinking Machines; 975B MoE (41B active); 1M context; multimodal; free via OpenRouter' },
    { provider:'openrouter', model:'minimax/minimax-m3:free',                           label:'MiniMax M3 (free)',             released:'2026-06', contextK:1048, params:428,  media:['text','image'],                tools:true,  thinking:false, rpm:20,  rpd:50,   note:'MiniMax M3; 428B MoE (23B active); multimodal; 1M context; free via OpenRouter' },
    { provider:'openrouter', model:'minimax/minimax-m2.7:free',                         label:'MiniMax M2.7 (free)',           released:'2026-03', contextK:196,  params:230,  media:['text'],                        tools:true,  thinking:false, rpm:20,  rpd:50,   note:'MiniMax M2.7; 230B MoE (10B active); 196K context; free via OpenRouter' },
    // ── OpenCode Zen (requires OpenCode API key or shared key on CF Worker) ──────
    // https://opencode.ai/docs/zen/#endpoints
    { provider:'opencode', model:'big-pickle',                        label:'Big Pickle (free)',               released:'2026-07', contextK:128,  params:null, media:['text'], tools:true,  thinking:false, note:'Large capable model; free via OpenCode Zen' },
    { provider:'opencode', model:'nemotron-3-ultra-free',             label:'Nemotron 3 Ultra (free)',         released:'2026-06', contextK:128,  params:550,  media:['text'], tools:true,  thinking:true,  note:'550B MoE (55B active); Nemotron 3 Ultra; powerful reasoning; free via OpenCode Zen' },
    { provider:'opencode', model:'mimo-v2.5-free',                    label:'MiMo-V2.5 (free)',                released:'2026-06', contextK:128,  params:310,  media:['text'], tools:true,  thinking:true,  note:'310B MoE (15B active); MiMo V2.5 reasoning model; free via OpenCode Zen' },
    { provider:'opencode', model:'nemotron-3.5-lightning-free',       label:'Nemotron 3.5 Lightning (free)',   released:'2026-07', contextK:262,  params:30,   media:['text'], tools:true,  thinking:false, note:'30B MoE (3B active); 262K context; fast tool-capable model; free via OpenCode Zen' },
    { provider:'opencode', model:'muse-spark-1.3-contributor-free',   label:'Muse Spark 1.3 Contributor (free)', released:'2026-08', contextK:128, params:null, media:['text'], tools:true,  thinking:false, note:'Muse Spark 1.3 Contributor; free via OpenCode Zen' },
    { provider:'opencode', model:'ling-3.0-flash-fin-free',           label:'Ling 3.0 Flash Fin (free)',         released:'2026-08', contextK:262, params:124,  media:['text'], tools:true,  thinking:false, note:'Finance-focused MoE; 124B total (5.1B active); 262K context; free via OpenCode Zen' },
    { provider:'opencode', model:'deepseek-v4-flash-free',            label:'DeepSeek V4 Flash (free)',          released:'2026-07', contextK:128, params:null, media:['text'], tools:true,  thinking:false, note:'DeepSeek V4 Flash; currently one of the most reliable free models on OpenCode Zen' },
    // ── Nous Portal ───────────────────────────────────────────────────────────
    // https://portal.nousresearch.com/models — 300+ models; rotating free tier (50 RPM / 500K TPM).
    // Free-model catalog rotates monthly; check portal for current availability.
    { provider:'nous', model:'stepfun/step-3.7-flash:free',          label:'Step 3.7 Flash (free)',        released:'2026-08', contextK:262, params:196, media:['text','image','video'], tools:true, thinking:true,  note:'196B MoE; 262K ctx; multimodal text/image/video; agent efficiency, coding, search; mandatory thinking; free via Nous Portal' },
    { provider:'nous', model:'meituan/longcat-2.0:free',             label:'LongCat 2.0 (free)',           released:'2026-08', contextK:1024,params:1600, media:['text'],                 tools:true, thinking:false, note:'1.6T MoE (48B active); 1M ctx; coding, repo-scale edits, long-horizon agentic; free via Nous Portal' },
    { provider:'nous', model:'poolside/laguna-s-2.1:free',           label:'Laguna S 2.1 (free)',          released:'2026-09', contextK:262, params:118, media:['text'],                 tools:true, thinking:true,  note:'118B MoE (8B active); 262K ctx; coding agent, 70.2% Terminal-Bench; free via Nous Portal' },
    { provider:'nous', model:'poolside/laguna-xs-2.1:free',          label:'Laguna XS 2.1 (free)',         released:'2026-09', contextK:262, params:33,  media:['text'],                 tools:true, thinking:true,  note:'33B MoE (3B active); 262K ctx; fast coding agent; free via Nous Portal' },
    { provider:'nous', model:'upstage/solar-pro4:free',              label:'Solar Pro 4 (free)',           released:'2026-09', contextK:524, params:null,media:['text'],                 tools:true, thinking:false, note:'524K ctx; long-horizon tasks, agentic workflows, office productivity; free via Nous Portal' },
    { provider:'nous', model:'inclusionai/ling-3.0-flash-fin:free',   label:'Ling 3.0 Flash Fin (free)',   released:'2026-08', contextK:262, params:124, media:['text'],                 tools:true, thinking:true,  note:'124B MoE (5.1B active); 262K ctx; finance-focused; real-world investment research; free via Nous Portal' },
    { provider:'nous', model:'inclusionai/ling-3.0-flash-sante:free', label:'Ling 3.0 Flash Sante (free)', released:'2026-09', contextK:262, params:124, media:['text'],                 tools:true, thinking:true,  note:'124B MoE (5.1B active); 262K ctx; health/medicine-focused; free via Nous Portal' },
    // ── TokenHarbor ───────────────────────────────────────────────────────────
    // https://tokenharbor.ai/models — unified multi-provider gateway; API key prefix: thk_live_
    // cooldownMs: 7-day flat cooldown on rate-limit/quota errors for free-tier weekly limits.
    { provider:'tokenharbor', model:'deepseek-v4-flash:free', label:'DeepSeek V4 Flash (free)', released:'2025-08', contextK:128, params:284,  media:['text'], tools:true, thinking:true,  cooldownMs: 604800000, note:'284B MoE (13B active); DeepSeek V4 Flash; free tier via TokenHarbor; weekly quota' },
    { provider:'tokenharbor', model:'mimo-v2.5:free',         label:'MiMo V2.5 (free)',         released:'2026-06', contextK:128, params:310,  media:['text'], tools:true, thinking:true,  cooldownMs: 604800000, note:'310B MoE (15B active); XiaomiAI MiMo V2.5 reasoning model; free tier via TokenHarbor; weekly quota' },
    // ── Kilo ─────────────────────────────────────────────────────────────────
    // https://kilo.ai — OpenAI-compatible inference gateway; :free models work without a key
    // (anonymous, 200 req/hour/IP). API key unlocks higher-tier models and rate limits.
    { provider:'kilo', model:'nvidia/nemotron-3-ultra-550b-a55b:free',         label:'Nemotron 3 Ultra 550B (free)',     released:'2025-08', contextK:1000, params:550, media:['text'],        tools:true, thinking:true,  noKey:true, note:'550B MoE (45B active); 1M ctx; deep reasoning; free via Kilo' },
    { provider:'kilo', model:'nvidia/nemotron-3-super-120b-a12b:free',          label:'Nemotron 3 Super 120B (free)',     released:'2025-08', contextK:262,  params:120, media:['text'],        tools:true, thinking:true,  noKey:true, note:'120B MoE (12B active); 262K ctx; free via Kilo' },
    { provider:'kilo', model:'nvidia/nemotron-3.5-lightning:free',              label:'Nemotron 3.5 Lightning (free)',    released:'2026-07', contextK:1000, params:30,  media:['text'],        tools:true, thinking:false, noKey:true, note:'30B MoE (3B active); 1M ctx; fast; free via Kilo' },
    { provider:'kilo', model:'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', label:'Nemotron 3 Nano Omni 30B (free)', released:'2026-06', contextK:256, params:30, media:['text','image'], tools:true, thinking:true,  noKey:true, note:'30B MoE (3B active); 256K ctx; omni reasoning; free via Kilo' },
    { provider:'kilo', model:'stepfun/step-3.7-flash:free',                     label:'Step 3.7 Flash (free)',            released:'2026-07', contextK:262,  params:198, media:['text'],        tools:true, thinking:true,  noKey:true, note:'198B MoE (11B active); 262K ctx; fast reasoning; free via Kilo' },
    { provider:'kilo', model:'poolside/laguna-s-2.1:free',                      label:'Laguna S 2.1 (free)',              released:'2026-09', contextK:262,  params:118, media:['text'],        tools:true, thinking:true,  noKey:true, note:'118B MoE (8B active); 262K ctx; coding agent; free via Kilo' },
    { provider:'kilo', model:'poolside/laguna-xs-2.1:free',                     label:'Laguna XS 2.1 (free)',             released:'2026-09', contextK:262,  params:33,  media:['text'],        tools:true, thinking:true,  noKey:true, note:'33B MoE (3B active); 262K ctx; fast coding agent; free via Kilo' },
    { provider:'kilo', model:'thinkingmachines/inkling:free',                   label:'Inkling (free)',                   released:'2026-09', contextK:1000, params:975, media:['text'],        tools:true, thinking:true,  noKey:true, note:'975B MoE (41B active); 1M ctx; reasoning model; free via Kilo' },
    { provider:'kilo', model:'thinkingmachines/inkling-small:free',             label:'Inkling Small (free)',             released:'2026-09', contextK:1000, params:276, media:['text'],        tools:true, thinking:true,  noKey:true, note:'276B MoE (12B active); 1M ctx; small fast reasoning model; free via Kilo' },
    { provider:'kilo', model:'dots-studio/dots-3-note-preview:free',            label:'Dots 3 Note (free)',               released:'2026-08', contextK:512,  params:280, media:['text'],        tools:true, thinking:false, noKey:true, note:'280B MoE (16B active); 512K ctx; long-context; free via Kilo' },
    { provider:'kilo', model:'cohere/north-mini-code:free',                     label:'North Mini Code (free)',           released:'2026-08', contextK:256,  params:30,  media:['text'],        tools:true, thinking:false, noKey:true, note:'30B MoE (3B active); 256K ctx; code-focused; free via Kilo' },

    // ── Vercel AI Gateway ──────────────────────────────────────────────────────
    // https://vercel.com/ai-gateway — OAI-compatible gateway; API key required for inference.
    // Free ($0/token) models available without credits; /models list may omit them — probed individually.
    // Model IDs use provider/model format (e.g. poolside/laguna-s-2.1-free).
    { provider:'vercel', model:'poolside/laguna-s-2.1-free',           label:'Laguna S 2.1 (free)',          released:'2026-09', contextK:256,  params:118,  media:['text'],        tools:true,  thinking:true,  note:'118B MoE (8B active); coding agent; reasoning; free via Vercel AI Gateway ($0/token)' },
    { provider:'vercel', model:'perplexity/sonar',                     label:'Sonar (free)',                 released:'2025-01', contextK:127,  params:null, media:['text','image'], tools:false, thinking:false, note:'127K ctx; built-in web search; no tool calling; free via Vercel AI Gateway' },
    { provider:'vercel', model:'perplexity/sonar-pro',                 label:'Sonar Pro (free)',             released:'2025-01', contextK:200,  params:null, media:['text','image'], tools:false, thinking:false, note:'200K ctx; advanced web search; no tool calling; free via Vercel AI Gateway' },
    { provider:'vercel', model:'perplexity/sonar-reasoning-pro',       label:'Sonar Reasoning Pro (free)',   released:'2025-03', contextK:127,  params:null, media:['text','image'], tools:false, thinking:true,  note:'127K ctx; web search + chain-of-thought reasoning; no tool calling; free via Vercel AI Gateway' },
    { provider:'vercel', model:'inclusionai/ling-3.0-flash-fin',       label:'Ling 3.0 Flash Fin (free)',    released:'2025-06', contextK:256,  params:124,  media:['text'],        tools:true,  thinking:true,  note:'124B MoE (5.1B active); finance domain; reasoning; free via Vercel AI Gateway ($0/token)' },
    { provider:'vercel', model:'inclusionai/ling-3.0-flash-sante',     label:'Ling 3.0 Flash Santé (free)',  released:'2025-06', contextK:256,  params:124,  media:['text'],        tools:true,  thinking:true,  note:'124B MoE (5.1B active); healthcare domain; reasoning; free via Vercel AI Gateway ($0/token)' },
];

function getEnabledModels() {
    const raw = ls(KEYS.ENABLED_MODELS, '');
    if (!raw) return MODEL_CATALOG.map(m => `${m.provider}|${m.model}`);
    try { return JSON.parse(raw); } catch { return MODEL_CATALOG.map(m => `${m.provider}|${m.model}`); }
}
function saveEnabledModels(arr) { localStorage.setItem(KEYS.ENABLED_MODELS, JSON.stringify(arr)); }

// ── Custom user-defined models ─────────────────────────────────────────────
function getCustomModels() {
    try { return JSON.parse(ls(KEYS.CUSTOM_MODELS, '[]')); } catch { return []; }
}
function saveCustomModels(arr) { localStorage.setItem(KEYS.CUSTOM_MODELS, JSON.stringify(arr)); }

// ── Hidden built-in models (user-removed) ─────────────────────────────────
function getHiddenModels(): Set<string> {
    try { return new Set(JSON.parse(ls(KEYS.HIDDEN_MODELS, '[]'))); } catch { return new Set(); }
}
function saveHiddenModels(set: Set<string>) {
    try { localStorage.setItem(KEYS.HIDDEN_MODELS, JSON.stringify([...set])); } catch {}
}
function hideBuiltinModel(key: string) {
    const s = getHiddenModels(); s.add(key); saveHiddenModels(s);
}
function unhideBuiltinModel(key: string) {
    const s = getHiddenModels(); s.delete(key); saveHiddenModels(s);
}

// All models = visible built-in catalog entries + user custom rows
function getAllModels() {
    const hidden = getHiddenModels();
    const builtins = hidden.size ? MODEL_CATALOG.filter(m => !hidden.has(`${m.provider}|${m.model}`)) : MODEL_CATALOG;
    // Exclude custom models whose key duplicates a built-in (avoids duplicates after a
    // built-in is added then the same model is later promoted to the built-in catalog).
    const builtinKeys = new Set(builtins.map(m => `${m.provider}|${m.model}`));
    const customs = getCustomModels().filter(m => !builtinKeys.has(`${m.provider}|${m.model}`));
    return [...builtins, ...customs];
}

// ── Priority model lists ───────────────────────────────────────────────────
// Each is an ordered array of "provider|model" strings.
// The first non-cooling entry is used; if all cool, wait for the shortest.

// Default priority list for new GitHub Pages users.
// Kilo :free models (noKey:true) work with zero configuration.
// OpenRouter models appear once the user sets an OpenRouter key.
// Order: best quality first, Kilo before OpenRouter within each tier for no-key users.
const _DEFAULT_MAIN_MODELS = [
    'kilo|thinkingmachines/inkling:free',              // 975B MoE, 1M ctx, reasoning
    'openrouter|thinkingmachines/inkling:free',        // same model, OpenRouter quota
    'kilo|nvidia/nemotron-3-ultra-550b-a55b:free',     // 550B MoE, 1M ctx, reasoning
    'openrouter|nvidia/nemotron-3-ultra-550b-a55b:free',
    'openrouter|minimax/minimax-m3:free',              // 428B MoE, 1M ctx, multimodal
    'kilo|poolside/laguna-s-2.1:free',                 // 118B MoE, coding agent
    'openrouter|poolside/laguna-s-2.1:free',
    'kilo|thinkingmachines/inkling-small:free',        // 276B MoE, 1M ctx, fast reasoning
    'kilo|stepfun/step-3.7-flash:free',                // 198B MoE, fast reasoning
    'openrouter|nvidia/nemotron-3.5-lightning:free',   // 30B, very fast, tools
];

function getMainModelList() {
    const _validSpec = spec => {
        if (typeof spec !== 'string' || !spec.length) return false;
        if (spec.indexOf('|') < 0) return false;
        // Keep only specs that exist in the current catalog or user-defined custom models.
        // Custom models added via the catalog UI are in fg_custom_models → getAllModels().
        return getAllModels().some(m => `${m.provider}|${m.model}` === spec);
    };

    const raw = ls(KEYS.MAIN_MODELS, '');
    if (raw) {
        try {
            const a = JSON.parse(raw);
            if (Array.isArray(a)) {
                const valid = [...new Set(a.filter(_validSpec))];
                if (valid.length !== a.length) {
                    // Prune stale entries (removed catalog models) and persist the clean list
                    try { localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify(valid)); } catch {}
                }
                // Return even if empty — an empty list means the user cleared it intentionally.
                // Only fall through to defaults when the key was never stored at all (raw is falsy).
                return valid;
            }
        } catch {}
    }
    // Migrate from legacy per-provider settings
    // Guard: only fall back to per-provider model when the key was actually stored.
    // A fresh localStorage has no PROVIDER key; ls() would return its 'google' default
    // and trap new devices into a single gemini-2.5-flash instead of _DEFAULT_MAIN_MODELS.
    const p = localStorage.getItem(KEYS.PROVIDER);
    if (!p) return [..._DEFAULT_MAIN_MODELS];
    if (p === 'google')      return [`google|${ls('fg_gemini_model', 'gemini-2.5-flash')}`];
    if (p === 'mistral')     return [`mistral|${ls('fg_mistral_model', 'mistral-medium-3.5')}`];
    if (p === 'nvidia')      return [`nvidia|${ls(KEYS.NVIDIA_MODEL, 'nvidia/nemotron-3-super-120b-a12b')}`];
    if (p === 'openrouter')  return [`openrouter|${ls('fg_openrouter_model', 'nvidia/nemotron-3-ultra-550b-a55b:free')}`];
    if (p === 'groq')        return [`groq|${ls(KEYS.GROQ_MODEL, 'openai/gpt-oss-120b')}`];
    if (p === 'cerebras')    return [`cerebras|${ls(KEYS.CEREBRAS_MODEL, 'gpt-oss-120b')}`];
    return [..._DEFAULT_MAIN_MODELS];
}
function saveMainModelList(arr) {
    const deduped = [...new Set((arr || []).filter(x => typeof x === 'string' && x.length > 0))];
    try { localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify(deduped)); }
    catch (e) {
        // Quota exceeded — clear and retry
        localStorage.removeItem(KEYS.MAIN_MODELS);
        try { localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify(deduped)); } catch {}
    }
}

// Paused model lists — models kept in the table but excluded from active routing
function getPausedMainModels() {
    try { const a = JSON.parse(ls(KEYS.PAUSED_MAIN, '[]')); return Array.isArray(a) ? a : []; } catch { return []; }
}
function savePausedMainModels(arr) {
    try { localStorage.setItem(KEYS.PAUSED_MAIN, JSON.stringify(arr || [])); } catch {}
}

// ── CF Worker shared-key cache ────────────────────────────────────────────────
// Maps env var name → true if the deployed CF Worker has that secret configured.
// Populated by loadCfWorkerKeys() on startup. Empty until then (safe default).
let _cfWorkerKeys: Record<string, boolean> = {};

// Maps provider → CF Worker env var name (matching PROVIDER_KEY_MAP / SEARCH_HEADER_MAP in worker.js)
const _CF_PROVIDER_ENV: Record<string, string> = {
    google:      'GEMINI_API_KEY',
    groq:        'GROQ_API_KEY',
    cerebras:    'CEREBRAS_API_KEY',
    openrouter:  'OPENROUTER_API_KEY',
    nous:        'NOUS_API_KEY',
    opencode:    'OPENCODE_API_KEY',
    tokenharbor: 'TOKENHARBOR_API_KEY',
    tavily:      'TAVILY_API_KEY',
    brave:       'BRAVE_API_KEY',
};

// Query the CF Worker /keys endpoint and cache which provider keys it has.
// Called once on startup when a CF Worker URL is configured.
export async function loadCfWorkerKeys(): Promise<void> {
    const proxy = typeof getLocalApiProxy === 'function' ? getLocalApiProxy() : '';
    if (!proxy) return;
    // Skip for same-origin proxy (local dev server — keys come from .env, not CF Worker)
    try { if (new URL(proxy).hostname === window.location.hostname) return; } catch { return; }
    try {
        const resp = await fetch(`${proxy}/keys`, { signal: AbortSignal.timeout(5_000) });
        if (resp.ok) {
            const data = await resp.json();
            if (data && typeof data === 'object') {
                _cfWorkerKeys = data;
                // Re-render model lists so newly-available providers appear
                if (typeof (window as any).renderMainModelList === 'function')
                    (window as any).renderMainModelList();
                if (typeof (window as any).renderModelCatalogTable === 'function')
                    (window as any).renderModelCatalogTable();
            }
        }
    } catch {}
}

// Returns true if the CF Worker has a shared Tavily API key configured.
export function hasCfTavilyKey(): boolean { return !!_cfWorkerKeys['TAVILY_API_KEY']; }
// Returns true if the CF Worker has a shared Brave Search API key configured.
export function hasCfBraveKey():  boolean { return !!_cfWorkerKeys['BRAVE_API_KEY'];  }

// Returns true when the user has a key configured for the given provider|model spec
// (or when the model works without a key). Mirrors _modelHasKey() in settings-ui.ts.
export function specHasKey(spec: string): boolean {
    const bar   = spec.indexOf('|');
    if (bar < 0) return true;
    const provider = spec.slice(0, bar);
    const model    = spec.slice(bar + 1);
    const entry    = getAllModels().find(m => m.provider === provider && m.model === model) as any;
    if (entry?.noKey) return true;
    if (entry?.key)   return true;
    if (provider === 'custom' || provider === 'vllm') return true;
    const _k = (fn: any) => typeof fn === 'function' && !!fn();
    if (provider === 'google')      return _k(getGeminiKey)    || !!_cfWorkerKeys[_CF_PROVIDER_ENV.google];
    if (provider === 'mistral')     return _k(getMistralKey);
    if (provider === 'groq')        return _k(getGroqKey)      || !!_cfWorkerKeys[_CF_PROVIDER_ENV.groq];
    if (provider === 'cerebras')    return _k(getCerebrasKey)  || !!_cfWorkerKeys[_CF_PROVIDER_ENV.cerebras];
    if (provider === 'openrouter')  return _k(getOpenRouterKey)|| !!_cfWorkerKeys[_CF_PROVIDER_ENV.openrouter];
    if (provider === 'nvidia')      return _k(getNvidiaKey);
    if (provider === 'nous')        return _k(getNousKey)      || !!_cfWorkerKeys[_CF_PROVIDER_ENV.nous];
    if (provider === 'opencode')    return _k(getOpenCodeKey)  || !!_cfWorkerKeys[_CF_PROVIDER_ENV.opencode];
    if (provider === 'tokenharbor') return _k(getTokenHarborKey) || !!_cfWorkerKeys[_CF_PROVIDER_ENV.tokenharbor];
    if (provider === 'kilo')        return _k(getKiloKey);
    if (provider === 'vercel')      return _k(getVercelKey);
    if (provider === 'openai')      return _k(getOAIKey);
    return true; // unknown provider — don't filter
}

// Active lists — full list minus paused models and models with no configured key
export function getActiveMainModelList() {
    const paused = new Set(getPausedMainModels());
    return getMainModelList().filter(k => !paused.has(k) && specHasKey(k));
}

// Returns the first active model spec that supports every required media type.
// requiredMedia: array of strings e.g. ['image'], ['audio'], ['image','audio']
// Returns 'provider|model' string or null.
function getMediaCapableSpec(requiredMedia) {
    if (!requiredMedia.length) return null;
    // Prefer explicitly configured media model if it covers all required types
    const _configured = [
        ls('fg_image_model', ''), ls('fg_audio_model', ''), ls('fg_video_model', ''),
    ].filter(Boolean);
    const all = getAllModels();
    for (const spec of _configured) {
        const bar   = spec.indexOf('|');
        if (bar < 0) continue;
        const entry = all.find(m => m.provider === spec.slice(0, bar) && m.model === spec.slice(bar + 1));
        if (!entry) continue;
        if (requiredMedia.every(t => (entry.media || ['text']).includes(t))) return spec;
    }
    // Fall back to active main models that cover all required types.
    // Prefer free-tier models (have rpm/rpd limits or :free suffix) over paid ones.
    const _isFree = (spec, entry) => entry.rpm != null || entry.rpd != null || spec.includes(':free');
    const _capable = getActiveMainModelList().filter(spec => {
        const bar = spec.indexOf('|');
        if (bar < 0) return false;
        const entry = all.find(m => m.provider === spec.slice(0, bar) && m.model === spec.slice(bar + 1));
        return entry && requiredMedia.every(t => (entry.media || ['text']).includes(t));
    });
    const _free = _capable.find(spec => {
        const bar = spec.indexOf('|');
        const entry = all.find(m => m.provider === spec.slice(0, bar) && m.model === spec.slice(bar + 1));
        return _isFree(spec, entry);
    });
    if (_free ?? _capable[0]) return _free ?? _capable[0];
    // No active model covers the needed media — fall back to the first catalog model that does.
    // Gemini 3.5 Flash is the only confirmed free audio model; this ensures audio routing works
    // even when it is not in the user's active rotation.
    const _catalogFallback = all.find(m => requiredMedia.every(t => (m.media || ['text']).includes(t)));
    return _catalogFallback ? `${_catalogFallback.provider}|${_catalogFallback.model}` : null;
}

// Configured media-specific model overrides (single model per media type, empty = auto)
function getImageModel() { return ls(KEYS.IMAGE_MODEL, ''); }
function getAudioModel() { return ls(KEYS.AUDIO_MODEL, ''); }
function getVideoModel() { return ls(KEYS.VIDEO_MODEL, ''); }
function saveImageModel(v) { localStorage.setItem(KEYS.IMAGE_MODEL, v || ''); }
function saveAudioModel(v) { localStorage.setItem(KEYS.AUDIO_MODEL, v || ''); }
function saveVideoModel(v) { localStorage.setItem(KEYS.VIDEO_MODEL, v || ''); }
// Utility model — single model used for title generation, prompt suggestions, and tool classification.
// '' (empty / default) = fall through to priority list.
// Worker model — used for all worker subagent (runWorkerTurn) calls.
// ''                  = next in model priority (default rotation, same as main chat)
// 'priority'          = always force the #1 model in the priority list
// 'provider|model'    = always use that specific model
function getWorkerModel() { return ls(KEYS.WORKER_MODEL, ''); }
function saveWorkerModel(v) { localStorage.setItem(KEYS.WORKER_MODEL, v ?? ''); }

// 'none'              = all utility LLM calls are disabled (no title gen, no suggestions).
// 'provider|model'    = use that specific model.
function getUtilityModel() { return ls(KEYS.UTILITY_MODEL, 'google|gemma-4-31b-it'); }
function saveUtilityModel(v) { localStorage.setItem(KEYS.UTILITY_MODEL, v ?? ''); }
function isUtilityDisabled() { return getUtilityModel() === 'none'; }

// Returns all catalog models supporting a given media type
function getAllModelsForMedia(mediaType) {
    return getAllModels().filter(m => (m.media || ['text']).includes(mediaType));
}
function buildModelCatalogText(enabledOnly = true) {
    const mainList = getMainModelList();
    const models  = enabledOnly
        ? getAllModels().filter(m => mainList.includes(`${m.provider}|${m.model}`))
        : getAllModels();
    const ORDER = ['google', 'mistral', 'groq', 'cerebras', 'nvidia', 'openrouter', 'opencode', 'nous', 'tokenharbor', 'kilo', 'vercel', 'custom'];
    const grouped = {};
    for (const m of models) {
        if (!grouped[m.provider]) grouped[m.provider] = [];
        grouped[m.provider].push(m);
    }
    return ORDER.filter(p => grouped[p])
        .map(p => `**${p.toUpperCase()}**\n` + grouped[p].map(m =>
            `- ${m.label} (${m.provider}|${m.model}): released ${m.released}, ${m.contextK}K ctx, media: ${m.media.join('/')}, tools: ${m.tools ? 'yes' : 'no'}, thinking: ${m.thinking ? 'yes' : 'no'}. ${m.note}`
        ).join('\n')).join('\n\n');
}

function getActiveModel() {
    const list = getActiveMainModelList();
    if (list.length) { const i = list[0].indexOf('|'); return i >= 0 ? list[0].slice(i + 1) : list[0]; }
    return ls('fg_openai_model', 'gpt-4o-mini');
}

const _tokenCache = new WeakMap();
export function estimateTokens(obj) {
    if (Array.isArray(obj)) {
        const cached = _tokenCache.get(obj);
        if (cached && cached.len === obj.length) return cached.val;
        const val = Math.ceil(JSON.stringify(obj).length / 4);
        _tokenCache.set(obj, { len: obj.length, val });
        return val;
    }
    return Math.ceil(JSON.stringify(obj).length / 4);
}

export function getContextThreshold() {
    const m = getActiveModel();
    const p = getProvider();
    const entry = getAllModels().find(x => x.provider === p && x.model === m);
    if (entry) return entry.contextK * 1000;
    // For custom provider, use configured max input tokens
    if (p === 'custom') return getOAIContextTokens();
    // Fallback by provider
    if (p === 'google')      return 800_000;
    if (p === 'mistral')     return 100_000;
    if (p === 'openrouter')  return 100_000;
    if (p === 'opencode')    return 100_000;
    if (p === 'nvidia')      return 100_000;
    if (/gpt-4|o1|o3|o4/.test(m)) return 100_000;
    return 128_000; // local/custom models: assume 128K
}

// Returns true when MODEL_CATALOG says this provider+model supports extended thinking.
// Derived from the catalog's thinking:true field — the single source of truth.
// Falls back to false for models not in the catalog (custom endpoints).
export function modelSupportsThinking(provider: string, model: string): boolean {
    return MODEL_CATALOG.some(m => m.provider === provider && m.model === model && m.thinking);
}

// Returns true only when the active model has an entry in MODEL_CATALOG with a known context size.
export function isContextSizeKnown() {
    const m = getActiveModel();
    const p = getProvider();
    return getAllModels().some(x => x.provider === p && x.model === m);
}

function updateModelLabel() {
    if (typeof updateActiveModelDisplay === 'function') updateActiveModelDisplay();
}
function _kFmt(n: number): string {
    if (n >= 10000) return `${Math.round(n / 1000)}k`;
    if (n >= 1000)  return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}
// No-arg accessor for TUI status bar — returns live estimate of current history
// token usage and the configured context limit without exposing openaiHistory directly.
// Tool schemas are sent as a separate `tools` param in callOAI and are not part of
// openaiHistory, so we add their estimate explicitly via the window-bridged buildOAITools.
export function getContextUsage(): { used: number; limit: number } {
    const histTokens  = estimateTokens(openaiHistory);
    const toolSchemas = typeof buildOAITools === 'function'
        ? buildOAITools() : [];
    const toolTokens  = toolSchemas.length ? estimateTokens(toolSchemas) : 0;
    return { used: histTokens + toolTokens, limit: getContextThreshold() };
}
function updateTokenLabel() {
    const toolSchemas = typeof buildOAITools === 'function'
        ? buildOAITools() : [];
    const toolTokens  = toolSchemas.length ? estimateTokens(toolSchemas) : 0;
    const t         = estimateTokens(openaiHistory) + toolTokens;
    const threshold = getContextThreshold();
    const pct       = threshold > 0 ? t / threshold : 0;
    // Show "4.2k / 128k"; hide below 100 tokens (empty chat)
    const text      = t > 100 ? `${_kFmt(t)} / ${_kFmt(threshold)}` : '';
    // token-warn at ≥70 %; token-danger at ≥90 %
    const cls = pct >= 0.9 ? 'token-danger' : pct >= 0.7 ? 'token-warn' : '';
    for (const id of ['agent-token-label', 'runner-token-label']) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.textContent = text;
        el.className   = cls;
    }
}

// ── Pyodide ────────────────────────────────────────────────────────────────
function updatePyodideStatusEl(text) {
    const el = document.getElementById('pyodide-status');
    if (el) el.textContent = text;
}
function startPyodide() {
    if (pyodideWorker) return pyodideReadyPromise;
    pyodideStatus = 'loading';
    updatePyodideStatusEl('Loading…');
    localStorage.setItem(KEYS.PYODIDE_AUTOLOAD, '1');
    let resolve, reject;
    pyodideReadyPromise = new Promise((res, rej) => { resolve = res; reject = rej; });
    // new URL pattern required for Vite to bundle the worker into dist/.
    // type:'classic' because pyodide-worker uses importScripts (not ES module imports).
    pyodideWorker = new Worker(new URL('./pyodide-worker.ts', import.meta.url), { type: 'classic' });
    pyodideWorker.onmessage = ({ data }) => {
        if (data.type === 'ready') {
            pyodideStatus = 'ready';
            updatePyodideStatusEl('Ready ✓');
            resolve();
        } else if (data.type === 'error') {
            pyodideStatus = 'error';
            updatePyodideStatusEl('Failed to load');
            reject(new Error(data.message));
            pyodideWorker = null;
        } else if (data.type === 'result') {
            const cb = pyodideCallbacks[data.id];
            if (cb) { cb(data); delete pyodideCallbacks[data.id]; }
        }
    };
    pyodideWorker.onerror = () => {
        pyodideStatus = 'error';
        updatePyodideStatusEl('Worker error');
        reject(new Error('Pyodide worker failed'));
        pyodideWorker = null;
    };
    return pyodideReadyPromise;
}
async function runWithPyodide(code, { filepath }: { filepath?: string } = {}) {
    if (pyodideStatus === 'loading') await pyodideReadyPromise;
    if (pyodideStatus !== 'ready') throw new Error('Pyodide not loaded');
    const wsFiles = await listWorkspaceFiles();
    const files   = Object.fromEntries(
        wsFiles
            .filter(f => typeof f.content === 'string' && f.content.length <= 512_000)
            // Binary IDB files (encoding='base64') are tagged so the worker writes binary bytes,
            // not the raw base64 string, into Pyodide's IDBFS.
            .map(f => [f.name, f.encoding === 'base64' ? `\x00BIN\x00${f.content}` : f.content])
    );
    // Include FSA local-folder files so Python can read and write them at local/ paths.
    // Skip large dirs (logs) to keep startup time reasonable.
    try {
        const allFiles = await agentListFiles();
        for (const f of allFiles) {
            if (!f.isLocal || /^local\/logs\//.test(f.name)) continue;
            try {
                const content = await agentReadFile(f.name);
                if (typeof content === 'string' && content.length <= 512_000)
                    files[f.name] = content;
            } catch {}
        }
    } catch {}
    const id = ++pyodideMsgId;
    return new Promise(resolve => {
        pyodideCallbacks[id] = async data => {
            const imageNames = [];
            const writeErrors: string[] = [];
            if (data.changedFiles && Object.keys(data.changedFiles).length) {
                for (const [name, content] of Object.entries(data.changedFiles)) {
                    if (content === null) {
                        await agentDeleteFile(name).catch(e => writeErrors.push(`delete ${name}: ${(e as any).message ?? e}`));
                    } else if (typeof content === 'string' && content.startsWith('\x00IMG\x00')) {
                        // Binary image — store as data URL for UI rendering; lives in IDBFS for Python
                        const parts = content.split('\x00'); // ['','IMG',mime,b64]
                        const dataUrl = `data:${parts[2]};base64,${parts[3]}`;
                        _pyodideImageStore = _pyodideImageStore || {};
                        _pyodideImageStore[name] = dataUrl;
                        imageNames.push(name);
                        // Also persist to IDB as base64 so download works
                        await agentWriteFile(name, parts[3], 'base64').catch(e => writeErrors.push(`write ${name}: ${(e as any).message ?? e}`));
                    } else if (typeof content === 'string' && content.startsWith('\x00BIN\x00')) {
                        // Non-image binary (xlsx, pdf, zip, …) — write to IDB with base64 encoding
                        const b64 = content.slice(5);
                        await agentWriteFile(name, b64, 'base64').catch(e => writeErrors.push(`write ${name}: ${(e as any).message ?? e}`));
                    } else {
                        // agentWriteFile routes local/ paths to FSA, bare names to IDB
                        try {
                            await agentWriteFile(name, content);
                            // SVG files are text but need special inline rendering in the chat
                            if (/\.svg$/i.test(name) && typeof content === 'string' && content.includes('<svg')) {
                                _pyodideImageStore = _pyodideImageStore || {};
                                _pyodideImageStore[name] = { type: 'svg', content };
                                imageNames.push(name);
                            }
                        } catch (e) {
                            writeErrors.push(`write ${name}: ${(e as any).message ?? e}`);
                        }
                    }
                }
                renderFileList?.();
            }
            let { stdout, stderr, exit_code } = data;
            if (imageNames.length)
                stdout = (stdout ? stdout + '\n' : '') + imageNames.map(n => `[IMAGE:${n}]`).join('\n');
            if (writeErrors.length)
                stderr = (stderr ? stderr + '\n' : '') + writeErrors.map(e => `[workspace-write-error] ${e}`).join('\n');
            resolve({ stdout, stderr, exit_code });
        };
        pyodideWorker.postMessage({ type: 'run', id, code, files, filepath });
    });
}
// ── WASM browser bash ─────────────────────────────────────────────────────
// Lazy import so the WASM runtime is only fetched when first used.
let _wasmShell: (() => Promise<any>) | null = null;

async function runWithWasm(code: string): Promise<{ stdout: string; stderr: string; exit_code: number }> {
    if (!_wasmShell) {
        // Dynamic import keeps the WASM bundle out of the critical path.
        const mod = await import(/* @vite-ignore */ './shiro/shell-singleton');
        _wasmShell = mod.getShell;
    }
    const shell = await _wasmShell!();
    const { stdout, stderr, exitCode } = await shell.exec(code);
    // Sync any files written inside /workspace back to the FreeGent workspace.
    // FWFileSystem writes them via agentWriteFile at write time, so no extra flush needed.
    return { stdout, stderr, exit_code: exitCode ?? 0 };
}

// ── Shared utilities ──────────────────────────────────────────────────────
// YAML frontmatter parser — used by both skills.js and tasks.js
function parseFrontmatter(content) {
    const norm  = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const match = norm.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
    if (!match) return {};
    const fm = {};
    for (const line of match[1].split('\n')) {
        const col = line.indexOf(':');
        if (col === -1) continue;
        const key = line.slice(0, col).trim();
        const val = line.slice(col + 1).trim().replace(/^["']|["']$/g, '');
        if (key) fm[key] = val;
    }
    return fm;
}

// ── Window bridge ─────────────────────────────────────────────────────────
// Mutable primitives: defineProperty so bare assignments in classic scripts trigger the setter.
// lastUserMessageText and _currentUserIntent moved to state.ts — their accessors are
// installed by state.js's bridge. Re-defining them here would shadow state's accessors
// with self-referential getters (infinite recursion once their local decls were removed).
for (const [name, getter, setter] of [
    ['agentsContext',       () => agentsContext,       v => { agentsContext = v; }],
    ['chatsDropdownOpen',   () => chatsDropdownOpen,   v => { chatsDropdownOpen = v; }],
    ['pyodideStatus',       () => pyodideStatus,       v => { pyodideStatus = v; }],
] as Array<[string, () => any, (v: any) => void]>) {
    Object.defineProperty(window, name, { get: getter, set: setter, enumerable: true, configurable: true });
}

// Constants, reference types, and all public functions:
Object.assign(window, {
    MAX_STEPS, ALL_TOOL_NAMES, OPT_IN_TOOLS, runWithPyodide, runWithWasm, skillsRegistry, activeSkills, disabledRoles, enabledTools, ls,
    getMode, setMode, isToolActive,
    isRoleEnabled, getRoleBody, setRoleBody, getRoleBodyFn, setRoleBodyFn, getProvider,
    getGeminiKey, getGeminiModel,
    getOAIUrl, getOAIKey, getOAIModel, getOAIContextTokens,
    getMistralKey, getMistralModel, getGroqKey, getCerebrasKey,
    getNvidiaKey, getNvidiaModel, getOpenRouterKey, getOpenRouterModel, getOpenCodeKey, getTokenHarborKey, getKiloKey, getVercelKey, getNousKey,
    getSearchProvider, getThinkingLevel, thinkingLevelBudget, getTemperature,
    getTopP, getTopK, getMinP, getPresencePenalty, getRepetitionPenalty, getSamplingParams,
    getTavilyKey, getHFKey, getSearchProxy, getEffectiveProxy, getLocalApiProxy,
    getBraveKey, getGithubToken, getStackExchangeKey,
    getSandboxProvider, getGeoCache, prefetchGeoCache,
    getAgentToolTruncation, getAgentMaxToolResult, getDirectorMaxToolResult,
    getAgentProactiveCompact, getAgentCompactAt, getAgentCompactTokens,
    getAgentPlanMode, getAgentMaxSteps, getAgentLeanWorkers,
    getAgentWorkerHistory, getAgentPromptTemplate, getAgentConcisePrompts,
    getAgentWorkerReduce, getAgentRoleModelRouting,
    getEndpointRotation, getRotationStepN, getAgentMaxDelegationDepth,
    getAgentLedger, getAgentReviewLogs,
    getAgentMaxReplans, getIntentValidation, setIntentValidation, getToolApproval,
    getRunnerMaxConsecutiveFails, getRateLimitCooldownMs,
    getRunnerQa, getGitEnabled, getAstEnabled,
    getQaEnabled, getQaTestRunner, getQaAcceptanceReview, getQaRegressionGuard, getQaReworkLimit,
    getShowNudges,
    getEditReviewEnabled, getWorkerThinkingBudget, getPreserveThinking,
    getEnabledModels, saveEnabledModels, getCustomModels, saveCustomModels,
    getHiddenModels, saveHiddenModels, hideBuiltinModel, unhideBuiltinModel,
    getAllModels, getMainModelList, saveMainModelList,
    getPausedMainModels, savePausedMainModels,
    getActiveMainModelList, specHasKey, loadCfWorkerKeys, hasCfTavilyKey, hasCfBraveKey,
    getMediaCapableSpec, getImageModel, getAudioModel, getVideoModel,
    saveImageModel, saveAudioModel, saveVideoModel, getAllModelsForMedia,
    getWorkerModel, saveWorkerModel,
    getUtilityModel, saveUtilityModel, isUtilityDisabled,
    buildModelCatalogText, getActiveModel, estimateTokens,
    getContextThreshold, isContextSizeKnown, getContextUsage, updateModelLabel, updateTokenLabel,
    updatePyodideStatusEl, startPyodide, parseFrontmatter,
    loadServerKeys,
    modelSupportsThinking,
    _pyodideImageStore,
    setDisabledTools,
});

function setDisabledTools(disabledList) {
    enabledTools.clear();
    // OPT_IN_TOOLS are disabled by default and must be explicitly enabled through a
    // dedicated Settings toggle — they are never re-enabled by omission from disabledList.
    // This mirrors the fresh-install initialisation so headless/benchmark runs also
    // respect the default-off semantics without having to enumerate OPT_IN tools in
    // --disable-tools.
    ALL_TOOL_NAMES
        .filter(t => !disabledList.includes(t) && !OPT_IN_TOOLS.has(t))
        .forEach(t => enabledTools.add(t));
    localStorage.setItem(KEYS.DISABLED_TOOLS, JSON.stringify(disabledList));
}
