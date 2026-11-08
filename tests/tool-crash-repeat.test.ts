import { describe, it, expect, beforeEach } from 'vitest';
import { toolSig, sameCallCrashed, toolCrashCount } from '../page-check-guard.ts';

// Uploaded logs (23 sessions, 48 tab crashes): the same `node test_imports.mjs && …` took the tab down four times in four minutes.
describe('a call that took the tab down is recognised by its tool, arguments and the state of the files', () => {
    beforeEach(() => localStorage.clear());
    const rec = (sig: string, ws: number) => localStorage.setItem('fg_tool_crashes', JSON.stringify([{ calls: [{ name: 'execute_code', label: 'x', t: 1000, sig, ws }], chatId: null, session: 's', version: 'v', beat: 31_000 }]));
    it('same call, same files: crashed before; changed files or another command: new attempt', () => {
        const sig = toolSig('execute_code', { language: 'bash', code: 'node test_a.mjs' });
        rec(sig, 500);
        expect(sameCallCrashed(sig, 500)).toEqual({ at: 1000, seconds: 30 });
        expect(sameCallCrashed(sig, 501)).toBeNull();
        expect(sameCallCrashed(toolSig('execute_code', { language: 'bash', code: 'node test_b.mjs' }), 500)).toBeNull();
    });
    it('counts the crashes in a task\'s done gate', () => {
        localStorage.setItem('fg_tool_crashes', JSON.stringify([{ calls: [{ name: 'task', label: 'task:007-x.md → done [gate test-runner]', t: 1 }], beat: 2 }, { calls: [{ name: 'task', label: 'task:007-x.md → done [gate test-runner]', t: 3 }], beat: 4 }]));
        expect(toolCrashCount('007-x.md → done [gate test-runner]')).toBe(2);
        expect(toolCrashCount('008-y.md → done [gate test-runner]')).toBe(0);
    });
});
