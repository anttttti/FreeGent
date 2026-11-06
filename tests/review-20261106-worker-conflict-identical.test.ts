import { describe, it, expect, vi } from 'vitest';
import { resolveFileConflicts } from '../workers.ts';

describe('review: resolveFileConflicts identical versions handling', () => {
    it('auto-resolves when multiple (>2) workers write identical content without invoking the LLM', async () => {
        const mockLLM = vi.fn().mockResolvedValue('{"a.txt": "llm resolved"}');
        const conflicts = {
            'a.txt': {
                w1: 'export const x = 1;\n',
                w2: 'export const x = 1;\n',
                w3: 'export const x = 1;\n',
            },
        };

        const result = await resolveFileConflicts(conflicts, new Map([['a.txt', 'export const x = 0;\n']]), null, mockLLM);

        // When all workers wrote identical content, it should auto-merge without calling the LLM.
        expect(mockLLM).not.toHaveBeenCalled();
        expect(result.resolved['a.txt']).toBe('export const x = 1;\n');
        expect(result.stats.llm).toBe(0);
    });
});
