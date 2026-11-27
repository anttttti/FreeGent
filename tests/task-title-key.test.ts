import { describe, it, expect } from 'vitest';
import { taskTitleKey, dedupeTasksByTitle } from '../task-status.ts';

// EV023: a leading id is ignored when titles are compared for duplicates; a quantity at the start of a title is not an id.
describe('task title identity', () => {
    it('ignores a leading id, not a leading quantity', () => {
        expect(taskTitleKey('#003 Write docs')).toBe(taskTitleKey('write  docs'));
        expect(taskTitleKey('003 Write docs')).toBe('write docs');
        expect(taskTitleKey('3. Write docs')).toBe('write docs');
        expect(taskTitleKey('1 MB attachment')).not.toBe(taskTitleKey('10 MB attachment'));
        const t = (id: string, title: string) => ({ path: `fg-tasks/${id}-x.md`, fm: { id, title } });
        expect(dedupeTasksByTitle([t('1', '1 MB attachment'), t('2', '10 MB attachment')])).toHaveLength(2);
    });
});

// EV022: Autopilot must not pick a task whose dependency id is shared by an open and a done file, whichever loads last.
describe('runner dependency selection with duplicate ids', () => {
    it('a dependency is met only when every task with that id is done', async () => {
        const { _unmetDeps } = await import('../runner.ts');
        const t = (path: string, fm: any) => ({ path, fm }) as any;
        const dep = t('fg-tasks/003-a.md', { id: '003', status: 'todo' }), doneCopy = t('fg-tasks/003-b.md', { id: '3', status: 'done' });
        const user = t('fg-tasks/004-c.md', { id: '004', depends: '3' });
        expect(_unmetDeps(user, [dep, doneCopy, user])).toEqual(['3']);
        expect(_unmetDeps(user, [doneCopy, dep, user])).toEqual(['3']);
        expect(_unmetDeps(user, [{ ...dep, fm: { ...dep.fm, status: 'done' } }, doneCopy, user])).toEqual([]);
    });
});
