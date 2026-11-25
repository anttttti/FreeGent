// review of b1674f7: the report of a failing test file kept its "== file (exit N)" header only when the output was short; `tail -n 15` cut it off a noisy one.
import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _testCommand } from '../qa.ts';

it('a failing test file that prints more than 15 lines still reports its exit status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-'));
    writeFileSync(join(dir, 'test_noisy.js'), 'for (let i = 0; i < 40; i++) console.log("line " + i); process.exit(3);');
    let out = '';
    try { out = execFileSync('bash', ['-c', _testCommand(['test_noisy.js'])], { cwd: dir, encoding: 'utf8' }); } catch (e: any) { out = String(e.stdout); }
    expect(out).toMatch(/^== test_noisy\.js \(exit 3\)$/m);
    expect(out).toContain('line 39');
    expect(out).not.toContain('line 0\n');   // the output is still clipped
    expect(out).toContain('FAILED: test_noisy.js');
});
