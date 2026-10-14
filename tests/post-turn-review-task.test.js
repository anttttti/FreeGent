// Review 2026-10-14 (opencode M1, M7): the session-log review task lives in fg-tasks/ with the next id,
// and the log it points at has no credentials in it.
const W = globalThis;
const post = await import('../post-turn.ts');
const { setActiveChatId } = await import('../state.js');

let files, saved;
const STUBBED = ['agentListFiles', 'agentReadFile', 'agentWriteFile', 'refreshTasks', 'conversationLog'];
beforeEach(() => {
    saved = Object.fromEntries(STUBBED.map(k => [k, W[k]]));
    files = { 'fg-tasks/007-existing.md': '---\nid: 007\n---\n' };
    W.agentListFiles = async () => Object.keys(files).map(name => ({ name }));
    W.agentReadFile = async (p) => { if (!(p in files)) throw new Error('nf'); return files[p]; };
    W.agentWriteFile = async (p, c) => { files[p] = c; };
    W.refreshTasks = () => {};
    localStorage.setItem('fg_agent_review_logs', 'true');
    setActiveChatId('chat-1');
    const FAKE_KEY = ['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');   // built at runtime: no secret-shaped literal in the repo
    W.conversationLog = [{ chatId: 'chat-1', step: 0, model: 'm', provider: 'p', chatName: 'Demo',
        response: 'x'.repeat(100),
        toolCalls: [{ name: 'execute_code', args: { code: `curl -H "Authorization: Bearer ${FAKE_KEY}" x` } }] }];
});
afterEach(() => { for (const k of STUBBED) W[k] = saved[k]; localStorage.clear(); });

describe('session-log review task', () => {
    it('is created in fg-tasks/ with the next id and its ledger', async () => {
        await post.runPostTurnAgents();
        const task = Object.keys(files).find(k => /review-session-log/.test(k));
        expect(task).toMatch(/^fg-tasks\/008-review-session-log-/);
        expect(files['fg-tasks/ledger.md']).toContain('| 008 |');
        expect(Object.keys(files).some(k => k.startsWith('tasks/'))).toBe(false);
    });
    it('writes a log without the credentials the session used', async () => {
        await post.runPostTurnAgents();
        const log = Object.entries(files).find(([k]) => k.startsWith('logs/'))?.[1] ?? '';
        expect(log).toContain('execute_code');
        expect(log).not.toContain(['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-'));
    });
});
