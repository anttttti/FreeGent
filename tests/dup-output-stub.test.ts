// Duplicate-output stubs (v0.58 fixes §6): from the 4th identical call + result within the repeat
// guard's window, history gets a short stub instead of another full copy. Nothing is refused.
// v0.58 CTF 71 ran one `unzip -p … | strings | grep` 14 times; OS 40 one `cat` 25 times.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { makeReplayFetch, FAKE_EP } from './replay-harness.ts';
import { NULL_RENDER_ADAPTER } from '../render-adapter.ts';
import { KEYS } from '../storage-keys.ts';

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
    (globalThis as any).nativeExec = W.nativeExec = async () => ({ stdout: 'Defaults env_reset\nroot ALL=(ALL) ALL\n', stderr: '', exit_code: 0 });
});
afterEach(() => { (globalThis as any).nativeExec = W.nativeExec = origNative; });

describe('duplicate-output stubs', () => {
    it('calls 1–3 are served in full, the 4th and 5th are stubbed, none is refused', async () => {
        const s = W.createSession({ workflowMode: true });
        s.history.push({ role: 'user', content: 'Why does sudo ignore the rule?' });
        const call = (i: number) => ({ tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'execute_code', arguments: JSON.stringify({ language: 'bash', code: 'cat /etc/sudoers.d/root_fix' }) } }] });
        const bodies: any[] = [];
        W.fetch = makeReplayFetch([call(1), call(2), call(3), call(4), call(5), { content: 'Found it.\nCOMPLETED' }], { onRequest: b => bodies.push(b) });
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER, { session: s });
        const tools = bodies.filter(b => b.tools?.length).at(-1).messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content));
        expect(tools).toHaveLength(5);
        for (const t of tools.slice(0, 3)) expect(t).toContain('root ALL=(ALL) ALL');
        for (const t of tools.slice(3)) {
            expect(t).toMatch(/Same result as the \d earlier runs of this exact call/);
            expect(t).not.toContain('root ALL=(ALL) ALL');
            expect(t).not.toContain('Not executed');
        }
    });
});
