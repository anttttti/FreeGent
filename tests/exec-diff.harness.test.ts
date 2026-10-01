// The browser side of scripts/exec-diff.sh: runs each execute_code case the way the browser does
// — Python through pyodide-run.ts on a real Pyodide, JavaScript through exec-sandbox/js-run.ts —
// with the workspace records encoded and the changed files applied back as the page does
// (config.ts runWithPyodide, tools.ts), and writes stdout, "exit=N" and the files the case
// changed, per case. Skipped unless the script sets EXEC_DIFF_CASES / EXEC_DIFF_OUT /
// EXEC_DIFF_FIXTURES.
import { describe, it, vi } from 'vitest';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileChanges, loadNodePyodide, readTree, recordBytes, toRecord, type WsRecord } from './parity-utils';
import { decodeOutputFile, encodeInputFile, runInPyodide } from '../pyodide-run';
import { runJs } from '../exec-sandbox/js-run';
import { newShell, resetShell } from '../shiro/shell-singleton';
import { __setPyodideForTest } from '../shiro/commands/python';
import { textToBytes } from '../shiro/utils/bytes';

// The shell's workspace (shiro/fg-filesystem.ts → ../workspace): the case's records.
const shellFiles = vi.hoisted(() => new Map<string, { content: string; encoding: string | null }>());
vi.mock('../workspace', () => ({
    agentWriteFile:    async (name: string, content: string, encoding: string | null = null) => { shellFiles.set(name, { content, encoding }); },
    agentDeleteFile:   async (name: string) => { shellFiles.delete(name); },
    agentListFiles:    async () => [...shellFiles.keys()].map(name => ({ name })),
    readWorkspaceFile: async (name: string) => shellFiles.has(name) ? { name, ...shellFiles.get(name)! } : null,
}));

const { EXEC_DIFF_CASES: casesDir, EXEC_DIFF_OUT: outDir, EXEC_DIFF_FIXTURES: fixturesDir } = process.env;

describe.skipIf(!casesDir)('exec diff (browser side)', () => {
    it('runs every case', async () => {
        const fixtures = readTree(fixturesDir!);
        const names = readdirSync(casesDir!).filter(n => /\.(sh|py|js)$/.test(n))
            .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
        const py = names.some(n => /\.(py|sh)$/.test(n)) ? await loadNodePyodide() : null;
        if (py) __setPyodideForTest(py);   // python3 started from bash
        for (const name of names) {
            const code = readFileSync(join(casesDir!, name), 'utf8');
            const store = new Map<string, WsRecord>([...fixtures].map(([n, b]) => [n, toRecord(b)]));
            let out: string;
            if (name.endsWith('.sh')) {
                // execute_code bash (exec-sandbox/bash-run.ts): a fresh shell in /workspace. A fresh
                // filesystem per case too: the real side's /tmp is new each time.
                shellFiles.clear();
                for (const [n, r] of store) shellFiles.set(n, { ...r });
                resetShell();
                try {
                    const r = await Promise.race([
                        (await newShell()).exec(code),
                        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out after 20 s')), 20_000)),
                    ]);
                    out = r.stdout + `exit=${r.exitCode ?? 0}\n`;
                } catch (e: any) {
                    out = `[shell error: ${e?.message ?? e}]\n`;
                }
                store.clear();
                for (const [n, r] of shellFiles) store.set(n, { ...r });
            } else if (name.endsWith('.py')) {
                // config.ts runWithPyodide: records in, changed files applied back.
                const files = Object.fromEntries([...store].map(([n, r]) => [n, encodeInputFile(r)]));
                const r = await runInPyodide(py, { code, files });
                for (const [n, content] of Object.entries(r.changedFiles)) {
                    if (content === null) { store.delete(n); continue; }
                    const { data, encoding } = decodeOutputFile(content);
                    store.set(n, { content: data, encoding });
                }
                out = r.stdout + `exit=${r.exit_code}\n`;
            } else {
                // tools.ts: text records as strings, binary as { base64 }; written strings stored
                // as text, bytes as text when they are UTF-8 text, else as base64.
                const files = Object.fromEntries([...store].map(([n, r]) => [n, r.encoding === 'base64' ? { base64: r.content } : r.content]));
                const r: any = await runJs(code, files);
                for (const n of r.deleted) store.delete(n);
                for (const [n, c] of Object.entries(r.written as Record<string, string | Uint8Array>))
                    store.set(n, typeof c === 'string' ? { content: c, encoding: null } : toRecord(c));
                out = r.stdout + `exit=${r.exit_code}\n`;
            }
            out += fileChanges(fixtures, new Map([...store].map(([n, rec]) => [n, recordBytes(rec)])));
            writeFileSync(join(outDir!, `browser.${name}`), textToBytes(out));   // the bytes shell output stands for
        }
    }, 1_200_000);
});
