// Hermes models write a parameter as <parameter=KEY> or as <parameter name="KEY">; Format A read only the first, so the attribute
// form reached the tool with empty arguments ("path is required"). Self-analysis task P6, which four agent runs did not fix.
import { it, expect, beforeAll } from 'vitest';
const W = window as any;
beforeAll(async () => { await import('../model-caps.ts'); });
const calls = (t: string) => W.parseFnTagCalls(t).tool_calls.map((c: any) => [c.function.name, JSON.parse(c.function.arguments)]);

it('the attribute form keeps its arguments, with either quote, and multi-line values intact', () => {
    expect(calls(`<tool_call><function=read_file><parameter name="path">a.ts</parameter></function></tool_call>`)).toEqual([['read_file', { path: 'a.ts' }]]);
    expect(calls(`<tool_call><function=read_file><parameter name='path'>a.ts</parameter></function></tool_call>`)).toEqual([['read_file', { path: 'a.ts' }]]);
    expect(calls(`<tool_call><function=write_file><parameter name="path">x.txt</parameter><parameter name="content">line1\nline2</parameter></function></tool_call>`))
        .toEqual([['write_file', { path: 'x.txt', content: 'line1\nline2' }]]);
});
it('values are JSON when they parse, as in the = form', () => {
    expect(calls(`<tool_call><function=read_file><parameter name="path">a.ts</parameter><parameter name="start_line">10</parameter></function></tool_call>`))
        .toEqual([['read_file', { path: 'a.ts', start_line: 10 }]]);
    expect(calls(`<tool_call><function=read_file><parameter=path>a.ts</parameter><parameter=start_line>10</parameter></function></tool_call>`))
        .toEqual([['read_file', { path: 'a.ts', start_line: 10 }]]);
});
it('the Anthropic <invoke> form accepts single quotes too, and other formats are unchanged', () => {
    expect(calls(`<invoke name="read_file"><parameter name='path'>b.ts</parameter></invoke>`)).toEqual([['read_file', { path: 'b.ts' }]]);
    expect(calls(`<invoke name="read_file"><parameter name="path">b.ts</parameter></invoke>`)).toEqual([['read_file', { path: 'b.ts' }]]);
    expect(calls(`<function=list_files>{"path":"src"}</function>`)).toEqual([['list_files', { path: 'src' }]]);
    expect(W.parseFnTagCalls('just prose, no call').tool_calls).toEqual([]);
});
