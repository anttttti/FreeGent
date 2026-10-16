// The retired tasks/ and local/tasks/ folders: task files left there move into fg-tasks/ when the
// board loads, and nothing else in those folders is touched.

await import('../tasks.ts');

const W = globalThis;
let files, orig;

beforeEach(() => {
    files = new Map();
    orig = { list: W.agentListFiles, read: W.agentReadFile, write: W.agentWriteFile, del: W.agentDeleteFile };
    W.agentListFiles = async () => [...files.keys()].map(name => ({ name }));
    W.agentReadFile = async (p) => { if (!files.has(p)) throw new Error('nf'); return files.get(p); };
    W.agentWriteFile = async (p, c) => { files.set(p, c); };
    W.agentDeleteFile = async (p) => { files.delete(p); };
});
afterEach(() => { W.agentListFiles = orig.list; W.agentReadFile = orig.read; W.agentWriteFile = orig.write; W.agentDeleteFile = orig.del; });

const task = (id, title, status = 'open') => `---\nid: ${id}\ntitle: ${title}\nstatus: ${status}\n---\n# ${title}\n`;

describe('legacy tasks/ migration', () => {
    it('moves task files from tasks/ and local/tasks/, keeping content and names', async () => {
        files.set('tasks/001-a.md', task('001', 'A'));
        files.set('local/tasks/002-b.md', task('002', 'B', 'done'));
        files.set('tasks/archive/003-c.md', task('003', 'C'));
        const loaded = await W.loadTaskFiles();
        expect([...files.keys()].filter(n => !n.endsWith('.legacy-tasks-migrated')).sort()).toEqual(['fg-tasks/001-a.md', 'fg-tasks/archive/003-c.md', 'local/fg-tasks/002-b.md']);
        expect(files.get('fg-tasks/001-a.md')).toBe(task('001', 'A'));
        expect(loaded.map(t => t.path).sort()).toEqual(['fg-tasks/001-a.md', 'fg-tasks/archive/003-c.md', 'local/fg-tasks/002-b.md']);
    });

    it('leaves other markdown in tasks/ and a legacy ledger alone', async () => {
        files.set('tasks/README.md', '# Notes about our tasks\n');
        files.set('tasks/ledger.md', '| id |\n');
        files.set('tasks/001-a.md', task('001', 'A'));
        await W.loadTaskFiles();
        expect([...files.keys()].filter(n => !n.endsWith('.legacy-tasks-migrated')).sort()).toEqual(['fg-tasks/001-a.md', 'tasks/README.md', 'tasks/ledger.md']);
    });

    it('gives a task whose name is taken the next free id instead of overwriting', async () => {
        files.set('fg-tasks/001-a.md', task('001', 'Existing'));
        files.set('fg-tasks/002-z.md', task('002', 'Other'));
        files.set('tasks/001-a.md', task('001', 'Legacy'));
        await W.loadTaskFiles();
        expect(files.get('fg-tasks/001-a.md')).toBe(task('001', 'Existing'));
        expect(files.has('tasks/001-a.md')).toBe(false);
        expect(files.get('fg-tasks/003-a.md')).toBe(task('003', 'Legacy'));
    });

    it('moves only once: a task-shaped file added to tasks/ afterwards stays', async () => {
        files.set('tasks/001-a.md', task('001', 'A'));
        await W.loadTaskFiles();
        files.set('tasks/002-later.md', task('002', 'Later'));
        await W.loadTaskFiles();
        expect(files.has('tasks/002-later.md')).toBe(true);
        expect(files.has('fg-tasks/002-later.md')).toBe(false);
    });

    it('does not move numbered markdown without task frontmatter', async () => {
        files.set('tasks/001-notes.md', '# just notes\n');
        await W.loadTaskFiles();
        expect([...files.keys()]).toEqual(['tasks/001-notes.md']);
    });

    it('is a no-op when there is no legacy folder', async () => {
        files.set('fg-tasks/001-a.md', task('001', 'A'));
        await W.loadTaskFiles();
        expect([...files.keys()]).toEqual(['fg-tasks/001-a.md']);
    });
});
