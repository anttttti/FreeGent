// task-status.ts — one spelling for task statuses, shared by the board (tasks.ts), the lifecycle
// gates (qa.ts) and the runner. The board writes "review", files say "in-review", finished tasks
// may read "completed"; everything keyed on a status works on the canonical form.

const ALIASES: Record<string, string> = { review: 'in-review', completed: 'done' };

export function canonTaskStatus(status: any): string {
    const s = String(status || 'todo').trim().toLowerCase();
    return ALIASES[s] ?? s;
}

// The Kanban column (its data-status) a status is shown in.
const COLUMN: Record<string, string> = { todo: 'todo', open: 'todo', blocked: 'todo', 'in-progress': 'in-progress', 'in-review': 'review', done: 'done' };
export const columnOfStatus = (status: any): string => COLUMN[canonTaskStatus(status)] ?? 'todo';

// Task title as compared for duplicates: case, spacing and a leading "#NNN" are ignored.
export const taskTitleKey = (title: any): string =>
    String(title || '').toLowerCase().replace(/^#?\d+\s+/, '').replace(/\s+/g, ' ').trim();

// One task per title. The lowest id (the original) is kept; copies are dropped, so the board and the
// runner never see the same task twice. Tasks without a title are never merged.
export function dedupeTasksByTitle<T extends { path: string; fm: any }>(tasks: T[]): T[] {
    const num = (t: T) => Number(t.fm?.id) || Number((t.path.match(/\/(\d+)-/) || [])[1]) || Infinity;
    const keep = new Map<string, T>();
    for (const t of tasks) {
        const k = taskTitleKey(t.fm?.title);
        if (!k) continue;
        const cur = keep.get(k);
        if (!cur || num(t) < num(cur)) keep.set(k, t);
    }
    return tasks.filter(t => { const k = taskTitleKey(t.fm?.title); return !k || keep.get(k) === t; });
}

// Folders that hold task files: the workspace's fg-tasks/ and the same folder inside an attached Local
// Folder. (`local/fg-tasks/` was once missing from every check, so a Local Folder project's tasks did
// not reach the board.) The older `tasks/` and `local/tasks/` are no longer task folders: nothing
// writes tasks there and files left there are not read as tasks.
export const TASK_DIRS = ['fg-tasks/', 'local/fg-tasks/'];
export function isTaskPath(path: unknown): boolean {
    // `fg-tasks/../AGENTS.md` starts with the task folder and resolves outside it (codex R362).
    return typeof path === 'string' && TASK_DIRS.some(d => path.startsWith(d)) && !/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(path);
}
/** The board's index file: a task folder's ledger.md is not a task (codex R365). */
export const isLedgerPath = (path: unknown): boolean => /(?:^|\/)ledger\.md$/.test(String(path ?? ''));
/** Statuses a task can have, after aliases (review, completed) are mapped; anything else is a typo the board and the runner would read differently (codex R366). */
export const TASK_STATUSES = ['todo', 'open', 'in-progress', 'in-review', 'done', 'blocked', 'failed'];
// fg-tasks/current.md is the scratch note a chat starts with (task-setup skill), not a board task: no gates, no duplicate check against it.
export const isScratchTask = (path: unknown): boolean => /^(?:\.\/)?fg-tasks\/current\.md$/.test(String(path ?? ''));

// A task file written by a worker run's merge keeps the front matter it has on disk (id, title, status, depends…); only the body is the worker's. A status
// moves through the gates only (kanbanflow set 3, vague: a worker's copy said done, the unticked box and every gate went unseen), and a copy without the `id`
// line took the task out of every dependency lookup ("#005 needs #004" with #004 done, the board stopped with two tasks open).
const _FM_BLOCK = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
export function keepTaskFrontMatter(path: string, previous: string | null, next: string): string {
    if (previous === null || !isTaskPath(path) || isScratchTask(path) || /\/ledger\.md$/.test(path) || !/\.md$/i.test(path)) return next;
    const was = _FM_BLOCK.exec(previous)?.[0];
    if (!was) return next;
    return (was.endsWith('\n') ? was : was + '\n') + next.replace(_FM_BLOCK, '');
}

// A task's id: the front matter's, else the number its file name starts with (a file whose `id:` line was lost is still #004 to the tasks that depend on it).
export const taskIdOf = (t: { path?: string; fm?: any }): string => String(t.fm?.id ?? '').trim() || (String(t.path ?? '').match(/\/(\d+)-[^/]*$/) || [])[1] || '';
