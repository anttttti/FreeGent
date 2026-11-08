// The chat's scratch note fg-tasks/current.md is not a board task: not on the board or in the runner's list, and it is not the "twin" that makes the
// real numbered file of the same title a duplicate (kanbanflow run 2026-11-08: the plan's first task went to current.md, then 001-*.md was refused).
import { describe, it, expect, vi } from 'vitest';
const W = globalThis;
await import('../tasks.ts');
const task = (id, title) => `---\nid: ${id}\ntitle: ${title}\nstatus: open\n---\n# ${title}\n`;
let saved, files;
beforeEach(() => {
    saved = { agentListFiles: W.agentListFiles, agentReadFile: W.agentReadFile };
    files = { 'fg-tasks/current.md': task(1, 'Build it'), 'fg-tasks/002-next.md': task(2, 'Next step') };
    W.agentListFiles = async () => Object.keys(files).map(name => ({ name }));
    W.agentReadFile = async (p) => files[p];
});
afterEach(() => { Object.assign(W, saved); });

it('loadTaskFiles leaves current.md out', async () => {
    expect((await W.loadTaskFiles()).map(t => t.path)).toEqual(['fg-tasks/002-next.md']);
});

// A task file's status moves only through update_task_status (kanbanflow 2026-11-08: write_file set `done` past the gates, and a resumed planning
// task re-created 003-005 as open so the done tasks ran again).
describe('write_file on an existing task file', () => {
    const doneTask = '---\nid: 3\ntitle: UI\nstatus: done\n---\n# UI\n';
    beforeEach(() => { W.agentReadFile = async (p) => { if (p === 'fg-tasks/003-ui.md') return doneTask; throw new Error('File not found'); }; W.agentWriteFile = vi.fn(async () => {}); });
    it('refuses to change its status and still lets the content, or a new task file, be written', async () => {
        const reopen = await W.executeToolAsync('write_file', { path: 'fg-tasks/003-ui.md', content: '---\nid: 3\ntitle: UI\nstatus: open\n---\n# UI\n' });
        expect(reopen.error).toMatch(/from done to /);
        expect(W.agentWriteFile).not.toHaveBeenCalled();
        expect((await W.executeToolAsync('write_file', { path: 'fg-tasks/003-ui.md', content: '---\nid: 3\ntitle: UI\nstatus: done\n---\n# UI, reworded\n' })).error).toBeUndefined();
        const bare = await W.executeToolAsync('write_file', { path: 'fg-tasks/005-bare.md', content: '---\nid: 5\ntitle: Bare\nstatus: open\n---\n# Bare\n' });
        expect(bare.note).toMatch(/Acceptance Criteria/);
        const fresh = await W.executeToolAsync('write_file', { path: 'fg-tasks/004-new.md', content: '---\nid: 4\ntitle: New\nstatus: open\n---\n# New\n' });
        expect(fresh.error).toBeUndefined();
    });
});

describe('the board card of a task accepted unverified', () => {
    it('says so', async () => {
        document.body.innerHTML = ['todo', 'in-progress', 'review', 'done'].map(c => `<div class="kanban-col" data-status="${c}"><span class="kanban-col-count">0</span><div id="col-${c}"></div></div>`).join('');
        W.agentListFiles = async () => [{ name: 'fg-tasks/001-a.md' }, { name: 'fg-tasks/002-b.md' }];
        W.agentReadFile = async (p) => p.includes('001') ? task(1, 'A').replace('status: open', 'status: done\nqa: unverified') : task(2, 'B').replace('status: open', 'status: done');
        await W.refreshTasks();
        const cards = [...document.getElementById('col-done').children];
        expect(cards.map(c => /not verified/.test(c.textContent))).toEqual([true, false]);
    });
});
