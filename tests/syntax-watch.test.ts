// Experiment syntax_watch: files an execute_code run changed are parse-checked, and the chat keeps the list of files left broken.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeExec } from '../native-exec.ts';
import { openSyntaxErrors } from '../tools.ts';

const W = globalThis as any;
let dir: string, saved: any;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fg-synwatch-'));
    saved = { exec: W.nativeExec, role: W.mainAgentRole, env: process.env.FG_EXPERIMENTS };
    W.nativeExec = createNativeExec({ workspaceRoot: dir });
    W.mainAgentRole = null;
    process.env.FG_EXPERIMENTS = 'syntax_watch';
});
afterEach(() => {
    W.nativeExec = saved.exec; W.mainAgentRole = saved.role;
    if (saved.env === undefined) delete process.env.FG_EXPERIMENTS; else process.env.FG_EXPERIMENTS = saved.env;
    rmSync(dir, { recursive: true, force: true });
});
const sh = (code: string) => W.executeToolAsync('execute_code', { language: 'bash', code }, null);

describe('syntax_watch', () => {
    it('reports a Python or shell file a command broke, and forgets it once it parses again', async () => {
        const r = await sh(`printf 'def f(:\\n    pass\\n' > bad.py; printf 'if then\\n' > run.sh`);
        expect(r.syntax_errors.join('\n')).toMatch(/bad\.py: [\s\S]*SyntaxError/);
        expect(r.syntax_errors.join('\n')).toMatch(/run\.sh: .*syntax error/);
        expect(openSyntaxErrors().map(([p]) => p).sort()).toEqual(['bad.py', 'run.sh']);
        const fixed = await sh(`printf 'def f():\\n    pass\\n' > bad.py; rm run.sh`);
        expect(fixed.syntax_errors).toBeUndefined();
        expect(openSyntaxErrors()).toEqual([]);
    });

    it("checks a worker's staged Python edit, which is not on disk, under the file's own name", async () => {
        const context = { staging: new Map(), snapshot: new Map(), binary: new Map(), codeBinary: new Set() };
        const r = await W.executeToolAsync('write_file', { path: 'pkg/w.py', content: 'def f(:\n    pass\n' }, context);
        expect(r.syntax_error).toMatch(/File "pkg\/w\.py", line 1[\s\S]*SyntaxError/);
    });

    it('is off without the experiment', async () => {
        delete process.env.FG_EXPERIMENTS;
        expect((await sh(`printf 'def f(:\\n' > bad.py`)).syntax_errors).toBeUndefined();
    });
});
