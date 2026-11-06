import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BACKENDS } from './tool-backends';

const W = globalThis as any;
const tool = (name: string, args: any) => W.executeToolAsync(name, args, null);

describe.each(BACKENDS)('review: replace_in_file and apply_patch path handling ($name)', be => {
    beforeEach(be.setup, 120_000);
    afterEach(() => be.teardown());

    it('requires path and explains the missing argument on replace_in_file', async () => {
        const res = await tool('replace_in_file', { old_string: 'hello', new_string: 'hi' });
        expect(res.error).toMatch(/replace_in_file:.*"path" is required|missing required argument "path"/i);
    });

    // Other names for `path` (filename, file, filepath) are mapped before dispatch by _repairPathArg (tool-call-repair.ts), which
    // tests/tool-call-repair.test.js covers; calling executeToolAsync directly bypasses it, so that case is not tested here.

    it('requires path and explains the missing argument on apply_patch when diff has no header', async () => {
        const headerlessPatch = '@@ -1,1 +1,1 @@\n-hello world\n+hi world\n';
        const res = await tool('apply_patch', { patch: headerlessPatch });
        expect(res.error).toMatch(/apply_patch:.*"path" is required|missing required argument "path"/i);
    });
});
