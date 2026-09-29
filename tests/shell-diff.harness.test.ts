// The browser-shell side of scripts/shell-diff.sh: runs each case in a fresh shell whose workspace
// holds the fixture files, and writes stdout plus "exit=N" per case. Skipped unless the script
// sets SHELL_DIFF_CASES / SHELL_DIFF_OUT / SHELL_DIFF_FIXTURES.
import { describe, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const files = vi.hoisted(() => new Map<string, { content: string; encoding: string | null }>());
vi.mock('../workspace', () => ({
    agentWriteFile:    async (name: string, content: string, encoding: string | null = null) => { files.set(name, { content, encoding }); },
    agentDeleteFile:   async (name: string) => { files.delete(name); },
    agentListFiles:    async () => [...files.keys()].map(name => ({ name })),
    readWorkspaceFile: async (name: string) => files.has(name) ? { name, ...files.get(name)! } : null,
}));

import { getShell, resetShell } from '../shiro/shell-singleton';

const { SHELL_DIFF_CASES: casesPath, SHELL_DIFF_OUT: outDir, SHELL_DIFF_FIXTURES: fixturesDir } = process.env;

function readTree(dir: string, root = dir, out = new Map<string, string>()) {
    for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) readTree(p, root, out);
        else out.set(relative(root, p), readFileSync(p, 'utf8'));
    }
    return out;
}

describe.skipIf(!casesPath)('shell diff (browser shell side)', () => {
    it('runs every case', async () => {
        const fixtures = readTree(fixturesDir!);
        // Same filtering as scripts/shell-diff.sh: skip blank lines and # comments.
        const cases = readFileSync(casesPath!, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#'));
        let n = 0;
        for (const c of cases) {
            n++;
            files.clear();
            for (const [name, content] of fixtures) files.set(name, { content, encoding: null });
            resetShell();
            const sh = await getShell();
            let out: string;
            try {
                const r = await Promise.race([
                    sh.exec(c),
                    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out after 10 s')), 10_000)),
                ]);
                out = r.stdout.replace(/\r\n/g, '\n') + `exit=${r.exitCode ?? 0}\n`;
            } catch (e: any) {
                out = `[shell error: ${e?.message ?? e}]\n`;
            }
            writeFileSync(join(outDir!, `shiro.${n}`), out);
        }
    }, 600_000);
});
