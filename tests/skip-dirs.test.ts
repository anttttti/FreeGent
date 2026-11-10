import { describe, it, expect } from 'vitest';
import { SKIP_DIRS, BROWSER_FOLDER_SKIP_DIRS } from '../skip-dirs.ts';

describe('skip-dirs', () => {
    it('a folder opened live skips what an imported one does, and the base set is in both', () => {
        for (const d of SKIP_DIRS) expect(BROWSER_FOLDER_SKIP_DIRS.has(d), d).toBe(true);
        expect(SKIP_DIRS.has('target')).toBe(true);                 // a Rust target/ was walked when the folder was opened live
        expect(BROWSER_FOLDER_SKIP_DIRS.has('vendor')).toBe(true);
        expect(SKIP_DIRS.has('vendor')).toBe(false);                // not hidden from the agent in a headless run: it can be a project's own code
    });
});
