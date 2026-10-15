// The text a user gets when a turn is force-stopped and the model's own summary is empty:
// what was tried, not only the stop reason (bench sim h-repeat-loop).
import { describe, it, expect, beforeAll } from 'vitest';

let mod: any;
beforeAll(async () => {
    await import('../model-caps.ts'); await import('../step-validator.ts');
    mod = await import('../llm-loops.ts');
});

describe('stop fallback', () => {
    it('names the reason and the last attempts, collapsing repeats', () => {
        mod._noteStopAttempts([
            { name: 'execute_code', args: { code: './build.sh' }, result: { exit_code: 127, stderr: 'build.sh: not found' } },
            { name: 'execute_code', args: { code: './build.sh' }, result: { exit_code: 127, stderr: 'build.sh: not found' } },
            { name: 'read_file', args: { path: 'Makefile' }, result: { error: 'File not found' } },
        ]);
        const t = mod._stopFallbackText('10 consecutive tool failures with no progress');
        expect(t).toMatch(/^I stopped because 10 consecutive tool failures with no progress\./);
        expect(t).toContain('`./build.sh` (×2) → exit 127: build.sh: not found');
        expect(t).toContain('read_file `Makefile` → error: File not found');
        expect(t).not.toContain('*(stopped');
    });
    it('is just the reason when nothing ran', () => {
        expect(mod._stopFallbackText('step budget exhausted', [])).toBe('I stopped because step budget exhausted.');
    });
});
