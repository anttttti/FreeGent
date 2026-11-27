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
    W.agentReadFile = async (p) => { if (!(p in files)) throw new Error('File not found: ' + p); return files[p]; };
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
    it('two logs of one day get two tasks with different titles (the board shows the first of equal titles only)', async () => {
        vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-27T01:00:00Z') });
        try {
            await post.runPostTurnAgents();
            vi.setSystemTime(new Date('2026-11-27T02:30:00Z'));
            await post.runPostTurnAgents();
        } finally { vi.useRealTimers(); }
        const titles = Object.entries(files).filter(([k]) => /review-session-log/.test(k)).map(([, c]) => /^title: (.*)$/m.exec(c)[1]);
        expect(titles).toHaveLength(2);
        expect(new Set(titles).size).toBe(2);
    });
    it('does not guess an id when the task files cannot be listed (001 may be a task that exists)', async () => {
        files = { 'fg-tasks/001-existing.md': 'precious' };
        W.agentListFiles = async () => { throw new Error('IDB error'); };
        await post.runPostTurnAgents();
        expect(files['fg-tasks/001-existing.md']).toBe('precious');
        expect(Object.keys(files).some(k => /review-session-log/.test(k))).toBe(false);
    });
    it('does not replace a ledger it could not read, and adds no row for a task it could not write', async () => {
        files = { 'fg-tasks/ledger.md': '| ID | Status |\n| 001 | done |\n\n## Archive\n| 000 | old |\n' };
        W.agentReadFile = async (p) => { if (p === 'fg-tasks/ledger.md') throw new Error('UnknownError: IDB'); throw new Error('File not found'); };
        await post.runPostTurnAgents();
        expect(files['fg-tasks/ledger.md']).toContain('| 000 | old |');
        W.agentReadFile = async (p) => { if (!(p in files)) throw new Error('File not found: ' + p); return files[p]; };
        const write = W.agentWriteFile;
        W.agentWriteFile = async (p, c) => { if (/review-session-log/.test(p) && p.startsWith('fg-tasks/')) throw new Error('quota'); return write(p, c); };
        const before = files['fg-tasks/ledger.md'];
        await post.runPostTurnAgents();
        expect(files['fg-tasks/ledger.md']).toBe(before);
    });
    it('puts the row above the archive section', async () => {
        files = { 'fg-tasks/ledger.md': '| ID | Status |\n| 001 | done |\n\n## Archive\n| 000 | old |\n', 'fg-tasks/001-a.md': '---\n---\n' };
        await post.runPostTurnAgents();
        const led = files['fg-tasks/ledger.md'];
        expect(led.indexOf('| 002 |')).toBeGreaterThan(-1);
        expect(led.indexOf('| 002 |')).toBeLessThan(led.indexOf('## Archive'));
    });
    it('writes a log without the credentials the session used', async () => {
        await post.runPostTurnAgents();
        const log = Object.entries(files).find(([k]) => k.startsWith('logs/'))?.[1] ?? '';
        expect(log).toContain('execute_code');
        expect(log).not.toContain(['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-'));
    });
});
