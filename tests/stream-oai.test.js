// Tests for stream-decode.ts — SSE reading and response decoding. Headline coverage:
// streamOAICompat's reasoning/content boundary chunk bug (v0.10): vLLM packs the last
// reasoning tokens and the first content tokens into ONE SSE chunk under speculative
// decoding, and the echo-model suppression discarded that chunk's content, eating the
// first token of the final answer ("picoCTF{…}" → "icoCTF{…}", "29" → "9").
import { describe, it, expect } from 'vitest';
import { streamOAICompat, nonStreamOAICompat } from '../stream-decode.ts';

// Build a Response-like object whose body streams the given events as SSE lines.
function fakeSSEResp(events) {
    const enc = new TextEncoder();
    const lines = [...events.map(e => `data: ${JSON.stringify(e)}\n`), 'data: [DONE]\n'];
    let i = 0;
    return {
        body: {
            getReader: () => ({
                read: async () => i < lines.length
                    ? { value: enc.encode(lines[i++]), done: false }
                    : { value: undefined, done: true },
                cancel: async () => {},
                releaseLock: () => {},
            }),
        },
    };
}

async function run(events) {
    const chunks = [];
    const msg = await streamOAICompat(fakeSSEResp(events), (text, type) => chunks.push([type, text]));
    return { msg, chunks };
}

describe('streamOAICompat — reasoning/content boundary', () => {
    it('keeps the first content token when it arrives in the same chunk as the last reasoning delta (vLLM boundary chunk)', async () => {
        const { msg, chunks } = await run([
            { choices: [{ delta: { reasoning_content: 'Let me think about the flag.' } }] },
            // Boundary chunk: reasoning tail + first content token together (spec-decode batching)
            { choices: [{ delta: { reasoning_content: ' Done.', content: 'p' } }] },
            { choices: [{ delta: { content: 'icoCTF{abc123}' } }] },
        ]);
        expect(msg.content).toBe('picoCTF{abc123}');
        expect(chunks.filter(([t]) => t === 'output').map(([, s]) => s).join('')).toBe('picoCTF{abc123}');
        // reasoning_content must be present for preserve_thinking multi-turn continuity
        expect(msg.reasoning_content).toBe('Let me think about the flag. Done.');
    });

    it('still suppresses duplicated content for echo models (content === reasoning per delta)', async () => {
        const { msg } = await run([
            { choices: [{ delta: { reasoning_content: 'Let me think', content: 'Let me think' } }] },
            { choices: [{ delta: { reasoning_content: ' more.', content: ' more.' } }] },
            { choices: [{ delta: { content: 'final answer' } }] },
        ]);
        expect(msg.content).toBe('final answer');
    });

    it('passes content through untouched when there is no reasoning field at all', async () => {
        const { msg } = await run([
            { choices: [{ delta: { content: 'Hello' } }] },
            { choices: [{ delta: { content: ' world' } }] },
        ]);
        expect(msg.content).toBe('Hello world');
        // No thinking → reasoning_content must be absent (not an empty string key)
        expect('reasoning_content' in msg).toBe(false);
    });

    it('handles the multi-token boundary chunk (several answer chars in the mixed chunk)', async () => {
        const { msg } = await run([
            { choices: [{ delta: { reasoning_content: 'thinking…' } }] },
            { choices: [{ delta: { reasoning_content: ' done', content: '546578' } }] },
            { choices: [{ delta: { content: '742066' } }] },
        ]);
        expect(msg.content).toBe('546578742066');
    });
});

describe('nonStreamOAICompat — non-streaming decode', () => {
    const resp = json => ({ json: async () => json });
    it('decodes content + tool_calls and emits chunks', async () => {
        const chunks = [];
        const msg = await nonStreamOAICompat(resp({
            choices: [{ message: { content: 'hi', reasoning: 'thought', tool_calls: [{ function: { name: 'read_file' } }] } }],
            usage: { total_tokens: 5 },
        }), (t, type) => chunks.push([type, t]));
        expect(msg.content).toBe('hi');
        expect(msg.tool_calls).toHaveLength(1);
        expect(msg.usage.total_tokens).toBe(5);
        expect(chunks).toContainEqual(['thinking', 'thought']);
        expect(chunks).toContainEqual(['output', 'hi']);
        // reasoning_content must survive into the returned message for preserve_thinking
        expect(msg.reasoning_content).toBe('thought');
    });
    it('falls back to reasoning when content is empty, drops nameless tool_calls', async () => {
        const msg = await nonStreamOAICompat(resp({
            choices: [{ message: { content: '', reasoning: 'only thoughts', tool_calls: [{ function: {} }] } }],
        }), () => {});
        expect(msg.content).toBe('only thoughts');
        expect('tool_calls' in msg).toBe(false);
    });
    it('throws on a provider error body', async () => {
        await expect(nonStreamOAICompat(resp({ error: { message: 'boom' } }), () => {}))
            .rejects.toThrow('boom');
    });
    it('returns finish_reason from the choices array', async () => {
        const msg = await nonStreamOAICompat(resp({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        }), () => {});
        expect(msg.finish_reason).toBe('stop');
    });
    it('returns finish_reason:null when the field is absent', async () => {
        const msg = await nonStreamOAICompat(resp({
            choices: [{ message: { content: 'ok' } }],
        }), () => {});
        expect(msg.finish_reason).toBeNull();
    });
});

describe('streamOAICompat — finish_reason capture', () => {
    it('returns finish_reason:stop from the final chunk', async () => {
        const { msg } = await run([
            { choices: [{ delta: { content: 'Hello world.' } }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]);
        expect(msg.finish_reason).toBe('stop');
    });
    it('returns finish_reason:length when provider hit token cap', async () => {
        const { msg } = await run([
            { choices: [{ delta: { content: '| Product | Type |\n|---------|------|\n|' } }] },
            { choices: [{ delta: {}, finish_reason: 'length' }] },
        ]);
        expect(msg.finish_reason).toBe('length');
    });
    it('returns finish_reason:null when no chunk carries one (nemotron-style truncation)', async () => {
        const { msg } = await run([
            { choices: [{ delta: { content: 'Here is the table:\n\n| A | B |\n|---|---|\n|' } }] },
        ]);
        expect(msg.finish_reason).toBeNull();
    });
    it('captures finish_reason on a chunk that also has no delta field', async () => {
        // Some providers send finish_reason on a chunk with choices[0] having no delta key at all.
        const enc = new TextEncoder();
        const events = [
            { choices: [{ delta: { content: 'Done.' } }] },
            { choices: [{ finish_reason: 'stop' }] },  // no delta key
        ];
        const lines = [...events.map(e => `data: ${JSON.stringify(e)}\n`), 'data: [DONE]\n'];
        let i = 0;
        const fakeResp = {
            body: { getReader: () => ({
                read: async () => i < lines.length
                    ? { value: enc.encode(lines[i++]), done: false }
                    : { value: undefined, done: true },
                cancel: async () => {}, releaseLock: () => {},
            }) },
        };
        const msg = await streamOAICompat(fakeResp, () => {});
        expect(msg.finish_reason).toBe('stop');
    });
});

