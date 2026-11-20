// The Python preview page puts the working directory into Python source: a folder name with an apostrophe or a newline must still give valid code (Z005).
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';

const hasPy = spawnSync('python3', ['--version']).status === 0;
const W: any = window;
beforeAll(async () => { W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} }); await import('../workspace.ts'); });

describe.skipIf(!hasPy)('Python runner setup code', () => {
    it('compiles for folder names with quotes, a backslash and a newline', () => {
        for (const dir of ["it's here", 'say "hi"', 'back\\slash', 'line\nbreak']) {
            const html: string = W.buildPyRunnerHtml(`${dir}/main.py`, 'import os\nprint(1)', {});
            for (const key of ['_SYS', '_CHK', '_CD']) {
                const src = JSON.parse(new RegExp(`${key}=(".*?(?<!\\\\)"),`).exec(html.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>'))![1]);
                const r = spawnSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "setup", "exec")'], { input: src, encoding: 'utf8' });
                expect(r.status, `${key} for ${JSON.stringify(dir)}: ${r.stderr}`).toBe(0);
            }
        }
    });
});
