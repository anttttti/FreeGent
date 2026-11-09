// codex R323: the deterministic "done" band of the GAPS check is a whole-line declaration, not any "none" in a sentence.
import { describe, it, expect } from 'vitest';
import { _DR_GAPS_CHECKS } from '../deep-research.ts';

const pass = (t: string) => _DR_GAPS_CHECKS[0].re_pass(t);

describe('deep research GAPS line', () => {
    it('a plain declaration that nothing is left passes without the judge', () => {
        for (const t of ['none', 'None.', 'No significant gaps remain.', 'no open questions', 'Coverage is sufficient', 'fully covered'])
            expect(pass(t), t).toBe(true);
    });
    it('a sentence that only uses the word goes to the judge', () => {
        expect(pass('None of the results are from official documentation; seek an official source')).toBe(false);
        expect(pass('Sufficient for pricing, but the 2025 figures are missing')).toBe(false);
    });
});

describe('deep research synthesis keeps the LAST GAPS line (codex R491)', () => {
    it('a GAPS: line quoted in the body does not decide the status', async () => {
        const { _drSynthesize } = await import('../deep-research.ts');
        (globalThis as any).callLLMComplete = async () => 'Report body.\nA source says:\nGAPS: none\nMore body.\nGAPS: the 2025 figures, the pricing page';
        (globalThis as any).validateOutput = undefined;
        const state: any = { question: 'q', round: 1, report: '', gaps: '' };
        const done = await _drSynthesize(state, 'findings');
        expect(state.gaps).toBe('the 2025 figures, the pricing page');
        expect(done).toBe(false);
        expect(state.report).toContain('GAPS: none');   // the quoted line stays in the report body
        expect(state.report).not.toContain('2025 figures');
    });
});
