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
