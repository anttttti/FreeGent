// setTaskStatus must leave exactly one `status:` line in the frontmatter, whatever it was before.
const W = globalThis;
await import('../qa.ts');

let files;
const saved = {};
const KEYS = ['agentReadFile', 'agentWriteFile'];
beforeEach(() => {
    for (const k of KEYS) saved[k] = W[k];
    files = {};
    W.agentReadFile = async (p) => { if (!(p in files)) throw new Error('nf'); return files[p]; };
    W.agentWriteFile = async (p, c) => { files[p] = c; };
});
afterEach(() => { for (const k of KEYS) W[k] = saved[k]; });

const statusLines = (c) => c.split('\n').filter(l => /^status:/.test(l));
const P = 'fg-tasks/001-x.md';

describe('setTaskStatus', () => {
    it('rewrites the status line', async () => {
        files[P] = '---\nid: 001\nstatus: open\n---\n# T\n';
        await W.setTaskStatus(P, 'in-progress');
        expect(statusLines(files[P])).toEqual(['status: in-progress']);
    });

    it('does not add another line when the status is already that value', async () => {
        files[P] = '---\nid: 001\nstatus: in-progress\ntitle: T\n---\n# T\n';
        for (let i = 0; i < 5; i++) await W.setTaskStatus(P, 'in-progress');
        expect(statusLines(files[P])).toEqual(['status: in-progress']);
        expect(files[P]).toMatch(/^---\nid: 001\nstatus: in-progress\ntitle: T\n---\n# T\n/);
    });

    it('repairs a header that already has duplicate status lines', async () => {
        files[P] = '---\nid: 001\nstatus: in-progress\nstatus: in-progress\nstatus: in-progress\ntitle: T\n---\n# T\n';
        await W.setTaskStatus(P, 'done');
        expect(statusLines(files[P])).toEqual(['status: done']);
        expect(files[P]).toContain('title: T');
    });

    it('inserts a status line when the frontmatter has none, and a block when there is no frontmatter', async () => {
        files[P] = '---\nid: 001\n---\n# T\n';
        await W.setTaskStatus(P, 'open');
        expect(statusLines(files[P])).toEqual(['status: open']);
        files['fg-tasks/002-y.md'] = '# No frontmatter\n';
        await W.setTaskStatus('fg-tasks/002-y.md', 'open');
        expect(files['fg-tasks/002-y.md']).toMatch(/^---\nstatus: open\n---\n/);
    });

    it('leaves a status-looking line in the body alone', async () => {
        files[P] = '---\nid: 001\nstatus: open\n---\n# T\nstatus: not a field\n';
        await W.setTaskStatus(P, 'done');
        expect(files[P]).toContain('\nstatus: not a field\n');
        expect(statusLines(files[P].split('---\n')[1])).toEqual(['status: done']);
    });
});
