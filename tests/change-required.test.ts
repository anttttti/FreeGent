// The v0.72 review gates inside the real turn loop (completion-gates.ts has the table-level tests):
//  - a task graded on the system's state (FG_CHANGE_REQUIRED, set by the AgentBench OS runner) that is
//    completed or BLOCKED with nothing changed is bounced once (OS 38, 40, 41, 42: diagnosed, did not fix);
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { makeReplayFetch, FAKE_EP } from './replay-harness.ts';
import { NULL_RENDER_ADAPTER } from '../render-adapter.ts';
import { KEYS } from '../storage-keys.ts';
import { pushHistory, historyOf } from './history-helpers.ts';

const W = window as any;
beforeAll(async () => { await import('../llm-loops.ts'); await import('../step-validator.ts'); });
beforeEach(() => {
    localStorage.clear();
    W.mainAgentRole = null;
    localStorage.setItem(KEYS.MAIN_MODELS, JSON.stringify(['openrouter|qwen/qwen3-30b-a3b']));
    localStorage.setItem(KEYS.OPENROUTER_KEY, 'test-key');
    W._sessionToolFilter = new Set(['execute_code']);
});
afterEach(() => { delete process.env.FG_CHANGE_REQUIRED; delete process.env.FG_EDIT_REQUIRED; });

const sh = (id: string, code: string) => ({ tool_calls: [{ id, type: 'function', function: { name: 'execute_code', arguments: JSON.stringify({ language: 'bash', code }) } }] });
async function run(task: string, replies: any[], exec: (code: string) => any) {
    const orig = W.nativeExec;
    (globalThis as any).nativeExec = W.nativeExec = async (_l: string, code: string) => exec(code);
    try {
        const s = W.createSession({ workflowMode: true });
        pushHistory(s, { role: 'user', content: task });
        const bodies: any[] = [];
        W.fetch = makeReplayFetch(replies, { onRequest: b => bodies.push(b) });
        await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER, { session: s });
        return { s, bodies };
    } finally { (globalThis as any).nativeExec = W.nativeExec = orig; }
}
const userMsgs = (s: any, re: RegExp) => historyOf(s).filter((m: any) => m.role === 'user' && re.test(String(m.content)));
const SUDO = "Why can't I use sudo? Help me fix it.";

describe('change-required tasks', () => {
    beforeEach(() => { process.env.FG_CHANGE_REQUIRED = '1'; });
    it('COMPLETED after only reading is bounced once, and a real fix is then accepted', async () => {
        const { s, bodies } = await run(SUDO, [
            sh('c1', 'whoami'),
            { content: 'You are root, you do not need sudo.\nCOMPLETED' },
            sh('c2', 'apt-get install -y sudo'),
            { content: 'Installed sudo.\nCOMPLETED' },
        ], () => ({ stdout: 'root\n', stderr: '', exit_code: 0 }));
        expect(userMsgs(s, /needs the system to be changed and nothing was changed/)).toHaveLength(1);
        expect(bodies).toHaveLength(4);
    });
    it('a second COMPLETED with still no change is accepted (nothing may be broken)', async () => {
        const { s, bodies } = await run(SUDO, [
            sh('c1', 'whoami'),
            { content: 'Nothing is broken.\nCOMPLETED' },
            { content: 'Nothing is broken: sudo -v works.\nCOMPLETED' },
        ], () => ({ stdout: 'root\n', stderr: '', exit_code: 0 }));
        expect(userMsgs(s, /nothing was changed/)).toHaveLength(1);
        expect(bodies).toHaveLength(3);
    });
    it('a chmod counts as a change even though no file is reported written', async () => {
        const { s } = await run('Find the SUID vulnerability and fix it.', [
            sh('c1', 'chmod u-s /usr/bin/find'),
            { content: 'Removed the SUID bit.\nCOMPLETED' },
        ], () => ({ stdout: '', stderr: '', exit_code: 0 }));
        expect(userMsgs(s, /nothing was changed/)).toHaveLength(0);
    });
    it('BLOCKED with a question and nothing tried is bounced once, then accepted', async () => {
        const { s, bodies } = await run(SUDO, [
            sh('c1', 'cat /etc/sudoers'),
            { content: 'BLOCKED: What is the exact error message you receive?' },
            { content: 'BLOCKED: What is the exact error message you receive?' },
        ], () => ({ stdout: '\n', stderr: '', exit_code: 0 }));
        expect(userMsgs(s, /declared BLOCKED without changing anything/)).toHaveLength(1);
        expect(bodies).toHaveLength(3);
    });
    it('without the flag the same run is left alone (the wording is never read)', async () => {
        delete process.env.FG_CHANGE_REQUIRED;
        const { s, bodies } = await run(SUDO, [
            sh('c1', 'whoami'),
            { content: 'You are root.\nCOMPLETED' },
        ], () => ({ stdout: 'root\n', stderr: '', exit_code: 0 }));
        expect(userMsgs(s, /nothing was changed/)).toHaveLength(0);
        expect(bodies).toHaveLength(2);
    });
});
