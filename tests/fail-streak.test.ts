// fail-streak.test.ts — the "consecutive tool failures" stop counts only real failures.
// Silent exit-0 runs (mkdir, curl with an empty body) and missing-environment errors are neutral;
// v0.56 stopped TAC pm-schedule-meeting-1 at step 11 on nine empty curl bodies, and SWE runs on
// missing pytest before any edit. The step that triggers the stop is logged.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { makeReplayFetch, FAKE_EP } from './replay-harness.ts';
import { NULL_RENDER_ADAPTER } from '../render-adapter.ts';
import { KEYS } from '../storage-keys.ts';
import { failStreakKind, updateFailStreak } from '../detectors.ts';

const W = window as any;
const RO = new Set(['read_file', 'list_files', 'search_workspace', 'fetch_url']);

beforeAll(async () => {
    await import('../llm-loops.ts');
    await import('../chat-state.ts');
    await import('../step-validator.ts');
});

describe('failStreakKind', () => {
    it('treats a silent exit-0 run as neutral, not a failure', () => {
        expect(failStreakKind('execute_code', { stdout: '', stderr: '', exit_code: 0 }, RO)).toBe('neutral');
    });
    it('treats output or written files as progress', () => {
        expect(failStreakKind('execute_code', { stdout: 'ok\n', exit_code: 0 }, RO)).toBe('progress');
        expect(failStreakKind('execute_code', { stdout: '', exit_code: 0, files_written: ['a.py'] }, RO)).toBe('progress');
        expect(failStreakKind('write_file', { path: 'a.py' }, RO)).toBe('progress');
    });
    it('counts non-zero exits and tool errors', () => {
        expect(failStreakKind('execute_code', { stderr: 'AssertionError', exit_code: 1 }, RO)).toBe('fail');
        expect(failStreakKind('replace_in_file', { error: 'old_string not found' }, RO)).toBe('fail');
    });
    it('treats missing-environment errors as neutral', () => {
        expect(failStreakKind('execute_code', { stderr: '/usr/bin/python3: No module named pytest\n', exit_code: 1 }, RO)).toBe('neutral');
        expect(failStreakKind('execute_code', { stderr: 'error: externally-managed-environment\n', exit_code: 1 }, RO)).toBe('neutral');
        expect(failStreakKind('execute_code', { stderr: 'bash: line 1: pytest: command not found\n', exit_code: 127 }, RO)).toBe('neutral');
    });
    it('keeps read-only tools neutral even when they fail', () => {
        expect(failStreakKind('read_file', { error: 'File not found' }, RO)).toBe('neutral');
    });
});

describe('updateFailStreak', () => {
    it('resets on progress, adds failures, holds on neutral steps', () => {
        const fail = { name: 'execute_code', result: { stderr: 'boom', exit_code: 2 } };
        const silent = { name: 'execute_code', result: { stdout: '', exit_code: 0 } };
        const ok = { name: 'execute_code', result: { stdout: '1', exit_code: 0 } };
        let n = updateFailStreak(0, [fail, fail], RO);
        expect(n).toBe(2);
        n = updateFailStreak(n, [silent], RO);
        expect(n).toBe(2);
        n = updateFailStreak(n, [{ name: 'list_files', result: { files: [] } }], RO);
        expect(n).toBe(2);
        expect(updateFailStreak(n, [fail, ok], RO)).toBe(0);
    });
});

describe('runTurn failure-streak stop', () => {
    beforeEach(() => {
        localStorage.clear();
        W.mainAgentRole = null;
        localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify([`${FAKE_EP.provider}|${FAKE_EP.model}`]));
        localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
        W._sessionToolFilter = new Set(['execute_code']);
        W.setOpenaiHistory([{ role: 'user', content: 'Find Emily Zhou in the chat server.' }]);
    });
    const curl = (i: number) => ({ tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'execute_code', arguments: JSON.stringify({ language: 'bash', code: `curl -s http://chat/api/users.search?q=u${i}` }) } }] });

    it('does not stop a run whose calls exit 0 with an empty body (TAC pm-schedule-meeting-1)', async () => {
        W.nativeExec = vi.fn(async () => ({ stdout: '', stderr: '', exit_code: 0 }));
        W.fetch = makeReplayFetch([...Array.from({ length: 12 }, (_, i) => curl(i)), { content: 'Scheduled.\nCOMPLETED' }]);
        const result = await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        expect(W.nativeExec).toHaveBeenCalledTimes(12);
        expect(result).toContain('Scheduled.');
    });

    it('stops after 10 real failures and logs the stopping step and the stop', async () => {
        let k = 0;   // a different error each time: no same-error grace
        W.nativeExec = vi.fn(async () => ({ stdout: '', stderr: `AssertionError: ${k++} != 2`, exit_code: 1 }));
        W.fetch = makeReplayFetch(Array.from({ length: 20 }, (_, i) => curl(i)));
        const before = W.conversationLog?.length ?? 0;
        const result = await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        expect(W.nativeExec).toHaveBeenCalledTimes(10);
        expect(result).toMatch(/stopped|BLOCKED|consecutive/i);
        const rows = (W.conversationLog ?? []).slice(before);
        expect(rows.filter((r: any) => Array.isArray(r.toolCalls) && r.toolCalls.length).length).toBe(10);
        expect(rows.some((r: any) => r.type === 'stop' && /consecutive tool failures/.test(r.name))).toBe(true);
    });

    // v0.57 Verified xarray-4094: 13 identical pandas-2 TypeErrors, stopped at step 36 with no edit.
    it('the same error every time gets one same_error nudge and 5 more attempts', async () => {
        W.nativeExec = vi.fn(async () => ({ stdout: '', stderr: 'Traceback (most recent call last):\n  File "r.py", line 3\nTypeError: unique requires a Series, Index, ExtensionArray, np.ndarray or NumpyExtensionArray got list.', exit_code: 1 }));
        W.fetch = makeReplayFetch(Array.from({ length: 25 }, (_, i) => curl(i)));
        const before = W.conversationLog?.length ?? 0;
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER);
        expect(W.nativeExec).toHaveBeenCalledTimes(15);
        const rows = (W.conversationLog ?? []).slice(before);
        const n = rows.filter((r: any) => r.type === 'nudge' && r.name === 'same_error');
        expect(n).toHaveLength(1);
        expect(n[0].text).toMatch(/TypeError: unique requires/);
    });
});

describe('failureSignature / sameErrorStreak', () => {
    it('takes the last stderr line, not the Traceback header', async () => {
        const D = await import('../detectors.ts');
        expect(D.failureSignature({ stderr: 'Traceback (most recent call last):\n  File "x"\nKeyError: 3\n' })).toBe('KeyError: 3');
        expect(D.failureSignature({ error: 'read_file refused: x' })).toBe('read_file refused: x');
        expect(D.sameErrorStreak(['a', 'KeyError: 3', 'KeyError: 3', 'KeyError: 3', 'KeyError: 3'])).toBe('KeyError: 3');
        expect(D.sameErrorStreak(['KeyError: 3', 'KeyError: 3', 'KeyError: 4', 'KeyError: 3'])).toBeNull();
        expect(D.sameErrorStreak(['KeyError: 3', 'KeyError: 3'])).toBeNull();
    });
});
