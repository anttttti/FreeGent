import { describe, it, expect, afterEach } from 'vitest';
import { _buildWorkspaceDesc } from '../system-prompt.ts';

const W = globalThis as any;
afterEach(() => { delete W.hasLocalFolder; delete W.hasFsaFolder; });

describe('workspace description for local/ files (codex R343)', () => {
    it('says "write to disk" only when a live folder handle exists', () => {
        W.hasLocalFolder = () => true; W.hasFsaFolder = () => true;
        expect(_buildWorkspaceDesc()).toContain('changes write to disk');
        W.hasFsaFolder = () => false;   // imported snapshot, no handle
        const d = _buildWorkspaceDesc();
        expect(d).not.toContain('write to disk');
        expect(d).toContain('not on disk');
    });
});
