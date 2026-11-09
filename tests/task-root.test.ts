import { describe, it, expect } from 'vitest';
import { taskRootOf, newTaskRoot } from '../task-status.js';

// codex R381/R383/R384: a task, its project files and a new task all belong to one root.
describe('task roots', () => {
    it('a task belongs to the root its path starts in', () => {
        expect(taskRootOf('fg-tasks/001-a.md')).toBe('');
        expect(taskRootOf('local/fg-tasks/001-a.md')).toBe('local/');
    });
    it('a new task goes where the board\'s tasks are: the folder only when every task is there', () => {
        expect(newTaskRoot([])).toBe('');
        expect(newTaskRoot([{ path: 'fg-tasks/001-a.md' }])).toBe('');
        expect(newTaskRoot([{ path: 'local/fg-tasks/001-a.md' }, { path: 'local/fg-tasks/002-b.md' }])).toBe('local/');
        expect(newTaskRoot([{ path: 'local/fg-tasks/001-a.md' }, { path: 'fg-tasks/002-b.md' }])).toBe('');
    });
});
