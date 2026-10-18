// execute_code (Local provider): what is sent to /api/execute and what is applied from its answer.
// Regressions from codex campaign 6 (cases 032-056): files left out of the run's copy must not be replaced,
// empty files must exist in the run, deletions and renames must reach the workspace, and a failed write must
// not be reported as written.
const W = globalThis;

let written, deleted, sentBody, answer, realFetch, writeFails;
const BIG = 'x'.repeat(1_000_001);

beforeEach(() => {
    written = new Map(); deleted = []; sentBody = null; writeFails = new Set();
    W.mainAgentRole = null;
    localStorage.setItem('fg_sandbox_provider', 'local');
    W.listWorkspaceFiles = async () => [
        { name: 'big.txt', content: BIG },
        { name: 'empty.txt', content: '' },
        { name: 'pkg/__init__.py', content: '' },
        { name: 'a.txt', content: 'A' },
        { name: 'old.txt', content: 'O' },
    ];
    W.agentListFiles = async () => [];
    W.agentWriteFile = async (path, content) => { if (writeFails.has(path)) throw new Error('QuotaExceededError'); written.set(path, content); };
    W.agentDeleteFile = async (path) => { deleted.push(path); };
    realFetch = W.fetch;
    W.fetch = async (url, init) => {
        if (String(url).endsWith('/api/execute')) {
            sentBody = JSON.parse(init.body);
            return { ok: true, status: 200, json: async () => answer };
        }
        return realFetch(url, init);
    };
});
afterEach(() => { W.fetch = realFetch; localStorage.removeItem('fg_sandbox_provider'); });

const run = () => W.executeToolAsync('execute_code', { language: 'bash', code: 'echo go' }, null);

describe('execute_code with the Local provider', () => {
    it('sends empty files, and leaves out only the ones that are too large', async () => {
        answer = { stdout: '', stderr: '', exit_code: 0, files_written: {} };
        await run();
        expect(Object.keys(sentBody.files).sort()).toEqual(['a.txt', 'empty.txt', 'old.txt', 'pkg/__init__.py']);
        expect(sentBody.files['empty.txt']).toBe('');
    });

    it('does not replace a file it could not send; reports why, and still applies the other writes', async () => {
        answer = { stdout: 'ok', stderr: '', exit_code: 0, files_written: { 'big.txt': 'TAIL', 'a.txt': 'AA' } };
        const r = await run();
        expect(written.has('big.txt')).toBe(false);
        expect(written.get('a.txt')).toBe('AA');
        expect(r.files_written).toEqual(['a.txt']);
        expect(r.stderr).toMatch(/\[write failed\] big\.txt: not written.*too large/);
        expect(r.write_errors).toHaveLength(1);
        expect(r.exit_code).toBe(0);   // part of the work was applied
    });

    it('fails the call when the only write was refused', async () => {
        answer = { stdout: '', stderr: '', exit_code: 0, files_written: { 'big.txt': 'TAIL' } };
        const r = await run();
        expect(r.files_written).toEqual([]);
        expect(r.exit_code).toBe(1);
    });

    it('applies files the run removed or renamed away', async () => {
        answer = { stdout: '', stderr: '', exit_code: 0, files_written: { 'new.txt': 'N' }, files_deleted: ['old.txt'] };
        const r = await run();
        expect(deleted).toEqual(['old.txt']);
        expect(r.files_deleted).toEqual(['old.txt']);
        expect(written.get('new.txt')).toBe('N');
    });

    it('does not claim a path as written when the workspace refused the write', async () => {
        writeFails.add('a.txt');
        answer = { stdout: '', stderr: '', exit_code: 0, files_written: { 'a.txt': 'AA', 'b.txt': 'B' } };
        const r = await run();
        expect(r.files_written).toEqual(['b.txt']);
        expect(r.stderr).toMatch(/\[write failed\] a\.txt: QuotaExceededError/);
        expect(written.has('a.txt')).toBe(false);
    });
});
