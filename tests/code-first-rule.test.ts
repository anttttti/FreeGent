import { describe, it, expect, beforeAll } from 'vitest';

// The code-first rule told every run to start with repo_map, an opt-in tool nobody had on (0 calls in 361 user logs).
describe('code-first rule', () => {
    const W = window as any;
    beforeAll(async () => { await import('../skills.ts'); await import('../config.ts'); });
    const body = () => W.BUILTIN_RULES.find((r: any) => r.name === 'code-first').body_fn() as string;
    it('names repo_map only when the tool is on', () => {
        const had = W.enabledTools.has('repo_map');
        try {
            W.enabledTools.delete('repo_map');
            expect(body()).not.toMatch(/repo_map/);
            expect(body()).toMatch(/search_workspace/);
            W.enabledTools.add('repo_map');
            expect(body()).toMatch(/Use \*\*repo_map\*\* for code tasks/);
        } finally { if (!had) W.enabledTools.delete('repo_map'); }
    });
});
