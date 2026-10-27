// The task list when storage fails (IndexedDB "internal error" mid-Autopilot, live logs 2026-10-26): a strict load reports the
// failure instead of returning a short list, and the board keeps what it shows instead of drawing every column empty.
const W = globalThis;
await import('../tasks.ts');

const IDB = 'An internal error was encountered in the Indexed Database server';
const task = (id) => `---\nid: ${id}\ntitle: Task ${id}\nstatus: todo\n---\n# Task ${id}\n`;
let saved, files, listFails, readFails;
beforeEach(() => {
    saved = { agentListFiles: W.agentListFiles, agentReadFile: W.agentReadFile };
    files = { 'fg-tasks/001-a.md': task('001'), 'fg-tasks/002-b.md': task('002') };
    listFails = false; readFails = new Set();
    W.agentListFiles = async () => { if (listFails) throw new Error(IDB); return Object.keys(files).map(name => ({ name })); };
    W.agentReadFile = async (p) => { if (readFails.has(p)) throw new Error(IDB); return files[p]; };
    document.body.innerHTML = ['todo', 'in-progress', 'review', 'done'].map(c =>
        `<div class="kanban-col" data-status="${c}"><span class="kanban-col-count">0</span><div id="col-${c}"></div></div>`).join('');
});
afterEach(() => { Object.assign(W, saved); });

describe('loadTaskFiles', () => {
    it('reads every task', async () => {
        expect((await W.loadTaskFiles({ strict: true })).map(t => t.path)).toEqual(['fg-tasks/001-a.md', 'fg-tasks/002-b.md']);
    });
    it('strict: a failed listing throws; the lenient default still returns what it could', async () => {
        listFails = true;
        await expect(W.loadTaskFiles({ strict: true })).rejects.toThrow(IDB);
        expect(await W.loadTaskFiles()).toEqual([]);
    });
    it('strict: a task file that cannot be read (after the retry) throws and names it', async () => {
        readFails.add('fg-tasks/002-b.md');
        await expect(W.loadTaskFiles({ strict: true })).rejects.toThrow(/cannot read fg-tasks\/002-b\.md/);
        expect((await W.loadTaskFiles()).map(t => t.path)).toEqual(['fg-tasks/001-a.md']);
    });
});

describe('the board', () => {
    it('keeps its cards and counts when the task files cannot be read', async () => {
        await W.refreshTasks();
        expect(document.getElementById('col-todo').children).toHaveLength(2);
        listFails = true;
        await W.refreshTasks();
        expect(document.getElementById('col-todo').children).toHaveLength(2);
        expect(document.querySelector('[data-status="todo"] .kanban-col-count').textContent).toBe('2');
        listFails = false; delete files['fg-tasks/002-b.md'];
        await W.refreshTasks();
        expect(document.getElementById('col-todo').children).toHaveLength(1);
    });
});
