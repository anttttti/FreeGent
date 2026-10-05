// Creating, moving and deleting a task in the Tasks tab keeps fg-tasks/ledger.md in step.
const W = globalThis;
await import('../post-turn.ts');
await import('../tasks.ts');

const STUBBED = ['agentListFiles', 'agentReadFile', 'agentWriteFile', 'agentDeleteFile', 'parseFrontmatter',
    'transitionTask', 'confirm', 'alert', 'getAgentLedger'];
let saved, files;

function fm(c) {
    return Object.fromEntries((c.match(/^---\n([\s\S]*?)\n---/) ?? [, ''])[1].split('\n').filter(Boolean)
        .map(l => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}
const ledgerRows = () => (files['fg-tasks/ledger.md'] ?? '').split('\n').filter(l => /^\| \d/.test(l)).map(l => l.split('|').map(s => s.trim()).filter(Boolean));

beforeEach(() => {
    saved = Object.fromEntries(STUBBED.map(k => [k, W[k]]));
    document.body.innerHTML = '<div id="col-todo"></div><div id="col-in-progress"></div><div id="col-review"></div><div id="col-done"></div>';
    files = {
        'fg-tasks/001-first.md': '---\nid: 001\ntitle: First\nstatus: open\npriority: High\n---\n# First\n',
        'fg-tasks/ledger.md': '| ID  | Status       | Priority | Title |\n|-----|--------------|----------|-------|\n| 001 | open         | High     | First |\n\n## Archive\nold stuff\n',
    };
    W.agentListFiles = async () => Object.keys(files).map(name => ({ name }));
    W.agentReadFile = async (p) => { if (!(p in files)) throw new Error('nf'); return files[p]; };
    W.agentWriteFile = async (p, c) => { files[p] = c; };
    W.agentDeleteFile = async (p) => { delete files[p]; };
    W.parseFrontmatter = fm;
    W.getAgentLedger = () => true;
    W.confirm = () => true;
    W.alert = () => {};
    W.transitionTask = async (p, s) => { files[p] = files[p].replace(/^status: .*$/m, `status: ${s}`); return { transitioned: true }; };
});
afterEach(() => { for (const k of STUBBED) W[k] = saved[k]; });

describe('ledger follows the Tasks tab', () => {
    it('creating a task adds its row', async () => {
        W.openAddTaskDialog('in-progress');
        document.getElementById('atd-title').value = 'Second task';
        document.getElementById('atd-ok').click();
        await vi.waitFor(() => expect(ledgerRows()).toHaveLength(2));
        expect(ledgerRows()[1]).toEqual(['002', 'in-progress', 'Medium', 'Second task']);
        expect(files['fg-tasks/ledger.md']).toContain('## Archive\nold stuff');
    });

    it('moving a task updates its row', async () => {
        await W.refreshTasks();
        await W.moveTaskToColumn('fg-tasks/001-first.md', 'done');
        expect(ledgerRows()).toEqual([['001', 'done', 'High', 'First']]);
    });

    it('deleting a task removes its row, including the last one', async () => {
        await W.refreshTasks();
        document.querySelector('.kanban-card-trash').click();
        await vi.waitFor(() => expect(files['fg-tasks/001-first.md']).toBeUndefined());
        await vi.waitFor(() => expect(ledgerRows()).toEqual([]));
        expect(files['fg-tasks/ledger.md']).toContain('## Archive\nold stuff');
    });

    it('does not create a ledger for a project that has none', async () => {
        delete files['fg-tasks/ledger.md'];
        delete files['fg-tasks/001-first.md'];
        await W.syncLedgerWithTaskFiles();
        expect(files['fg-tasks/ledger.md']).toBeUndefined();
    });
});
