import { describe, it, expect, beforeEach } from 'vitest';
import { toolSig, sameCallCrashed, toolCrashCount, commandScripts, describeToolCrash } from '../page-check-guard.ts';

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
    it('the order of the arguments does not make a call a new one (D031)', () => {
        rec(toolSig('execute_code', { language: 'bash', code: 'echo x', timeout_s: 30 }), 500);
        for (const args of [{ code: 'echo x', language: 'bash', timeout_s: 30 }, { timeout_s: 30, code: 'echo x', language: 'bash' }])
            expect(sameCallCrashed(toolSig('execute_code', args), 500)).toEqual({ at: 1000, seconds: 30 });
    });
    it('counts the crashes in a task\'s done gate', () => {
        localStorage.setItem('fg_tool_crashes', JSON.stringify([{ calls: [{ name: 'task', label: 'task:007-x.md → done [gate test-runner]', t: 1 }], beat: 2 }, { calls: [{ name: 'task', label: 'task:007-x.md → done [gate test-runner]', t: 3 }], beat: 4 }]));
        expect(toolCrashCount('007-x.md → done [gate test-runner]')).toBe(2);
        expect(toolCrashCount('008-y.md → done [gate test-runner]')).toBe(0);
        expect(toolCrashCount('→ done [gate test-runner]', 24 * 3_600_000)).toBe(0);   // both are from 1970: not within the last day
        const now = Date.now();
        localStorage.setItem('fg_tool_crashes', JSON.stringify([{ calls: [{ name: 'task', label: 'task:009-z.md → done [gate test-runner]', t: now - 1000 }], beat: now }]));
        expect(toolCrashCount('→ done [gate test-runner]', 24 * 3_600_000)).toBe(1);
    });
    it('a chain or pipe that runs the scripts of a crashed command is that crash again, a different file state or script set is not', () => {
        const code = 'cd /workspace && node check_chem.mjs && echo "===" && node check_chem2.mjs';
        expect(commandScripts(code)).toEqual(['check_chem.mjs', 'check_chem2.mjs']);
        expect(commandScripts('node ./a.mjs | head -5; python3 -u b.py; timeout 20 node c.mjs')).toEqual(['a.mjs', 'b.py', 'c.mjs']);   // pipes, `;` and a `timeout` prefix do not hide a script
        localStorage.setItem('fg_tool_crashes', JSON.stringify([{ calls: [{ name: 'execute_code', label: 'x', t: 1000, sig: 's1', ws: 500, scripts: ['check_chem.mjs', 'check_chem2.mjs'] }], chatId: null, session: 's', version: 'v', beat: 31_000 }]));
        const longer = commandScripts(code + ' && node check_cpz.mjs');
        expect(sameCallCrashed('other', 500, longer)).toMatchObject({ seconds: 30, script: 'check_chem.mjs, check_chem2.mjs' });
        expect(sameCallCrashed('other', 501, longer)).toBeNull();                                   // a file changed
        expect(sameCallCrashed('other', 500, ['check_chem.mjs'])).toBeNull();                       // only part of the crashed set: the culprit may be the other script
        expect(sameCallCrashed('other', 500, ['check_cpz.mjs'])).toBeNull();
    });
    it('a crash note gives the JS heap at the last beat, and says memory when it was near the limit', () => {
        const c = { calls: [{ name: 'execute_code', label: 'x', t: 1000 }], chatId: null, session: 's', version: 'v', beat: 5000 };
        expect(describeToolCrash({ ...c, heapMb: 300, heapLimitMb: 4000 })).toContain('JS heap 300 MB of 4000 MB');
        expect(describeToolCrash({ ...c, heapMb: 300, heapLimitMb: 4000 })).not.toContain('out of memory');
        expect(describeToolCrash({ ...c, heapMb: 3500, heapLimitMb: 4000 })).toContain('out of memory');
        expect(describeToolCrash(c)).not.toContain('heap');
    });
});
