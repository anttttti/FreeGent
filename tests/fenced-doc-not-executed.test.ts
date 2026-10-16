// A reply that shows a document (a README in a ```markdown fence, with shell examples inside) is
// content, not commands. Format I-b ran those examples (bench sim chat-readme, 2026-10-14:
// "show me the README" executed chmod/python3 snippets, then 10 failures stopped the turn).
import { describe, it, expect, beforeAll } from 'vitest';

const W = window as any;
beforeAll(async () => { await import('../model-caps.ts'); });

describe('parseFnTagCalls fenced shell blocks (Format I-b)', () => {
    it('still rescues a bare bash fence', () => {
        const r = W.parseFnTagCalls('Running it:\n```bash\nls -la\n```');
        expect(r.tool_calls.map((c: any) => JSON.parse(c.function.arguments).code)).toEqual(['ls -la']);
    });
    it('does not run shell examples inside a shown markdown document', () => {
        const t = '```markdown\n# Tool\n\n## Usage\n\n```bash\npython3 cli.py file.txt\n```\n```\n\nCOMPLETED';
        expect(W.parseFnTagCalls(t).tool_calls).toEqual([]);
    });
    it('does not run examples in a README shown without a wrapper (markdown headings around the fence)', () => {
        const t = 'Here is the README:\n\n# Tool\n\n## Usage\n\n```bash\npython3 cli.py file.txt\n```\n\nCOMPLETED';
        expect(W.parseFnTagCalls(t).tool_calls).toEqual([]);
    });
    it('still rescues a command narrated in a fence among prose', () => {
        const r = W.parseFnTagCalls('I will check the directory:\n```bash\nls -la\n```');
        expect(r.tool_calls).toHaveLength(1);
    });
});

describe('a request that says "show, do not run" keeps its shell fence', () => {
    const fence = 'Here is the example:\n```bash\necho hi > doc-example.txt\n```\nCOMPLETED';
    it.each([
        'Show a shell example as documentation only. Do not execute it or create files.',
        "don't run it, just show me the command",
        'Give an example snippet, documentation-only',
        'Write the command for the docs, without executing it',
    ])('userForbidsExecution: %s', async (ask) => {
        const { userForbidsExecution } = await import('../model-caps.ts');
        expect(userForbidsExecution(ask)).toBe(true);
        expect(W.parseFnTagCalls(fence, { fenceRescue: !userForbidsExecution(ask) }).tool_calls).toEqual([]);
    });
    it.each(['Count the lines in app.log', 'Run the tests and fix failures', 'list the files, then run them'])(
        'a task request leaves the rescue on: %s', async (ask) => {
            const { userForbidsExecution } = await import('../model-caps.ts');
            expect(userForbidsExecution(ask)).toBe(false);
            expect(W.parseFnTagCalls(fence, { fenceRescue: true }).tool_calls).toHaveLength(1);
        });
});
