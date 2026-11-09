// codex R387: a test file name must reach the shell as data, also in the failure report.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _testCommand } from '../qa.ts';

describe('_testCommand', () => {
    it('does not run shell syntax in a failing test file\'s name', () => {
        const dir = mkdtempSync(join(tmpdir(), 'fgqa-'));
        const name = 'a$(touch PWNED).test.js';
        writeFileSync(join(dir, name), 'process.exit(1)\n');
        const r = spawnSync('bash', ['-c', _testCommand([name])], { cwd: dir, encoding: 'utf8' });
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('FAILED: ' + name);
        expect(existsSync(join(dir, 'PWNED'))).toBe(false);
    });
});
