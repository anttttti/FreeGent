import { describe, it, expect } from 'vitest';
import { dedupeTasksByTitle, taskTitleKey } from '../task-status.js';

const t = (id, title, status = 'open') => ({ path: `fg-tasks/${String(id).padStart(3, '0')}-x.md`, fm: { id: String(id), title, status } });

describe('dedupeTasksByTitle', () => {
    it('keeps the lowest id of tasks with the same title', () => {
        const out = dedupeTasksByTitle([t(5, 'Fix it', 'in-progress'), t(9, 'fix  it', 'in-progress'), t(7, 'Other')]);
        expect(out.map(x => x.fm.id)).toEqual(['5', '7']);
    });
    it('ignores a leading #NNN and never merges untitled tasks', () => {
        expect(taskTitleKey('#038 Remove it')).toBe('remove it');
        expect(dedupeTasksByTitle([t(1, ''), t(2, '')])).toHaveLength(2);
    });
});
