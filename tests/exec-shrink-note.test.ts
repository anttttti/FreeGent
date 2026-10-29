// Self-analysis 2026-10-29 P6: Python's open(path, 'w') then a failing write() left model-caps.ts at 0 bytes, and the result said only
// files_written; P2 cut 590 lines out of tools.ts. A written file that is now empty or much smaller is named in the result.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeExec } from '../native-exec.ts';
import { shrinkNote } from '../exec-limits.ts';

describe('shrinkNote', () => {
    it('names an emptied file and a large loss, and leaves ordinary edits alone', () => {
        const n = shrinkNote([
            { path: 'model-caps.ts', before: 18423, after: 0 },
            { path: 'tools.ts', before: 198591, after: 154080 },
            { path: 'small.ts', before: 3000, after: 100 },       // lost less than 4000 bytes
            { path: 'edit.ts', before: 50000, after: 47000 },     // a normal edit
            { path: 'new.ts', before: null, after: 0 },           // not there before
        ], true)!;
        expect(n).toMatch(/model-caps\.ts is now EMPTY \(it was 18,423 bytes\)/);
        expect(n).toMatch(/tools\.ts shrank from 198,591 to 154,080 bytes \(-22%\)/);
        expect(n).not.toMatch(/small\.ts|edit\.ts|new\.ts/);
        expect(n).toMatch(/The code failed/);
        expect(shrinkNote([{ path: 'a', before: 10, after: 12 }], false)).toBeNull();
    });
});

describe('native execute_code', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fg-shrink-')); });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('reports a file that a failing script opened for writing and left empty', async () => {
        writeFileSync(join(dir, 'model-caps.ts'), 'export const x = 1;\n'.repeat(900));
        const run = createNativeExec({ workspaceRoot: dir });
        const r = await run('python', "f = open('model-caps.ts', 'w')\nf.write(['a', 'b'])\n");
        expect(r.exit_code).not.toBe(0);
        expect(r.files_written).toContain('model-caps.ts');
        expect(r.note).toMatch(/model-caps\.ts is now EMPTY \(it was 18,000 bytes\)/);
    });

    it('says nothing for a script that rewrites a file at a similar size', async () => {
        writeFileSync(join(dir, 'a.txt'), 'x'.repeat(10000));
        const run = createNativeExec({ workspaceRoot: dir });
        const r = await run('python', "open('a.txt', 'w').write('y' * 9800)\n");
        expect(r.exit_code).toBe(0);
        expect(r.note ?? '').not.toMatch(/EMPTY|shrank/);
    });
});
