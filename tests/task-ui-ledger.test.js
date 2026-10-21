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

    it('editing a task rewrites its file in place and updates its row', async () => {
        files['fg-tasks/001-first.md'] = '---\nid: 001\ntitle: First\nstatus: open\npriority: High\ncreated: 2026-01-01\n---\n# First\nOld desc\n## Acceptance Criteria\n- [x] kept\n- [ ] dropped\n## Log\n### 2026-01-02 — did a thing\n';
        await W.refreshTasks();
        document.querySelector('.kanban-card-edit').click();
        await vi.waitFor(() => expect(document.getElementById('atd-title')).toBeTruthy());
        expect(document.getElementById('atd-title').value).toBe('First');
        expect(document.getElementById('atd-desc').value).toBe('Old desc');
        document.getElementById('atd-title').value = 'Renamed';
        document.getElementById('atd-priority').value = 'Low';
        document.getElementById('atd-criteria').value = 'kept\nnew one';
        document.getElementById('atd-ok').click();
        await vi.waitFor(() => expect(ledgerRows()).toEqual([['001', 'open', 'Low', 'Renamed']]));
        const out = files['fg-tasks/001-first.md'];
        expect(out).toContain('id: 001');
        expect(out).toContain('created: 2026-01-01');
        expect(out).toContain('- [x] kept\n- [ ] new one');
        expect(out).toContain('### 2026-01-02 — did a thing');
        expect(Object.keys(files).filter(k => /^fg-tasks\/\d/.test(k))).toEqual(['fg-tasks/001-first.md']);
    });

    it('attachments are listed in the task file and survive an edit', async () => {
        W.saveFileToWorkspace = async f => { const p = `attachments/1-x/${f.name}`; files[p] = 'bytes'; return p; };
        W.pickWorkspaceFiles = async () => ['docs/spec.md'];
        W.openAddTaskDialog('todo');
        document.getElementById('atd-title').value = 'With files';
        document.getElementById('atd-attach-ws').click();
        await vi.waitFor(() => expect(document.getElementById('atd-attached').textContent).toContain('spec.md'));
        document.getElementById('atd-ok').click();
        await vi.waitFor(() => expect(files['fg-tasks/002-with-files.md']).toBeDefined());
        expect(files['fg-tasks/002-with-files.md']).toContain('## Attachments\n- docs/spec.md\n## Log');
        await W.refreshTasks();
        await W.openEditTaskDialog('fg-tasks/002-with-files.md');
        expect(document.getElementById('atd-attached').textContent).toContain('spec.md');
        document.getElementById('atd-ok').click();
        await vi.waitFor(() => expect(document.getElementById('atd-ok')).toBeNull());
        const out = files['fg-tasks/002-with-files.md'];
        expect(out.match(/## Attachments/g)).toHaveLength(1);
        expect(out).toContain('- docs/spec.md');
        delete W.saveFileToWorkspace; delete W.pickWorkspaceFiles;
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

    it('a stale edit form does not bring back a task that was deleted meanwhile (codex 217/235)', async () => {
        files['fg-tasks/001-first.md'] = '---\nid: 001\ntitle: First\nstatus: open\npriority: High\n---\n# First\nDesc\n## Acceptance Criteria\n## Log\n';
        await W.refreshTasks();
        document.querySelector('.kanban-card-edit').click();
        await vi.waitFor(() => expect(document.getElementById('atd-title')).toBeTruthy());
        delete files['fg-tasks/001-first.md'];   // another tab deleted it
        document.getElementById('atd-desc').value = 'edited description';
        document.getElementById('atd-ok').click();
        await vi.waitFor(() => expect(document.getElementById('atd-err').textContent).toMatch(/no longer be read/));
        expect(files['fg-tasks/001-first.md']).toBeUndefined();
        expect(document.getElementById('atd-ok').disabled).toBe(false);
        document.getElementById('atd-close').click();
    });

    it('a description-only save keeps a title renamed elsewhere (codex 218)', async () => {
        const base = t => `---\nid: 001\ntitle: ${t}\nstatus: open\npriority: High\n---\n# ${t}\nDesc\n## Acceptance Criteria\n## Log\n`;
        files['fg-tasks/001-first.md'] = base('First');
        await W.refreshTasks();
        document.querySelector('.kanban-card-edit').click();
        await vi.waitFor(() => expect(document.getElementById('atd-title')).toBeTruthy());
        files['fg-tasks/001-first.md'] = base('Renamed elsewhere');
        document.getElementById('atd-desc').value = 'new description';
        document.getElementById('atd-ok').click();
        await vi.waitFor(() => expect(document.getElementById('atd-ok')).toBeNull());
        const out = files['fg-tasks/001-first.md'];
        expect(out).toContain('title: Renamed elsewhere');
        expect(out).toContain('# Renamed elsewhere');
        expect(out).toContain('new description');
    });

    it('titles with quotes, colons and backslashes survive create then edit (codex 207-209)', async () => {
        for (const t of ['Prepare: "Quarterly report"', 'Review C:\\reports\\Q4', 'Ends with quote"']) {
            W.openAddTaskDialog('todo');
            document.getElementById('atd-title').value = t;
            document.getElementById('atd-ok').click();
            await vi.waitFor(() => expect(Object.values(files).some(c => c.includes(`# ${t}\n`))).toBe(true));
            const path = Object.keys(files).find(k => files[k].includes(`# ${t}\n`));
            await W.refreshTasks();
            await W.openEditTaskDialog(path);
            expect(document.getElementById('atd-title').value).toBe(t);
            document.getElementById('atd-close').click();
            delete files[path];
        }
    });
});

describe('task dialog uploads (codex 233, 236-240)', () => {
    const pick = (name) => ({ files: [{ name }], value: 'x' });
    it('a file finishing after Cancel is removed again, and later files of the batch are not stored', async () => {
        const stored = [];
        let release;
        W.saveFileToWorkspace = (f) => new Promise(r => { release = () => { const p = `attachments/u/${f.name}`; files[p] = 'b'; stored.push(p); r(p); }; });
        W.openAddTaskDialog('todo');
        const input = document.getElementById('atd-file-any');
        const batch = { files: [{ name: 'one.txt' }, { name: 'two.txt' }], value: 'x' };
        const done = (async () => { input.onchange({ target: batch }); })();
        await done;
        document.getElementById('atd-cancel').click();       // Cancel while one.txt is still being stored
        release();
        await vi.waitFor(() => expect(files['attachments/u/one.txt']).toBeUndefined());
        expect(stored).toEqual(['attachments/u/one.txt']);   // two.txt was never stored
        delete W.saveFileToWorkspace;
    });
    it('Save is refused while a chosen file is still being stored', async () => {
        let release;
        W.saveFileToWorkspace = (f) => new Promise(r => { release = () => { files[`attachments/u/${f.name}`] = 'b'; r(`attachments/u/${f.name}`); }; });
        W.openAddTaskDialog('todo');
        document.getElementById('atd-title').value = 'Needs file';
        document.getElementById('atd-file-any').onchange({ target: { files: [{ name: 'late.txt' }], value: 'x' } });
        document.getElementById('atd-ok').click();
        await vi.waitFor(() => expect(document.getElementById('atd-err').textContent).toMatch(/still being attached/));
        expect(Object.keys(files).filter(k => /^fg-tasks\/\d/.test(k))).toEqual(['fg-tasks/001-first.md']);
        release();
        await vi.waitFor(() => expect(document.getElementById('atd-attached').textContent).toContain('late.txt'));
        document.getElementById('atd-ok').click();
        await vi.waitFor(() => expect(Object.keys(files).some(k => /^fg-tasks\/002/.test(k))).toBe(true));
        expect(files[Object.keys(files).find(k => /^fg-tasks\/002/.test(k))]).toContain('attachments/u/late.txt');
        delete W.saveFileToWorkspace;
    });
});
