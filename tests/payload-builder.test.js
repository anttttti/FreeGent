// Tests for buildChatPayload — the single OAI-format payload constructor.
// The headline test is the enable_thinking rule: the v0.10 regression (~55% of DSAEval
// wasted on 陪着 repetition loops) was one of three hand-built payload sites omitting
// chat_template_kwargs for custom endpoints. This file is the guard against that class.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const MSGS = [{ role: 'user', content: 'hi' }];
const base = { messages: MSGS, temperature: 0.2, maxTokens: 1000 };

    let _origCtx;
beforeAll(() => { _origCtx = window.getOAIContextTokens; });
afterAll(() => { window.getOAIContextTokens = _origCtx; });

describe('buildChatPayload — thinking control (the v0.10 bug class)', () => {
    it('custom endpoint + thinking off → EXPLICIT enable_thinking:false (never omitted)', () => {
        const p = window.buildChatPayload({ provider: 'custom', model: 'm', url: 'http://x/v1/chat/completions' },
            { ...base, thinkingBudget: 0 });
        expect(p.chat_template_kwargs).toEqual({ enable_thinking: false });
    });
    it("custom endpoint + budget → enable_thinking:true, and NO sampler budget field", () => {
        // 'custom' is a generic local endpoint (llama.cpp, LM Studio) with no reasoning
        // parser, so only the template kwarg applies. The sampler-level budget is a vLLM
        // feature and is named thinking_token_budget — see the vllm case below.
        const p = window.buildChatPayload({ provider: 'custom', model: 'm', url: 'http://x' },
            { ...base, thinkingBudget: 2048 });
        expect(p.chat_template_kwargs).toEqual({ enable_thinking: true });
        expect(p.thinking_token_budget).toBeUndefined();
    });

    it('vllm endpoint + budget → enable_thinking:true, preserve_thinking:true (default), and thinking_token_budget', () => {
        // preserve_thinking tells the chat template to re-insert reasoning_content as <think>
        // in subsequent turns — essential for multi-turn continuity with thinking models.
        const p = window.buildChatPayload({ provider: 'vllm', model: 'm', url: 'http://x' },
            { ...base, thinkingBudget: 2048 });
        expect(p.chat_template_kwargs).toEqual({ enable_thinking: true, preserve_thinking: true });
        expect(p.thinking_token_budget).toBe(2048);
    });
    it('vllm endpoint + budget + preserveThinking:false → enable_thinking:true but NO preserve_thinking', () => {
        const p = window.buildChatPayload({ provider: 'vllm', model: 'm', url: 'http://x' },
            { ...base, thinkingBudget: 2048, preserveThinking: false });
        expect(p.chat_template_kwargs).toEqual({ enable_thinking: true });
        expect(p.thinking_token_budget).toBe(2048);
    });
    it('nvidia + budget → reasoning_budget + enable_thinking:true', () => {
        const p = window.buildChatPayload({ provider: 'nvidia', model: 'm' },
            { ...base, thinkingBudget: 4096 });
        expect(p.reasoning_budget).toBe(4096);
        expect(p.chat_template_kwargs).toEqual({ enable_thinking: true });
    });
    it('hosted provider + thinking off → no chat_template_kwargs at all', () => {
        const p = window.buildChatPayload({ provider: 'groq', model: 'm' }, { ...base });
        expect('chat_template_kwargs' in p).toBe(false);
        expect('reasoning_budget' in p).toBe(false);
    });
    it('provider:openai small-ctx endpoint + budget → NO chat_template_kwargs (v0.14 ThinkingCap fix)', () => {
        // isCustomEndpoint returns true for small-ctx URL endpoints even with provider:'openai',
        // for token-clamping purposes. But 'openai' endpoints do NOT use a Qwen3 chat template —
        // sending enable_thinking:true caused ThinkingCap to produce only <think> blocks with
        // empty visible content, stripped by _stripThinking → 275/275 empty predictions.
        window.getOAIContextTokens = () => 30000;
        const p = window.buildChatPayload(
            { provider: 'openai', model: 'ThinkingCap', url: 'http://vllm/v1' },
            { ...base, thinkingBudget: 2048 });
        expect('chat_template_kwargs' in p).toBe(false);
        expect('reasoning_budget' in p).toBe(false);
    });
    it('provider:openai small-ctx endpoint + no budget → still no chat_template_kwargs', () => {
        window.getOAIContextTokens = () => 30000;
        const p = window.buildChatPayload(
            { provider: 'openai', model: 'ThinkingCap', url: 'http://vllm/v1' },
            { ...base, thinkingBudget: 0 });
        expect('chat_template_kwargs' in p).toBe(false);
    });
});

describe('buildChatPayload — reasoning_content stripping (Mistral 422 guard)', () => {
    const histWithReasoning = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'The answer is 42', reasoning_content: 'Let me think…' },
        { role: 'user', content: 'why?' },
    ];
    it('vllm → reasoning_content preserved in assistant messages (used by preserve_thinking)', () => {
        const p = window.buildChatPayload({ provider: 'vllm', model: 'm', url: 'http://x' },
            { messages: histWithReasoning, temperature: 0.2, maxTokens: 1000 });
        const asst = p.messages.find(m => m.role === 'assistant');
        expect(asst.reasoning_content).toBe('Let me think…');
    });
    it('mistral → reasoning_content stripped from assistant messages (avoids HTTP 422)', () => {
        const p = window.buildChatPayload({ provider: 'mistral', model: 'm' },
            { messages: histWithReasoning, temperature: 0.2, maxTokens: 1000 });
        const asst = p.messages.find(m => m.role === 'assistant');
        expect('reasoning_content' in asst).toBe(false);
        expect(asst.content).toBe('The answer is 42');  // content untouched
    });
    it('openrouter → reasoning_content stripped (cloud model ignores it; avoid unknown-field errors)', () => {
        const p = window.buildChatPayload({ provider: 'openrouter', model: 'm' },
            { messages: histWithReasoning, temperature: 0.2, maxTokens: 1000 });
        const asst = p.messages.find(m => m.role === 'assistant');
        expect('reasoning_content' in asst).toBe(false);
    });
    it('custom → reasoning_content stripped (no reasoning parser; field meaningless)', () => {
        const p = window.buildChatPayload({ provider: 'custom', model: 'm', url: 'http://x' },
            { messages: histWithReasoning, temperature: 0.2, maxTokens: 1000 });
        const asst = p.messages.find(m => m.role === 'assistant');
        expect('reasoning_content' in asst).toBe(false);
    });
    it('messages without reasoning_content pass through unchanged for all providers', () => {
        const plain = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
        for (const prov of ['vllm', 'mistral', 'openrouter', 'custom']) {
            const p = window.buildChatPayload({ provider: prov, model: 'm', url: 'http://x' },
                { messages: plain, temperature: 0.2, maxTokens: 1000 });
            expect(p.messages[1]).toEqual({ role: 'assistant', content: 'hello' });
        }
    });
});

describe('buildChatPayload — provider quirks', () => {
    it('openrouter → include_reasoning, tools WITHOUT tool_choice', () => {
        const p = window.buildChatPayload({ provider: 'openrouter', model: 'm' },
            { ...base, tools: [{ type: 'function' }] });
        expect(p.include_reasoning).toBe(true);
        expect(p.tools).toHaveLength(1);
        expect('tool_choice' in p).toBe(false);
    });
    it('non-openrouter with tools → tool_choice auto', () => {
        const p = window.buildChatPayload({ provider: 'custom', model: 'm', url: 'http://x' },
            { ...base, tools: [{ type: 'function' }] });
        expect(p.tool_choice).toBe('auto');
    });
    it('empty tools array → no tools/tool_choice keys', () => {
        const p = window.buildChatPayload({ provider: 'groq', model: 'm' }, { ...base, tools: [] });
        expect('tools' in p).toBe(false);
        expect('tool_choice' in p).toBe(false);
    });
    it('mistral → prompt_cache_key; nvidia → top_p 0.95; others → neither', () => {
        expect(window.buildChatPayload({ provider: 'mistral', model: 'm' }, base).prompt_cache_key).toBe('freegent');
        expect(window.buildChatPayload({ provider: 'nvidia', model: 'm' }, base).top_p).toBe(0.95);
        const g = window.buildChatPayload({ provider: 'groq', model: 'm' }, base);
        expect('prompt_cache_key' in g).toBe(false);
        expect('top_p' in g).toBe(false);
    });
    it('stream:true → stream_options include_usage; stream:false → none', () => {
        expect(window.buildChatPayload({ provider: 'groq', model: 'm' }, { ...base, stream: true }).stream_options)
            .toEqual({ include_usage: true });
        expect('stream_options' in window.buildChatPayload({ provider: 'groq', model: 'm' }, base)).toBe(false);
    });
});

describe('buildChatPayload — sampling overrides (runaway recovery hook)', () => {
    it('sampling fields win over the base temperature', () => {
        const p = window.buildChatPayload({ provider: 'custom', model: 'm', url: 'http://x' },
            { ...base, sampling: { temperature: 0.7, repetition_penalty: 1.1 } });
        expect(p.temperature).toBe(0.7);
        expect(p.repetition_penalty).toBe(1.1);
    });
});

describe('isCustomEndpoint', () => {
    it('provider custom → true regardless of window size', () => {
        expect(window.isCustomEndpoint({ provider: 'custom' })).toBe(true);
    });
    it('is provider-based, not URL/context heuristic (1b50ce8)', () => {
        // The old heuristic (any URL endpoint with context tightened below 50k) was replaced
        // by explicit provider routing when the 'vllm' provider was added. A hosted provider
        // is NOT custom regardless of URL or context window — declare it 'vllm'/'custom' if
        // it actually serves a Qwen3 template.
        expect(window.isCustomEndpoint({ provider: 'vllm' })).toBe(true);
        window.getOAIContextTokens = () => 26000;
        expect(window.isCustomEndpoint({ provider: 'openrouter', url: 'http://x' })).toBe(false);
        window.getOAIContextTokens = () => 50000;
        expect(window.isCustomEndpoint({ provider: 'openrouter', url: 'http://x' })).toBe(false);
    });
    it('no ep / no url → false', () => {
        expect(window.isCustomEndpoint(null)).toBe(false);
        expect(window.isCustomEndpoint({ provider: 'groq' })).toBe(false);
    });
});
