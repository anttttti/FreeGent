// The browser-shell side of scripts/shell-diff.sh: runs each case in a fresh shell whose workspace
// holds the fixture files, and writes stdout, "exit=N" and the files the case changed, per case.
// python3 runs on a real Pyodide (the npm package, the build the browser loads from the CDN).
// Skipped unless the script sets SHELL_DIFF_CASES / SHELL_DIFF_OUT / SHELL_DIFF_FIXTURES.
import { describe, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileChanges, loadNodePyodide, readTree, recordBytes, toRecord, type WsRecord } from './parity-utils';

const files = vi.hoisted(() => new Map<string, { content: string; encoding: string | null }>());
vi.mock('../workspace', () => ({
    agentWriteFile:    async (name: string, content: string, encoding: string | null = null) => { files.set(name, { content, encoding }); },
    agentDeleteFile:   async (name: string) => { files.delete(name); },
    agentListFiles:    async () => [...files.keys()].map(name => ({ name })),
    readWorkspaceFile: async (name: string) => files.has(name) ? { name, ...files.get(name)! } : null,
}));

import { getShell, resetShell } from '../shiro/shell-singleton';
import { __setPyodideForTest } from '../shiro/commands/python';
import { textToBytes } from '../shiro/utils/bytes';

const { SHELL_DIFF_CASES: casesPath, SHELL_DIFF_OUT: outDir, SHELL_DIFF_FIXTURES: fixturesDir } = process.env;

describe.skipIf(!casesPath)('shell diff (browser shell side)', () => {
    it('runs every case', async () => {
        const fixtures = readTree(fixturesDir!);
        const records = new Map<string, WsRecord>([...fixtures].map(([n, b]) => [n, toRecord(b)]));
        // Same filtering as scripts/shell-diff.sh: skip blank lines and # comments.
        const cases = readFileSync(casesPath!, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#'));
        if (cases.some(c => /\bpython3?\b|\bpip3?\b/.test(c))) {
            __setPyodideForTest(await loadNodePyodide());
        }
        let n = 0;
        for (const c of cases) {
            n++;
            files.clear();
            for (const [name, rec] of records) files.set(name, { ...rec });
            resetShell();
            const sh = await getShell();
            let out: string;
            try {
                const r = await Promise.race([
                    sh.exec(c),
                    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out after 10 s')), 10_000)),
                ]);
                out = r.stdout + `exit=${r.exitCode ?? 0}\n`;
            } catch (e: any) {
                out = `[shell error: ${e?.message ?? e}]\n`;
            }
            out += fileChanges(fixtures, new Map([...files].map(([name, rec]) => [name, recordBytes(rec)])));
            // The bytes the output stands for (non-UTF-8 bytes are escaped in shell strings).
            writeFileSync(join(outDir!, `shiro.${n}`), textToBytes(out));
        }
    }, 1_200_000);
});
