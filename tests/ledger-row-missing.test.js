// A task whose file was created outside the board's add-task path has no ledger row; the status
// update used to log "no row found" and leave the ledger behind (v0.71.29 dev session, task 068).
const W = globalThis;
await import('../post-turn.ts');
await import('../qa.ts');

const STUBBED = ['agentListFiles', 'agentReadFile', 'agentWriteFile', 'parseFrontmatter'];
let saved, files;
const fm = (c) => Object.fromEntries((c.match(/^---\n([\s\S]*?)\n---/) ?? [, ''])[1].split('\n').filter(Boolean)
    .map(l => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const rows = () => (files['fg-tasks/ledger.md'] ?? '').split('\n').filter(l => /^\| \d/.test(l)).map(l => l.split('|').map(s => s.trim()).filter(Boolean));

beforeEach(() => {
    saved = Object.fromEntries(STUBBED.map(k => [k, W[k]]));
    files = {
        'fg-tasks/001-first.md': '---\nid: 001\ntitle: First\nstatus: open\npriority: High\n---\n',
        'fg-tasks/068-late.md': '---\nid: 068\ntitle: Added outside the board\nstatus: done\npriority: Medium\n---\n',
        'fg-tasks/ledger.md': '| ID  | Status       | Priority | Title |\n|-----|--------------|----------|-------|\n| 001 | open         | High     | First |\n',
    };
    W.agentListFiles = async () => Object.keys(files).map(name => ({ name }));
    W.agentReadFile = async (p) => { if (!(p in files)) throw new Error('nf'); return files[p]; };
    W.agentWriteFile = async (p, c) => { files[p] = c; };
    W.parseFrontmatter = fm;
});
afterEach(() => { for (const k of STUBBED) W[k] = saved[k]; });

describe('_updateLedgerRow', () => {
    it('updates an existing row in place', async () => {
        await W._updateLedgerRow('fg-tasks/001-first.md', 'done');
        expect(rows().find(r => r[0] === '001')[1]).toBe('done');
    });
    it('adds the missing row by rebuilding the ledger from the task files', async () => {
        await W._updateLedgerRow('fg-tasks/068-late.md', 'done');
        const r = rows().find(x => x[0] === '068');
        expect(r).toEqual(['068', 'done', 'Medium', 'Added outside the board']);
        expect(rows().find(x => x[0] === '001')).toBeTruthy();
    });
});
