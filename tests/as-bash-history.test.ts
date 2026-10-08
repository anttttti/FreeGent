// Shell sent as Python, re-run as bash, is recorded as a bash call (v0.58 fixes §4). With the call
// left as language "python" plus a "do not re-run it" note, the next call was an identical re-send
// 20% of the time (8.5% after other results); CTF 48 re-sent a call that printed the flag 10 times.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { makeReplayFetch, FAKE_EP } from './replay-harness.ts';
import { NULL_RENDER_ADAPTER } from '../render-adapter.ts';
import { KEYS } from '../storage-keys.ts';
import { pushHistory, historyOf } from './history-helpers.ts';

const W = window as any;
let origNative: any;
beforeAll(async () => {
    await import('../llm-loops.ts');
    await import('../step-validator.ts');
});
beforeEach(() => {
    localStorage.clear();
    W.mainAgentRole = null;
    localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify(['openrouter|qwen/qwen3-30b-a3b']));
    localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
    W._sessionToolFilter = new Set(['execute_code']);
    origNative = W.nativeExec;
    const g = globalThis as any;
    g.nativeExec = W.nativeExec = async (lang: string) => lang === 'python'
        ? { stdout: '', stderr: '  File "<string>", line 1\n    python3 -c "print(42)"\n            ^\nSyntaxError: invalid syntax', exit_code: 1 }
        : { stdout: '42\n', stderr: '', exit_code: 0 };
});
afterEach(() => { (globalThis as any).nativeExec = W.nativeExec = origNative; });

describe('shell-as-Python re-run', () => {
    it('the next request shows the call as bash, with the output and no marker or note', async () => {
        const s = W.createSession({ workflowMode: true });
        pushHistory(s, { role: 'user', content: 'Print 42.' });
        const bodies: any[] = [];
        W.fetch = makeReplayFetch([
            { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'execute_code', arguments: JSON.stringify({ language: 'python', code: 'python3 -c "print(42)"' }) } }] },
            { content: '42\nCOMPLETED' },
        ], { onRequest: b => bodies.push(b) });
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER, { session: s });
        const msgs = bodies[1].messages;
        const call = msgs.find((m: any) => m.role === 'assistant' && m.tool_calls?.length).tool_calls[0];
        expect(JSON.parse(call.function.arguments)).toEqual({ language: 'bash', code: 'python3 -c "print(42)"' });
        const tool = msgs.find((m: any) => m.role === 'tool');
        expect(tool.content).toContain('42');
        expect(tool.content).not.toContain('_ranAsBash');
        expect(tool.content).not.toMatch(/Ran as bash|do not re-run/);
    });
});
