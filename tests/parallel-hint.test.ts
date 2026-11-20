import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import './setup.js';
const W = globalThis as any;

const read = (p = 'a.txt') => ({ name: 'read_file', args: { path: p }, result: { content: 'x' } });
const prev = process.env.FG_EXPERIMENTS;
beforeEach(() => { W.setReactiveFired(new Set()); W.setToolCallHistory([]); for (const k of Object.keys(W._failureCounts)) delete W._failureCounts[k]; });
afterEach(() => { if (prev === undefined) delete process.env.FG_EXPERIMENTS; else process.env.FG_EXPERIMENTS = prev; });

describe('parallel_hint (experiment)', () => {
    it('is off by default: no batch reminder after any number of single reads', () => {
        delete process.env.FG_EXPERIMENTS;
        for (let i = 0; i < 10; i++) expect(W.reactiveSkillGuidance([read(`f${i}`)])).not.toContain('batch-calls');
    });
    it('reminds after 3 single read-only steps, once, and again after 8', () => {
        process.env.FG_EXPERIMENTS = 'parallel_hint';
        const out = Array.from({ length: 10 }, (_, i) => W.reactiveSkillGuidance([read(`f${i}`)]));
        expect(out.map((o: string) => o.includes('### batch-calls'))).toEqual([false, false, true, false, false, false, false, true, false, false]);
        expect(out[2]).toContain('You made 3 read-only calls in a row');
    });
    it('a step with several calls, or a write, resets the streak', () => {
        process.env.FG_EXPERIMENTS = 'parallel_hint';
        W.reactiveSkillGuidance([read('a')]); W.reactiveSkillGuidance([read('b')]);
        expect(W.reactiveSkillGuidance([read('c'), read('d')])).not.toContain('batch-calls');
        expect(W.reactiveSkillGuidance([read('e')])).not.toContain('batch-calls');
        W.reactiveSkillGuidance([read('f')]);
        W.reactiveSkillGuidance([{ name: 'replace_in_file', args: {}, result: { success: true } }]);
        expect(W.reactiveSkillGuidance([read('g')])).not.toContain('batch-calls');
    });
    it('the system prompt block is a short batching hint', async () => {
        const { parallelHintBlock } = await import('../system-prompt.ts');
        expect(parallelHintBlock().length).toBeLessThan(200);
        expect(parallelHintBlock()).toContain('## Batching calls');
    });
});

describe('lean_change (experiment)', () => {
    it('the block names caller search, reuse, deletion, the never-cut list and the closing note; the prompt has it only when the switch is on', async () => {
        const { leanChangeBlock, buildSystemPrompt } = await import('../system-prompt.ts');
        const b = leanChangeBlock();
        for (const t of ['every caller', 'Deletion beats addition', 'Never cut', 'Before COMPLETED']) expect(b).toContain(t);
        delete process.env.FG_EXPERIMENTS;
        const off = buildSystemPrompt();
        expect(off).not.toContain('## The smallest complete change');
        process.env.FG_EXPERIMENTS = 'lean_change';
        expect(buildSystemPrompt()).toContain('## The smallest complete change');
    });
});
