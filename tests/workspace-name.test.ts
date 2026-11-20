// Workspace file names are relative; every caller's "/workspace/x", "/x" and "./x" mean "x".
import { describe, it, expect } from 'vitest';
import { workspaceName } from '../workspace.ts';

describe('workspaceName', () => {
    it('maps runtime and absolute forms to the relative name', () => {
        expect(workspaceName('/workspace/src/app.js')).toBe('src/app.js');
        expect(workspaceName('/src/app.js')).toBe('src/app.js');
        expect(workspaceName('./src/app.js')).toBe('src/app.js');
        expect(workspaceName('src/app.js')).toBe('src/app.js');
        expect(workspaceName('/workspace')).toBe('');
        expect(workspaceName('local/a.txt')).toBe('local/a.txt');
    });
    it('leaves a folder merely named like the mount alone', () => {
        expect(workspaceName('workspace/notes.md')).toBe('workspace/notes.md');
        expect(workspaceName('/workspaces/x')).toBe('workspaces/x');
    });
    it('refuses a NUL or an unpaired surrogate, and keeps emoji (Z010)', () => {
        expect(() => workspaceName('a\0b.txt')).toThrow(/NUL/);
        expect(() => workspaceName('x\uD800.txt')).toThrow(/surrogate/);
        expect(() => workspaceName('y\uDC00.txt')).toThrow(/surrogate/);
        expect(workspaceName('😀/é.txt')).toBe('😀/é.txt');
    });
});
