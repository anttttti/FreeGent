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
