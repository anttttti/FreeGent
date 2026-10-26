// With code execution off, a worker asked to run something can only stall, and the stall warnings blamed the files. Sim
// s6-no-exec-honest (3 of 3 runs on Gemma 4): seven delegations of "run fizz.py", then an answer that did not say it never ran.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeReplayFetch } from './replay-harness.ts';
import { KEYS } from '../storage-keys.ts';

const W = window as any;
beforeAll(async () => { await import('../llm-loops.ts'); await import('../workers.ts'); });
beforeEach(() => {
    localStorage.clear();
    W.mainAgentRole = null;
    localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify(['openrouter|test-model']));
    localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
});

const blockedReply = { content: 'I cannot run the program here.\n\nSTATUS: blocked — no way to execute code' };
async function delegate(task: string) {
    W.fetch = makeReplayFetch([blockedReply, blockedReply]);
    return W.executeWorkers({ agents: [{ id: 'runner', role: 'coder', task }] });
}

describe('run_workers when code execution is off', () => {
    it('says that nobody can run code, instead of a file-stall warning', async () => {
        W.setDisabledTools(['execute_code']);
        const out = await delegate("Run 'python3 fizz.py' and report the exact output.");
        expect(out.exec_unavailable).toMatch(/Code execution is turned off/);
        expect(out.exec_unavailable).toMatch(/say plainly that the code was not run/);
        expect(out.loop_warning).toBeUndefined();
    });
    it('says nothing of the kind when execution is available, or the task is not about running', async () => {
        W.setDisabledTools([]);
        W.nativeExec = async () => ({ stdout: '', stderr: '', exit_code: 0 });
        expect((await delegate("Run 'python3 fizz.py'.")).exec_unavailable).toBeUndefined();
        W.setDisabledTools(['execute_code']);
        expect((await delegate('Summarise the README.')).exec_unavailable).toBeUndefined();
    });
});
