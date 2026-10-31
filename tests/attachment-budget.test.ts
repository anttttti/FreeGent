// codex R155: twelve text attachments of 50,000 characters each (the per-file cap) made one 601,080-character message.
import { describe, it, expect, beforeAll } from 'vitest';
let core: any;
beforeAll(async () => {
    (window as any).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    await import('../chat-attachments.ts');
    core = await import('../agent-core.ts');
});

describe('text attachments share one budget', () => {
    const file = (i: number, path?: string) => ({ name: `part-${i}.txt`, content: 'x'.repeat(50_000), workspacePath: path });
    it('never sends more than the budget, and points the model to the workspace copy of a file it left out', () => {
        const budget = core.attachmentBudgetChars(60_000);
        const text = core.attachmentTextBlocks(Array.from({ length: 12 }, (_, i) => file(i, `attachments/1/part-${i}.txt`)), budget);
        expect(text.length).toBeLessThan(budget + 12 * 300);
        expect(text).toContain('Original file: attachments/1/part-11.txt');
        expect(text).toMatch(/part-11\.txt">\nOriginal file: attachments\/1\/part-11\.txt\n\[Not included here.*Read the original file/);
        expect((text.match(/x{50000}/g) || []).length).toBe(Math.floor(budget / 50_000));
    });
    it('cuts a file with no workspace copy to what fits, and always sends one whole file', () => {
        const text = core.attachmentTextBlocks([file(0), file(1)], 70_000);
        expect(text).toContain('x'.repeat(50_000));
        expect(text).toMatch(/x{20000}\n…\[cut: the attachments together/);
    });
});
