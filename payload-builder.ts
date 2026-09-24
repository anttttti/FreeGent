// payload-builder.ts — FreeGent: single builder for OpenAI-compatible request payloads.
//
// Every OAI-format call site (main streaming loop, worker/judge calls, compaction) MUST
// build its request body through buildChatPayload. The per-provider quirks — thinking
// kwargs, reasoning budgets, cache keys, tool_choice suppression — live here and nowhere
// else. History sanitization, token clamping, and fetch/retry stay with the callers.
//
// Why this module exists: the enable_thinking bug (v0.10 — ~55% of DSAEval wasted, the
// 陪着 repetition loops) was three call sites constructing the same payload and one of
// them missing a provider quirk. Payload divergence is a bug class, not a bug.
//
// Follows the step-validator/nudge-emitter pattern: ES module, exports, window bridge.

// A "custom" endpoint is vLLM/llama.cpp/LM Studio-style: explicit provider 'custom' or
// 'vllm'. These run Qwen3-style chat templates where thinking MUST be controlled
// explicitly — omitting enable_thinking means thinking ON (the v0.10 bug).
// Detection used to be heuristic (any URL endpoint with a context window tightened below
// the 50k default); 1b50ce8 replaced that with explicit provider routing when the 'vllm'
// provider was added, and the bench configs were moved to `"provider": "vllm"`.
// Consequence, deliberate (a947e08): an endpoint declared 'openai'/'openrouter' that
// actually serves a Qwen3 template will NOT get chat_template_kwargs. Declare it 'vllm'
// or 'custom' instead.
export function isCustomEndpoint(ep: any): boolean {
    if (!ep) return false;
    return ep.provider === 'custom' || ep.provider === 'vllm';
}

// Thinking-control fields for the payload. The rule, in one place:
// - NVIDIA with a budget → reasoning_budget + enable_thinking:true (their contract).
// - provider 'vllm': vLLM endpoint with --reasoning-parser configured. Sends both
//   chat_template_kwargs.enable_thinking (template-level) and thinking_token_budget
//   (sampler-level enforcement that forces </think> at exactly `budget` tokens,
//   preventing infinite thinking loops). Unknown to non-vLLM endpoints, ignored safely.
//   When preserveThinking is true (default), also sends preserve_thinking:true so the
//   chat template re-inserts reasoning_content as <think> in subsequent turns.
// - provider 'custom': generic local endpoint (llama.cpp, LM Studio, etc.).
//   Only chat_template_kwargs — no thinking_token_budget since no reasoning parser.
//   preserve_thinking not sent: no reasoning parser → no reasoning_content field.
// - provider 'openai': cloud OpenAI or any endpoint explicitly declared as 'openai'.
//   These are assumed NOT to use a Qwen3 chat template — chat_template_kwargs is not sent.
// - All other hosted providers → emit nothing (unknown fields risk strict-API 400s).
function _thinkingFields(provider: string, isCustom: boolean, budget: number, preserveThinking: boolean): object {
    // Sentinel -1 = 'default' thinking level: no thinking field sent at all so the endpoint
    // uses its own built-in default behaviour. Distinct from 'off' (budget 0) which actively
    // disables thinking on custom/vLLM endpoints via chat_template_kwargs.enable_thinking:false.
    if (budget < 0) return {};
    if (provider === 'google' && budget > 0)
        return { thinking: { type: 'enabled', budget_tokens: budget } };
    if (provider === 'nvidia' && budget > 0)
        return { reasoning_budget: budget, chat_template_kwargs: { enable_thinking: true } };
    if (provider === 'vllm')
        return budget > 0
            ? { chat_template_kwargs: { enable_thinking: true, ...(preserveThinking && { preserve_thinking: true }) }, thinking_token_budget: budget }
            : { chat_template_kwargs: { enable_thinking: false } };
    // OpenCode Zen is a cloud proxy — not a local vLLM endpoint — so it must NOT receive
    // chat_template_kwargs (a vLLM-internal field). Same for any other hosted provider.
    if (isCustom && provider !== 'openai')
        return { chat_template_kwargs: budget > 0
            ? { enable_thinking: true }
            : { enable_thinking: false } };
    return {};
}

// History → request messages, as every main-loop request sends them. Shared by callOAI and
// compaction so a compaction request repeats the main loop's messages byte for byte (the
// endpoint's prefix cache then covers the whole history).
//   1. drop bare assistant messages (content null, no tool_calls) — strict providers 400 on them
//   2. sanitize tool names to [a-zA-Z0-9_-]
//   3. non-NVIDIA: mid-conversation system messages (nudges) become <nudge> user messages
export function buildRequestMessages(hist: any[], provider: string): any[] {
    const _clean = (n: string) => (n || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const raw = hist
        .filter(m => !(m.role === 'assistant' && m.content == null && !m.tool_calls?.length))
        .map(m => {
            if (m.role === 'assistant' && m.tool_calls?.some(tc => tc.function?.name?.match(/[^a-zA-Z0-9_-]/)))
                return { ...m, tool_calls: m.tool_calls.map(tc => tc.function?.name?.match(/[^a-zA-Z0-9_-]/)
                    ? { ...tc, function: { ...tc.function, name: _clean(tc.function.name) } } : tc) };
            if (m.role === 'tool' && m.name?.match(/[^a-zA-Z0-9_-]/))
                return { ...m, name: _clean(m.name) };
            return m;
        });
    return provider !== 'nvidia'
        ? raw.map(m => m.role === 'system' ? { role: 'user', content: `<nudge>${m.content ?? ''}</nudge>` } : m)
        : raw;
}

export function buildChatPayload(ep: any, {
    messages,               // full messages array including system prompt — caller-sanitized
    tools = null,           // tool schema array, or null/[] for no tools
    temperature,            // number — callers own their default (settings / 0.1 / arg)
    maxTokens,              // number — caller-clamped where context windows apply
    stream = false,
    thinkingBudget = 0,     // 0 = thinking off (custom endpoints get an explicit false)
    preserveThinking = true, // vllm only: send preserve_thinking:true so the template re-inserts
                             // reasoning_content as <think> in subsequent turns (multi-turn continuity)
    sampling = null,        // { temperature?, top_p?, repetition_penalty?, presence_penalty? }
                            // one-shot overrides, e.g. runaway-recovery retries
    forceToolCall = false,  // set tool_choice:'required' to enforce a tool call on this step
}: {
    messages: any[];
    tools?: any[] | null;
    temperature: number;
    maxTokens: number;
    stream?: boolean;
    thinkingBudget?: number;
    preserveThinking?: boolean;
    sampling?: any;
    forceToolCall?: boolean;
}): any {
    const provider = ep?.provider ?? (typeof getProvider === 'function' ? getProvider() : 'custom');
    const isCustom = isCustomEndpoint(ep);

    // Strip reasoning_content from assistant messages for non-vllm providers.
    // vLLM understands the field (used by preserve_thinking to re-insert <think> blocks);
    // all other providers — including strict ones like Mistral/Devstral that reject unknown
    // fields with HTTP 422 — must not receive it.
    const _messages = provider === 'vllm'
        ? messages
        : messages.map(m => (m.role === 'assistant' && m.reasoning_content != null)
            ? (({ reasoning_content: _rc, ...rest }) => rest)(m)
            : m);

    const payload: any = {
        model: ep?.model ?? '',
        messages: _messages,
        ...(tools?.length && {
            tools,
            // OpenRouter rejects tool_choice for some routed models — omit entirely.
            // NVIDIA NIM fn-tag models don't support native tool_choice; they parse tool calls
            // from output text. Sending 'required' to them is at best ignored, at worst a 400.
            // vLLM/custom: send 'required' when forceToolCall (director turns). xgrammar may
            // fail intermittently on EOS/non-JSON first token — these are retried as 422s.
            // Blocking 'required' entirely causes the model to output prose instead of tool
            // calls in director multi-turn loops, which is far more damaging than rare retries.
            ...(provider !== 'openrouter' && provider !== 'nvidia' && {
                tool_choice: forceToolCall ? 'required' : 'auto',
            }),
        }),
        ...(provider === 'openrouter' && { include_reasoning: true }),
        ...(provider === 'mistral'    && { prompt_cache_key: 'freegent' }),
        ..._thinkingFields(provider, isCustom, thinkingBudget, preserveThinking),
        temperature,
        ...(provider === 'nvidia' && { top_p: 0.95 }),
        max_tokens: maxTokens,
        stream,
        // stream_options is not in Mistral's API contract — they reject unknown fields with 422.
        ...(stream && provider !== 'mistral' && { stream_options: { include_usage: true } }),
        ...(sampling ?? {}),
    };
    return payload;
}

// Window bridge for free-variable access from sibling modules (house pattern).
Object.assign(window, { buildChatPayload, buildRequestMessages, isCustomEndpoint });
