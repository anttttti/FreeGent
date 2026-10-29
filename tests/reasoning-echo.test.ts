// A model that needs every earlier reply's reasoning sent back (Vercel's Beam: HTTP 400 "Missing required parameter: 'messages[1].reasoning_content'")
// gets it, with a stand-in where it was not kept; every other provider still gets no reasoning_content.
import { describe, it, expect, afterEach } from 'vitest';
import { buildChatPayload, markModelNeedsReasoningEcho, modelNeedsReasoningEcho, clearReasoningEchoModels, withReasoningEcho, REASONING_NOT_KEPT } from '../payload-builder.ts';
import { isReasoningEchoDemand } from '../retry.js';

afterEach(() => clearReasoningEchoModels());
const beam = { provider: 'vercel', model: 'reflection/beam-free', url: 'https://x/v1/chat/completions', key: 'k' };
const history = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'Hi', reasoning_content: 'The user greets me.' },
    { role: 'user', content: 'list files' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_files', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'list_files', content: 'a.py' },
];
const req = (ep: any) => buildChatPayload(ep, { messages: history, temperature: 0.5, maxTokens: 100 });
const assistants = (p: any) => p.messages.filter((m: any) => m.role === 'assistant');

describe('reasoning echo', () => {
    it('recognises the 400 that asks for the reasoning back', () => {
        expect(isReasoningEchoDemand("[vercel|reflection/beam-free] HTTP 400: Missing required parameter: 'messages[1].reasoning_content'. This model needs the reasoning of every earlier assistant message: send back the 'reasoning_content' returned with that message.")).toBe(true);
        expect(isReasoningEchoDemand('HTTP 400: maximum context length is 30000 tokens')).toBe(false);
        expect(isReasoningEchoDemand('HTTP 422: unknown field reasoning_content')).toBe(false);
        expect(isReasoningEchoDemand('HTTP 400: Extra inputs are not permitted: messages[2].reasoning_content')).toBe(false);
    });
    it('sends Vercel Beam every reply\'s reasoning, and a stand-in where none was kept', () => {
        expect(modelNeedsReasoningEcho('vercel|reflection/beam-free')).toBe(true);
        const [a, b] = assistants(req(beam));
        expect(a.reasoning_content).toBe('The user greets me.');
        expect(b.reasoning_content).toBe(REASONING_NOT_KEPT);
        expect(b.tool_calls).toHaveLength(1);
    });
    it('strips it for other providers and models, as before', () => {
        for (const ep of [{ ...beam, provider: 'kilo' }, { ...beam, model: 'other/model' }])
            for (const m of assistants(req(ep))) expect(m).not.toHaveProperty('reasoning_content');
    });
    it('a model learned from the 400 gets it from then on', () => {
        const ep = { ...beam, provider: 'openrouter', model: 'some/model' };
        expect(assistants(req(ep))[0]).not.toHaveProperty('reasoning_content');
        markModelNeedsReasoningEcho('openrouter|some/model');
        expect(assistants(req(ep))[0].reasoning_content).toBe('The user greets me.');
    });
    it('withReasoningEcho leaves the other roles alone and never sends an empty reasoning', () => {
        const out = withReasoningEcho([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y', reasoning_content: '  ' }]);
        expect(out[0]).toEqual({ role: 'user', content: 'x' });
        expect(out[1].reasoning_content).toBe(REASONING_NOT_KEPT);
    });
});
