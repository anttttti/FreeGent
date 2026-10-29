// Every earlier tool call is sent with a JSON object as its arguments (Nous Ornith 1.5: HTTP 400 "messages[20].tool_calls[5].function.arguments
// must be a JSON object encoded as a string"); the history keeps "" or broken text as the model sent it.
import { describe, it, expect } from 'vitest';
import { buildChatPayload, withObjectArgs } from '../payload-builder.ts';

const call = (id: string, name: string, args: any) => ({ id, type: 'function', function: { name, arguments: args } });
const history = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [call('a', 'run_tests', ''), call('b', 'read_file', '{"path":"x"}'), call('c', 'write_file', '{"path": "y'), call('d', 'list_files', '[1]')] },
    { role: 'tool', tool_call_id: 'a', content: 'ok' },
];

describe('tool-call arguments in the request', () => {
    it('are a JSON object for every provider; valid ones are unchanged', () => {
        for (const provider of ['nous', 'vllm', 'openrouter']) {
            const p = buildChatPayload({ provider, model: 'm', url: 'https://x/v1/chat/completions', key: 'k' }, { messages: history, temperature: 0.5, maxTokens: 100 });
            expect(p.messages[1].tool_calls.map((t: any) => t.function.arguments)).toEqual(['{}', '{"path":"x"}', '{}', '{}']);
            expect(p.messages[1].tool_calls.map((t: any) => t.id)).toEqual(['a', 'b', 'c', 'd']);
        }
        expect(history[1].tool_calls![0].function.arguments).toBe('');   // the history itself is not changed
    });
    it('passes messages whose calls are all objects through as they are', () => {
        const ok = [{ role: 'assistant', content: null, tool_calls: [call('b', 'read_file', '{"path":"x"}')] }];
        expect(withObjectArgs(ok)[0]).toBe(ok[0]);
    });
});
