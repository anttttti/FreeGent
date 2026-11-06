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
});
