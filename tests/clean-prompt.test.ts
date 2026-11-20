import { describe, it, expect, afterEach } from 'vitest';
import './setup.js';
const W = globalThis as any;
const prev = process.env.FG_EXPERIMENTS;
afterEach(() => { if (prev === undefined) delete process.env.FG_EXPERIMENTS; else process.env.FG_EXPERIMENTS = prev; });
const director = (exp?: string) => {
    if (exp) process.env.FG_EXPERIMENTS = exp; else delete process.env.FG_EXPERIMENTS;
    W.setMainAgentRole?.('director');
    return W.buildSystemPrompt() as string;
};

describe('clean_prompt (experiment)', () => {
    it('is off by default: the Director prompt keeps its old wording', () => {
        const p = director();
        expect(p).toContain('validation theater');
        expect(p).toContain('only DONE or BLOCKED is');
        expect(p).toContain('**Text is never executed:**');
    });
    it('on: one stopping word, one verify rule, one output-style section, no repeated "text is not executed"', () => {
        const off = director(), on = director('clean_prompt');
        expect(on).not.toContain('validation theater');
        expect(on).not.toMatch(/\bDONE\b/);
        expect(on).toContain('only COMPLETED or BLOCKED ends the turn');
        expect(on).toContain('check an edit once, with the cheapest check that can fail');
        expect(on).toContain('print one as text only when the user asked for the code itself');
        expect(on).not.toContain('Never output a shell command or code snippet as your answer');
        expect(on).not.toContain('Respond in compressed, telegraphic');
        expect(on).not.toContain('## Conciseness');
        expect(on).not.toContain('**Text is never executed:**');
        expect(on.length).toBeLessThan(off.length);
        expect(on).toContain('## Honesty');   // the rest of the prompt is untouched
    });
    it('the debug skill drops "Call list_files" only when on', async () => {
        const { loadSkills } = await import('../skills.ts'); await loadSkills();
        const body = () => { const s = W.skillsRegistry.get('debug'); return typeof s.body_fn === 'function' ? s.body_fn() : s.body; };
        delete process.env.FG_EXPERIMENTS;
        expect(body()).toContain('Call list_files to orient yourself.');
        process.env.FG_EXPERIMENTS = 'clean_prompt';
        expect(body()).not.toContain('list_files');
        expect(body()).toContain('Read the file(s) named in the stack trace');
    });
});

describe('full_clean (experiment)', () => {
    it('keeps everything clean_prompt does, says "in parallel" once, drops the per-tool prose and the coder tool lists', () => {
        const off = director(), clean = director('clean_prompt'), full = director('full_clean');
        expect(full).not.toContain('validation theater');
        expect(full).not.toContain('Dispatch independent sub-tasks');
        expect(full).not.toContain('One `run_workers` call per logical phase');
        expect(full).toContain('including several run_workers agents');
        expect(clean).toContain('Dispatch independent sub-tasks');   // clean_prompt alone leaves those
        expect(full.length).toBeLessThan(clean.length);
        expect(clean.length).toBeLessThan(off.length);
        W.setMainAgentRole?.('coder');
        const coder = (exp?: string) => { if (exp) process.env.FG_EXPERIMENTS = exp; else delete process.env.FG_EXPERIMENTS; return W.buildSystemPrompt() as string; };
        expect(coder()).toContain('ONE keyword');
        expect(coder('clean_prompt')).toContain('ONE keyword');
        const c = coder('full_clean');
        expect(c).not.toContain('ONE keyword');
        expect(c).toContain('print one as text only when the user asked for the code itself');
    });
    it('the check_page and fetch_url descriptions change only when on', () => {
        const desc = (n: string) => W.buildOAITools(false).find((t: any) => t.function.name === n)?.function.description as string | undefined;
        delete process.env.FG_EXPERIMENTS;
        const f0 = desc('fetch_url'); if (f0) expect(f0).toContain('trigger api-calls guidance');
        process.env.FG_EXPERIMENTS = 'full_clean';
        const f1 = desc('fetch_url'); if (f1) { expect(f1).not.toContain('trigger api-calls guidance'); expect(f1).toContain('[UNAVAILABLE]'); }
    });
    it('code-first loses the quotation and the one-worker pattern only when full_clean is on', async () => {
        const { loadSkills } = await import('../skills.ts'); await loadSkills();
        const body = () => { const s = W.skillsRegistry.get('code-first'); return typeof s.body_fn === 'function' ? s.body_fn() : s.body; };
        delete process.env.FG_EXPERIMENTS; expect(body()).toContain('CORRECT PATTERN');
        process.env.FG_EXPERIMENTS = 'clean_prompt'; expect(body()).toContain('CORRECT PATTERN');
        process.env.FG_EXPERIMENTS = 'full_clean'; const b = body(); expect(b).not.toContain('CORRECT PATTERN'); expect(b).not.toContain('forbidden'); expect(b).toContain('Orient once');
    });
});
