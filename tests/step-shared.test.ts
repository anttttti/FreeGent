import { describe, it, expect } from 'vitest';
import { collectRanAsBash, recordCallsAsBash, asBashArguments, summarizeRecentToolCalls } from '../step-shared.js';

describe('ran-as-bash bookkeeping (main and worker loops)', () => {
    it('collects and clears the marker', () => {
        const r1 = { tc: { id: 'a' }, result: { _ranAsBash: true, stdout: 'x' } };
        const r2 = { tc: { id: 'b' }, result: { stdout: 'y' } };
        expect([...collectRanAsBash([r1, r2])]).toEqual(['a']);
        expect(r1.result).toEqual({ stdout: 'x' });
    });
    it('rewrites the language of those calls in the latest assistant message only', () => {
        const hist: any[] = [
            { role: 'assistant', tool_calls: [{ id: 'old', function: { name: 'execute_code', arguments: '{"language":"python","code":"ls"}' } }] },
            { role: 'tool', tool_call_id: 'old', content: '{}' },
            { role: 'assistant', tool_calls: [
                { id: 'a', function: { name: 'execute_code', arguments: '{"language":"python","code":"ls"}' } },
                { id: 'b', function: { name: 'execute_code', arguments: '{"language":"python","code":"1+1"}' } }] },
        ];
        recordCallsAsBash(hist, new Set(['a']));
        expect(JSON.parse(hist[2].tool_calls[0].function.arguments).language).toBe('bash');
        expect(JSON.parse(hist[2].tool_calls[1].function.arguments).language).toBe('python');
        expect(JSON.parse(hist[0].tool_calls[0].function.arguments).language).toBe('python');
    });
    it('leaves unparsable arguments alone and is a no-op for an empty set', () => {
        expect(asBashArguments('not json')).toBe('not json');
        const hist: any[] = [{ role: 'assistant', tool_calls: [{ id: 'a', function: { arguments: '{"language":"python"}' } }] }];
        recordCallsAsBash(hist, new Set());
        expect(hist[0].tool_calls[0].function.arguments).toBe('{"language":"python"}');
    });
});

describe('summarizeRecentToolCalls', () => {
    it('lists the last n calls with their results', () => {
        const hist: any[] = [];
        for (let i = 1; i <= 6; i++) {
            hist.push({ role: 'assistant', tool_calls: [{ id: `c${i}`, function: { name: 'read_file', arguments: `{"path":"f${i}"}` } }] });
            hist.push({ role: 'tool', tool_call_id: `c${i}`, content: `result ${i}` });
        }
        const out = summarizeRecentToolCalls(hist, 4).split('\n');
        expect(out).toHaveLength(4);
        expect(out[0]).toBe('- read_file({"path":"f3"}) → result 3');
        expect(out[3]).toBe('- read_file({"path":"f6"}) → result 6');
        expect(summarizeRecentToolCalls([])).toBe('');
    });
});
