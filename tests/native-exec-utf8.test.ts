// native-exec.ts: output is decoded per stream, not per chunk. A multi-byte character that a process writes
// in pieces (OS case080: 資料🙂café, one byte at a time, 40 ms apart) arrives intact on stdout and stderr.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNativeExec } from '../native-exec.ts';

const PY = (stream: string) => `
import sys, time
data = '資料🙂café\\n'.encode('utf-8')
out = sys.${stream}.buffer
for b in data:
    out.write(bytes([b])); out.flush(); time.sleep(0.02)
`;

describe('native execute_code output decoding', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-utf8-'));
    const exec = createNativeExec({ workspaceRoot: dir });
    it('keeps multi-byte characters written one byte at a time on stdout', async () => {
        const r = await exec('python', PY('stdout'));
        expect(r.exit_code).toBe(0);
        expect(r.stdout).toBe('資料🙂café\n');
        expect(r.stdout).not.toContain('�');
    }, 20000);
    it('and on stderr', async () => {
        const r = await exec('python', PY('stderr'));
        expect(r.stderr).toBe('資料🙂café\n');
        expect(r.stderr).not.toContain('�');
    }, 20000);
    it('ASCII output is unchanged', async () => {
        const r = await exec('bash', 'echo hello; echo oops >&2');
        expect(r.stdout).toBe('hello\n');
        expect(r.stderr).toBe('oops\n');
        rmSync(dir, { recursive: true, force: true });
    });
});
