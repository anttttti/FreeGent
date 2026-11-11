import { describe, it, expect, beforeEach } from 'vitest';

const W = globalThis as any;

describe('review: reactiveSkillGuidance and _matchNeedle edge cases', () => {
    beforeEach(() => {
        W.skillsRegistry.clear();
        W._reactiveFired.clear();
    });

    it('matches quoted string values and empty string comparisons in tool trigger conditions', () => {
        W.skillsRegistry.set('test-quoted-skill', {
            name: 'test-quoted-skill',
            trigger_on_tool: 'execute_code=>stdout==""',
            body: 'stdout was empty',
        });

        const guidance = W.reactiveSkillGuidance([{
            name: 'execute_code',
            args: { code: 'true' },
            result: { stdout: '', exit_code: 0 },
        }]);

        expect(guidance).toContain('test-quoted-skill');
    });

    it('an empty needle or a zero repeat threshold matches nothing (R1172, R1173)', () => {
        W.skillsRegistry.set('empty-needle', { name: 'empty-needle', trigger_on_tool: 'execute_code=>', body: 'x' });
        W.skillsRegistry.set('zero-repeat', { name: 'zero-repeat', trigger_on_repeat: 'read_file x0', body: 'y' });
        const g = W.reactiveSkillGuidance([{ name: 'execute_code', args: {}, result: { stdout: 'anything', exit_code: 0 } }]);
        expect(g).not.toContain('empty-needle');
        expect(g).not.toContain('zero-repeat');
    });

    it('matches string comparison when value is enclosed in quotes', () => {
        W.skillsRegistry.set('test-status-skill', {
            name: 'test-status-skill',
            trigger_on_tool: 'custom_tool=>status=="failed"',
            body: 'status was failed',
        });

        const guidance = W.reactiveSkillGuidance([{
            name: 'custom_tool',
            args: {},
            result: { status: 'failed' },
        }]);

        expect(guidance).toContain('test-status-skill');
    });

    it('does not throw when result contains a BigInt value', () => {
        W.skillsRegistry.set('test-search-needle', {
            name: 'test-search-needle',
            trigger_on_tool: 'custom_tool=>error_needle',
            body: 'error needle found',
        });

        expect(() => {
            W.reactiveSkillGuidance([{
                name: 'custom_tool',
                args: {},
                result: { size: 100n, message: 'some error_needle occurred' },
            }]);
        }).not.toThrow();
    });

    it('`field==` with nothing after it is "empty" only under the empty_compare experiment', () => {
        const prev = process.env.FG_EXPERIMENTS;
        W.skillsRegistry.set('test-empty-compare', { name: 'test-empty-compare', trigger_on_tool: 'execute_code=>exit_code!=0&&stdout==', body: 'debug it' });
        const call = () => W.reactiveSkillGuidance([{ name: 'execute_code', args: { code: 'false' }, result: { stdout: '', exit_code: 1 } }]);
        try {
            delete process.env.FG_EXPERIMENTS;
            expect(call() || '').not.toContain('test-empty-compare');   // as shipped: the trigger never fires
            W._reactiveFired.clear();
            process.env.FG_EXPERIMENTS = 'empty_compare';
            expect(call()).toContain('test-empty-compare');
        } finally { if (prev === undefined) delete process.env.FG_EXPERIMENTS; else process.env.FG_EXPERIMENTS = prev; }
    });

    it('short_guidance gives failure-recovery only the paragraph for its cause; without it the whole body', async () => {
        const prev = process.env.FG_EXPERIMENTS;
        await import('../skills.ts');   // the built-ins are not loaded by setup.js
        const fr = W.BUILTIN_SKILLS.find((s: any) => s.name === 'failure-recovery');
        const twoErrors = () => {
            W._reactiveFired.clear();
            for (const k of Object.keys(W._failureCounts)) delete W._failureCounts[k];
            W.skillsRegistry.set(fr.name, fr);
            const r = { name: 'read_file', args: { path: 'a.txt' }, result: { error: 'not found' } };
            return W.reactiveSkillGuidance([r, r]);
        };
        try {
            delete process.env.FG_EXPERIMENTS;
            const full = twoErrors();
            expect(full).toContain('**General**');
            process.env.FG_EXPERIMENTS = 'short_guidance';
            const short = twoErrors();
            expect(short).toContain('### failure-recovery\n**A tool call failed**');
            expect(short).not.toContain('**Same tool repeated**');
            expect(short.length).toBeLessThan(full.length / 2);
        } finally { if (prev === undefined) delete process.env.FG_EXPERIMENTS; else process.env.FG_EXPERIMENTS = prev; }
    });
});
