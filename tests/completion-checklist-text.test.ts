// The completion checklist must not ask the model to repeat an answer the loop already keeps (_saveAnswer + a bare COMPLETED, see
// tests/loop-protocol.test.js): four of four self-analysis runs paid 700-1,000 tokens twice at the end of the run. The checklist is only built
// when a skill with a completion trigger matched, so the wording is checked in its two places, the code and the prompt documentation.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('completion checklist wording', () => {
    for (const file of ['skill-guidance.ts', 'docs/prompts/nudges-and-completion-gate.txt']) {
        it(`${file} tells the model to answer COMPLETED alone when nothing changes`, () => {
            const text = readFileSync(`${process.cwd()}/${file}`, 'utf8');
            expect(text).toContain('reply with COMPLETED alone: your answer above is kept');
            expect(text).not.toContain('restate your final answer exactly');
        });
    }
});

describe('code-fix-done skill wording', () => {
    it('does not tell the model to replace its answer by a "no change was required" conclusion (self-analysis: N4d1, N2w2, T03r3 delivered only that sentence instead of their report)', () => {
        const text = readFileSync(`${process.cwd()}/skills.ts`, 'utf8');
        expect(text).not.toContain('state that explicitly and output COMPLETED');
        expect(text).toContain('the answer is the deliverable; do not shorten it to the conclusion');
    });
});
