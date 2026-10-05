// The browser side of scripts/exec-diff.sh: runs each execute_code case the way the browser does
// — Python through pyodide-run.ts on a real Pyodide, JavaScript through exec-sandbox/js-run.ts —
// with the workspace records encoded and the changed files applied back as the page does
// (config.ts runWithPyodide, tools.ts), and writes stdout, "exit=N" and the files the case
// changed, per case. Skipped unless the script sets EXEC_DIFF_CASES / EXEC_DIFF_OUT /
// EXEC_DIFF_FIXTURES.
import { describe, it, vi } from 'vitest';
import { readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fileChanges, loadNodePyodide, readTree, recordBytes, toRecord, type WsRecord } from './parity-utils';
import { decodeOutputFile, encodeInputFile, runInPyodide } from '../pyodide-run';
import { runJs } from '../exec-sandbox/js-run';
import { newShell, resetShell } from '../shiro/shell-singleton';
import { __setPyodideForTest } from '../shiro/commands/python';
import { textToBytes } from '../shiro/utils/bytes';
import { __setSevenZipForTest } from '../shiro/commands/sevenzip';
import { loadNodeSevenZip } from './helpers/node-sevenzip';
import { listAvailable } from '../shiro/wasi-packages';
import { setWasiWorkerFactory } from '../shiro/wasi-host';
import { nodeWorkerFactory } from './helpers/node-wasi-worker';

// The shell's workspace (shiro/fg-filesystem.ts → ../workspace): the case's records.
const shellFiles = vi.hoisted(() => new Map<string, { content: string; encoding: string | null }>());
vi.mock('../workspace', () => ({
    agentWriteFile:    async (name: string, content: string, encoding: string | null = null) => { shellFiles.set(name, { content, encoding }); },
    agentDeleteFile:   async (name: string) => { shellFiles.delete(name); },
    agentListFiles:    async () => [...shellFiles.keys()].map(name => ({ name })),
    readWorkspaceFile: async (name: string) => shellFiles.has(name) ? { name, ...shellFiles.get(name)! } : null,
}));

const { EXEC_DIFF_CASES: casesDir, EXEC_DIFF_OUT: outDir, EXEC_DIFF_FIXTURES: fixturesDir, EXEC_DIFF_NAMES: namesFile } = process.env;

describe.skipIf(!casesDir)('exec diff (browser side)', () => {
    it('runs every case', async () => {
        const fixtures = readTree(fixturesDir!);
        const names = (namesFile ? readFileSync(namesFile, 'utf8').split('\n').filter(Boolean) : readdirSync(casesDir!).filter(n => /\.(sh|py|js)$/.test(n)))
            .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
        const py = names.some(n => /\.(py|sh)$/.test(n)) ? await loadNodePyodide() : null;
        if (py) __setPyodideForTest(py);   // python3 started from bash
        const indexPath = join(casesDir!, 'coverage-index.json');
        const index = readdirSync(casesDir!).includes('coverage-index.json')
            ? JSON.parse(readFileSync(indexPath, 'utf8')) : { cases: [] };
        const caseFixtures = readdirSync(casesDir!).includes('case-fixtures.json')
            ? JSON.parse(readFileSync(join(casesDir!, 'case-fixtures.json'), 'utf8')) : {};
        const httpCases = new Set<string>(index.cases.filter((c: any) => c.fixture === 'http').map((c: any) => c.id));
        const fetchMock = vi.mocked(globalThis.fetch);
        const previousFetch = fetchMock.getMockImplementation();
        const nativeFetch: typeof fetch = (globalThis as any).__nativeFetchForTests;
        const packages = new Set(listAvailable().map(p => p.url));
        if (process.env.FG_NET_TESTS) {
            // FG_WASI_TRACE=1 prints the guest's WASI calls; FG_WASI_TRACE=/path appends them to that file
            // (the test setup swallows console output, so a file is the way to read a long trace).
            if (process.env.FG_WASI_TRACE) {
                const target = process.env.FG_WASI_TRACE;
                (globalThis as any).__fgWasiTrace = target === '1' ? (line:string) => console.warn(line) : (line:string) => appendFileSync(target, line + '\n');
            }
            setWasiWorkerFactory(await nodeWorkerFactory());
            if (names.some(name=>name.startsWith('coverage-7z-'))) {
                const {factory,wasmBinary} = await loadNodeSevenZip(nativeFetch);
                __setSevenZipForTest(factory,wasmBinary);
            }
        }
        const server = names.some(n => httpCases.has(n)) ? createServer((req, res) => {
            const path = req.url ?? '/';
            if (path === '/redirect') {
                res.writeHead(302, { Location: '/words.txt' }); res.end(); return;
            }
            if (req.method === 'POST') {
                const chunks: Buffer[] = [];
                req.on('data', chunk => chunks.push(Buffer.from(chunk)));
                req.on('end', () => {
                    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
                    res.end(Buffer.concat(chunks));
                });
                return;
            }
            const body = path.startsWith('/header/')
                ? Buffer.from(String(req.headers[path.slice(8).toLowerCase()] ?? '') + '\n')
                : fixtures.get(path.slice(1));
            res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/octet-stream' });
            res.end(body ?? Buffer.from('not found\n'));
        }) : null;
        if (server) {
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(18080, '127.0.0.1', resolve);
            });
        }
        if (server || process.env.FG_NET_TESTS) {
            if (typeof nativeFetch !== 'function') throw new Error('Replay requires the native fetch captured by tests/setup.js');
            // net.ts has already captured this mock. Relay real HTTP requests through
            // the original Node fetch, including bodies, headers and redirects.
            fetchMock.mockImplementation(async (input, init = {}) => {
                const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
                if (url.origin !== 'http://127.0.0.1:18080' && !(process.env.FG_NET_TESTS && packages.has(url.href)))
                    throw new Error('Replay permits its local HTTP fixture and opt-in pinned WASM downloads');
                return nativeFetch(url.href, init);
            });
        }
        try {
            for (const name of names) {
                const initialFiles = new Map(fixtures);
                for (const [path, text] of Object.entries(caseFixtures[name]?.files ?? {})) {
                    if (path.startsWith('/') || path.split('/').includes('..')) throw new Error('Invalid case fixture path');
                    initialFiles.set(path, Buffer.from(text as string));
                }
                for (const [path, b64] of Object.entries(caseFixtures[name]?.files_base64 ?? {})) {
                    if (path.startsWith('/') || path.split('/').includes('..')) throw new Error('Invalid case fixture path');
                    initialFiles.set(path, Buffer.from(b64 as string, 'base64'));
                }
                const code = readFileSync(join(casesDir!, name), 'utf8');
                const store = new Map<string, WsRecord>([...initialFiles].map(([n, b]) => [n, toRecord(b)]));
                let out: string;
                let stdout = '', stderr = '', exitCode: number | null = null;
                if (name.endsWith('.sh')) {
                    // execute_code bash (exec-sandbox/bash-run.ts): a fresh shell in /workspace. A fresh
                    // filesystem per case too: the real side's /tmp is new each time.
                    shellFiles.clear();
                    for (const [n, r] of store) shellFiles.set(n, { ...r });
                    resetShell();
                    try {
                        const shell = await newShell();
                        if (name.startsWith('coverage-')) Object.assign(shell.env, { HOME: '/workspace', LC_ALL: 'C.UTF-8', TZ: 'UTC', TERM: 'xterm', NO_COLOR: '1' });
                        let timer: ReturnType<typeof setTimeout> | undefined;
                        const r = await Promise.race([
                            shell.exec(code),
                            new Promise<never>((_, rej) => {
                                timer = setTimeout(() => { shell.abortController?.abort(); rej(new Error('timed out after 20 s')); }, 20_000);
                            }),
                        ]).finally(() => clearTimeout(timer));
                        out = r.stdout + `exit=${r.exitCode ?? 0}\n`;
                        stdout = r.stdout; stderr = r.stderr; exitCode = r.exitCode ?? 0;
                    } catch (e: any) {
                        out = `[shell error: ${e?.message ?? e}]\n`;
                        stderr = out;
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
                    stdout = r.stdout; stderr = r.stderr; exitCode = r.exit_code;
                } else {
                    // tools.ts: text records as strings, binary as { base64 }; written strings stored
                    // as text, bytes as text when they are UTF-8 text, else as base64.
                    const files = Object.fromEntries([...store].map(([n, r]) => [n, r.encoding === 'base64' ? { base64: r.content } : r.content]));
                    const r: any = await runJs(code, files);
                    for (const n of r.deleted) store.delete(n);
                    for (const [n, c] of Object.entries(r.written as Record<string, string | Uint8Array>))
                        store.set(n, typeof c === 'string' ? { content: c, encoding: null } : toRecord(c));
                    out = r.stdout + `exit=${r.exit_code}\n`;
                    stdout = r.stdout; stderr = r.stderr; exitCode = r.exit_code;
                }
                const changedFiles = fileChanges(initialFiles, new Map([...store].map(([n, rec]) => [n, recordBytes(rec)])));
                out += changedFiles;
                writeFileSync(join(outDir!, `browser.${name}`), textToBytes(out));   // the bytes shell output stands for
                writeFileSync(join(outDir!, `browser.stdout.${name}`), textToBytes(stdout));
                writeFileSync(join(outDir!, `browser.stderr.${name}`), textToBytes(stderr));
                writeFileSync(join(outDir!, `browser.exit.${name}`), `${exitCode ?? 'harness-error'}\n`);
                writeFileSync(join(outDir!, `browser.files.${name}`), changedFiles);
            }
        } finally {
            delete (globalThis as any).__fgWasiTrace;
            setWasiWorkerFactory(null);
            __setSevenZipForTest(null);
            if (previousFetch) fetchMock.mockImplementation(previousFetch);
            else fetchMock.mockReset();
            if (server) await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
        }
    }, 1_200_000);
});
