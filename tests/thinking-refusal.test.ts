// A model that rejects the thinking controls (NVIDIA z-ai/glm-5.3: "Unsupported parameter(s): `reasoning_budget`") is remembered and sent without them.
import { describe, it, expect, afterEach } from 'vitest';
import { buildChatPayload, markModelRejectsThinkingFields, modelRejectsThinkingFields, clearThinkingFieldRefusals, stripThinkingFields } from '../payload-builder.ts';
import { isThinkingFieldRefusal } from '../retry.js';

afterEach(() => clearThinkingFieldRefusals());
const nv = { provider: 'nvidia', model: 'z-ai/glm-5.3', url: 'https://x/v1/chat/completions', key: 'k' };
const req = (ep: any) => buildChatPayload(ep, { messages: [{ role: 'user', content: 'hi' }], temperature: 0.5, maxTokens: 100, thinkingBudget: 4096 });

describe('thinking-field refusal', () => {
    it('recognises a 400 that names a thinking control as unsupported', () => {
        expect(isThinkingFieldRefusal('[nvidia|z-ai/glm-5.3] HTTP 400: Validation: Unsupported parameter(s): `reasoning_budget`')).toBe(true);
        expect(isThinkingFieldRefusal('HTTP 400: unknown field "enable_thinking"')).toBe(true);
        expect(isThinkingFieldRefusal('HTTP 400: extra inputs are not permitted: thinking_token_budget')).toBe(true);
    });
    it('ignores other errors', () => {
        expect(isThinkingFieldRefusal('HTTP 400: maximum context length is 30000 tokens')).toBe(false);
        expect(isThinkingFieldRefusal('HTTP 429: reasoning_budget exceeded, unsupported plan')).toBe(false);
        expect(isThinkingFieldRefusal('HTTP 400: At most 0 image(s) may be provided')).toBe(false);
    });
    it('sends the control until the model is marked, then leaves it out', () => {
        expect(req(nv).reasoning_budget).toBe(4096);
        markModelRejectsThinkingFields('nvidia|z-ai/glm-5.3');
        expect(modelRejectsThinkingFields('nvidia|z-ai/glm-5.3')).toBe(true);
        const p = req(nv);
        expect(p.reasoning_budget).toBeUndefined();
        expect(p.chat_template_kwargs).toBeUndefined();
        expect(req({ ...nv, model: 'other/model' }).reasoning_budget).toBe(4096);   // another model keeps it
    });
    it('stripThinkingFields drops every thinking control and keeps the rest', () => {
        const p = stripThinkingFields({ model: 'm', temperature: 1, reasoning_budget: 1, thinking: { type: 'enabled' }, thinking_token_budget: 2, chat_template_kwargs: { enable_thinking: true, preserve_thinking: true, other: 1 } });
        expect(p).toEqual({ model: 'm', temperature: 1, chat_template_kwargs: { other: 1 } });
        expect(stripThinkingFields({ model: 'm', chat_template_kwargs: { enable_thinking: false } })).toEqual({ model: 'm' });
    });
});
