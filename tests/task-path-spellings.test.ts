// reviews of 637e3e7 and 6cd1c5b: every spelling workspace I/O resolves to the scratch note or a task file is classified the same way.
import { describe, it, expect } from 'vitest';
import { isScratchTask, isTaskPath } from '../task-status.ts';

describe('task path spellings', () => {
    it('the scratch note is recognised however it is written', () => {
        for (const p of ['fg-tasks/current.md', './fg-tasks/current.md', 'fg-tasks/./current.md', '/workspace/fg-tasks/current.md', 'fg-tasks//current.md']) expect(isScratchTask(p), p).toBe(true);
        for (const p of ['fg-tasks/001-x.md', 'x/fg-tasks/current.md', 'fg-tasks/current.md.bak']) expect(isScratchTask(p), p).toBe(false);
    });
    it('a task file under /workspace/ is a task file; a path that leaves the folder is not', () => {
        expect(isTaskPath('/workspace/fg-tasks/001-x.md')).toBe(true);
        expect(isTaskPath('local/fg-tasks/./001-x.md')).toBe(true);
        expect(isTaskPath('fg-tasks/../AGENTS.md')).toBe(false);
    });
});
