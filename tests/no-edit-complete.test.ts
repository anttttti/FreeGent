// A COMPLETED with no file change on a task that is solved by editing the source: SWE Lite
// matplotlib-23314 (v0.70) analysed for 44 steps, never edited, ended `completed` with an empty patch.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
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

const SWE_TASK = 'The following is a GitHub issue filed against the `x/y` repository. Your job is to locate the responsible code and fix it by editing the source files in your workspace.\n\nset_visible(False) leaves children visible.';

async function run(task: string, replies: any[]) {
    const s = W.createSession({ workflowMode: true });
    pushHistory(s, { role: 'user', content: task });
    const bodies: any[] = [];
    W.fetch = makeReplayFetch(replies, { onRequest: b => bodies.push(b) });
    await W.runTurn(FAKE_EP, NULL_RENDER_ADAPTER, { session: s });
    return { s, bodies };
}
const bounces = (s: any) => historyOf(s).filter((m: any) => m.role === 'user' && /no file in the workspace was changed/.test(String(m.content)));

describe('no_edit_complete', () => {
    it('bounces a COMPLETED that changed nothing, once', async () => {
        const { s, bodies } = await run(SWE_TASK, [
            { content: 'The cause is in Axes3D.set_visible.\nCOMPLETED' },
            { content: 'Still no change.\nCOMPLETED' },
        ]);
        expect(bounces(s)).toHaveLength(1);
        expect(bodies).toHaveLength(2);   // second COMPLETED is accepted
    });

    it('does not fire for a task that is not an edit task', async () => {
        const { s, bodies } = await run('How many rows are in data.csv?', [{ content: '42\nCOMPLETED' }]);
        expect(bounces(s)).toHaveLength(0);
        expect(bodies).toHaveLength(1);
    });

    it('does not fire for BLOCKED', async () => {
        const { s } = await run(SWE_TASK, [{ content: 'BLOCKED: the package cannot be imported here' }]);
        expect(bounces(s)).toHaveLength(0);
    });
});

describe('invented_data', () => {
    const Q = 'How many lines in all the log files under /var/log/app contain the word error?';
    it('bounces a question answered after the agent wrote data files itself, once', async () => {
        const orig = W.nativeExec;
        (globalThis as any).nativeExec = W.nativeExec = async () => ({ stdout: '', stderr: '', exit_code: 0, files_written: ['logs/app.log'] });
        try {
            const { s, bodies } = await run(Q, [
                { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'execute_code', arguments: JSON.stringify({ language: 'bash', code: "printf 'error 1\\nok\\n' > logs/app.log" }) } }] },
                { content: '1\nCOMPLETED' },
                { content: '1\nCOMPLETED' },
            ]);
            const n = historyOf(s).filter((m: any) => m.role === 'user' && /wrote to data files yourself/.test(String(m.content)));
            expect(n).toHaveLength(1);
            expect(bodies).toHaveLength(3);
        } finally { (globalThis as any).nativeExec = W.nativeExec = orig; }
    });
    it('does not fire when the task asks for an action', async () => {
        const orig = W.nativeExec;
        (globalThis as any).nativeExec = W.nativeExec = async () => ({ stdout: '', stderr: '', exit_code: 0, files_written: ['out/report.txt'] });
        try {
            const { s } = await run('Write the number of error lines in /var/log/app to out/report.txt.', [
                { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'execute_code', arguments: JSON.stringify({ language: 'bash', code: 'echo 1 > out/report.txt' }) } }] },
                { content: 'Done.\nCOMPLETED' },
            ]);
            expect(historyOf(s).filter((m: any) => /wrote to data files yourself/.test(String(m.content)))).toHaveLength(0);
        } finally { (globalThis as any).nativeExec = W.nativeExec = orig; }
    });

    it('bounces an answer after a supplied file was overwritten (OS task 52, v0.70)', async () => {
        const orig = W.nativeExec;
        (globalThis as any).nativeExec = W.nativeExec = async () => ({ stdout: '', stderr: '', exit_code: 0 });
        try {
            const task = '<workspace_files>\n1 file:\nlogfile.txt\n</workspace_files>\n\nCount the unique characters in `logfile.txt`. The result must be an integer.';
            const { s, bodies } = await run(task, [
                { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'execute_code', arguments: JSON.stringify({ language: 'bash', code: "echo 'abcabc' > logfile.txt && sort -u logfile.txt | wc -l" }) } }] },
                { content: '73\nCOMPLETED' },
                { content: '73\nCOMPLETED' },
            ]);
            const n = historyOf(s).filter((m: any) => m.role === 'user' && /wrote to data files yourself: logfile\.txt \(supplied/.test(String(m.content)));
            expect(n).toHaveLength(1);
            expect(bodies).toHaveLength(3);
        } finally { (globalThis as any).nativeExec = W.nativeExec = orig; }
    });
});

describe('failed_check_complete', () => {
    it('bounces a COMPLETED when the last check after the final change failed, once', async () => {
        const orig = W.nativeExec;
        let n = 0;
        (globalThis as any).nativeExec = W.nativeExec = async (_l: string, code: string) => {
            n++;
            if (/pytest/.test(code)) return { stdout: '1 failed, 2 passed', stderr: '', exit_code: 1 };
            return { stdout: '', stderr: '', exit_code: 0, files_written: ['src/app.py'] };
        };
        try {
            const call = (id: string, code: string) => ({ tool_calls: [{ id, type: 'function', function: { name: 'execute_code', arguments: JSON.stringify({ language: 'bash', code }) } }] });
            const { s, bodies } = await run('Fix the off-by-one in src/app.py.', [
                call('c1', "sed -i 's/a/b/' src/app.py"),
                call('c2', 'python3 -m pytest tests/test_app.py'),
                { content: 'Fixed.\nCOMPLETED' },
                { content: 'The remaining failure is test_x which fails on main too.\nCOMPLETED' },
            ]);
            const b = historyOf(s).filter((m: any) => m.role === 'user' && /last test or build check you ran after your final change failed/.test(String(m.content)));
            expect(b).toHaveLength(1);
            expect(bodies).toHaveLength(4);
        } finally { (globalThis as any).nativeExec = W.nativeExec = orig; }
    });
});
