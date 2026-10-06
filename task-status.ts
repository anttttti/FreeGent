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
