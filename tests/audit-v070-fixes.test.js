// Fixes from the v0.70 bug audit (bench/notes/2026_10_12_v0.70_bug_audit.md), one block per item.
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeExec, signalExitCode } from '../native-exec.ts';
import { execFailure, EXECUTE_TIMEOUT_MS } from '../dev-api.ts';
import { _isLocalEp, _makeOAIRetryHandler, withRetry } from '../retry.ts';
import { compactHistory, _userText } from '../llm-shared.ts';
import { intSetting, getAgentCompactAt, getOAIContextTokens } from '../config.ts';
import { NodeFsAdapter, readFailureMessage } from '../node-fs-adapter.ts';
import { isTaskPath, TASK_DIRS } from '../task-status.ts';
import { COMPLETION_TRIGGERS } from '../skill-guidance.ts';
import { scrubEnv, hasUrlCredential } from '../secret-env.ts';
import { FILE_WRITE_TOOLS, WORKSPACE_WRITE_TOOLS, MAY_WRITE_TOOLS } from '../tool-effects.ts';
import { _WRITE_TOOLS } from '../llm-loops.ts';
import { setMetricsWriter, metricsNote } from '../convo-log.ts';
import { NULL_RENDER_ADAPTER } from '../render-adapter.ts';

const W = globalThis;
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fg-audit-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); localStorage.clear(); });

describe('A1/A2/A7. native execute_code', () => {
    it('a command that prints more than 200 KB runs to its end and keeps its exit code', async () => {
        const run = createNativeExec({ workspaceRoot: dir });
        const r = await run('bash', 'head -c 600000 /dev/zero | tr "\\0" "a"; echo; echo END-REACHED; touch marker.txt; exit 3');
        expect(r.exit_code).toBe(3);
        expect(r.stdout).toContain('END-REACHED');
        expect(r.stdout).toMatch(/chars omitted/);
        expect(r.stdout.length).toBeLessThan(6000);
        expect(existsSync(join(dir, 'marker.txt'))).toBe(true);
        expect(r.files_written).toContain('marker.txt');          // recorded although the command failed
    });
    it('a command ended by a signal is not a success', async () => {
        const run = createNativeExec({ workspaceRoot: dir });
        const r = await run('bash', 'kill -9 $$');
        expect(r.exit_code).toBe(137);
        expect(r.signal).toBe('SIGKILL');
        expect(signalExitCode('SIGTERM')).toBe(143);
        expect(signalExitCode(null)).toBe(128);
    });
    it('sees changes to .github and .gitignore, not to .git', async () => {
        mkdirSync(join(dir, '.git'));
        const run = createNativeExec({ workspaceRoot: dir });
        const r = await run('bash', 'mkdir -p .github/workflows && echo a > .github/workflows/ci.yml && echo b > .gitignore && echo c > .git/x');
        expect(r.files_written.sort()).toEqual(['.github/workflows/ci.yml', '.gitignore']);
    });
    it('does not count a test runner\'s cache as files the command wrote', async () => {
        const run = createNativeExec({ workspaceRoot: dir });
        const r = await run('bash', 'mkdir -p .pytest_cache/v pkg/__pycache__ && echo x > .pytest_cache/v/lastfailed && echo x > pkg/__pycache__/m.pyc && echo x > .coverage && echo y > result.txt; exit 1');
        expect(r.exit_code).toBe(1);
        expect(r.files_written).toEqual(['result.txt']);
    });
});

describe('A3. dev server: how a failed command ended', () => {
    it('recognises a timeout and oversized output, and passes exit codes through', () => {
        expect(execFailure({ code: null, killed: true, signal: 'SIGTERM' })).toMatchObject({ exit_code: 124 });
        expect(execFailure({ code: null, killed: true, signal: 'SIGTERM' }).note).toContain(`${EXECUTE_TIMEOUT_MS / 1000}s`);
        expect(execFailure({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }).note).toMatch(/more than 10 MB/);
        expect(execFailure({ code: 2 })).toEqual({ exit_code: 2, note: '' });
        expect(execFailure({ code: null, signal: 'SIGSEGV' }).note).toMatch(/SIGSEGV/);
        expect(execFailure({ code: 'ENOENT' }).note).toMatch(/ENOENT/);
    });
});

describe('A4. a vLLM endpoint is a local endpoint', () => {
    it('a 404 does not pause the model, and a rejected request is tried a few times only', () => {
        expect(_isLocalEp({ provider: 'vllm' })).toBe(true);
        expect(_isLocalEp({ provider: 'custom' })).toBe(true);
        expect(_isLocalEp({ provider: 'openrouter' })).toBe(false);
        const paused = [];
        const savedGet = W.getPausedMainModels, savedSet = W.savePausedMainModels;
        W.getPausedMainModels = () => paused; W.savePausedMainModels = (l) => { paused.splice(0, paused.length, ...l); };
        try {
            const ep = { provider: 'vllm', model: 'local-model', url: 'http://localhost:8000/v1' };
            const h = _makeOAIRetryHandler({ getEp: () => ep, setEp: () => {}, onNote: () => {} });
            const e = new Error('[vllm] HTTP 404: The model `local-model` does not exist.');
            expect(h(0, e, 1500)).not.toBe(false);
            expect(h(1, e, 1500)).not.toBe(false);
            expect(h(2, e, 1500)).toBe(false);
            expect(paused).toEqual([]);
        } finally { W.getPausedMainModels = savedGet; W.savePausedMainModels = savedSet; }
    });
});

describe('A5. compaction pins the first user message, whatever its shape', () => {
    it('uses the text of a message sent with an attachment, not a later nudge', async () => {
        expect(_userText({ content: [{ type: 'image_url', image_url: { url: 'data:…' } }, { type: 'text', text: 'Describe this chart.' }] })).toBe('Describe this chart.');
        const hist = [
            { role: 'user', content: [{ type: 'text', text: 'Describe this chart and save the answer to out.md.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
            { role: 'assistant', content: 'Looking at it.' },
            { role: 'user', content: '<nudge>Call a tool or end with COMPLETED.</nudge>' },
            { role: 'assistant', content: 'The chart shows sales by month.' },
            { role: 'user', content: 'Also list the top month.' },
            { role: 'assistant', content: 'March.' },
        ];
        const origFetch = W.fetch;
        W.fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Summary: the user asked about a chart; sales by month were described; the top month is March.' } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }),
            { status: 200, headers: { 'content-type': 'application/json' } }));
        const notes = [];
        setMetricsWriter((r) => notes.push(r));
        try {
            const ep = { provider: 'custom', model: 'm', url: 'http://localhost:9/v1/chat/completions' };
            const out = await compactHistory(NULL_RENDER_ADAPTER, ep, undefined, hist, { system: 'sys', tools: null });
            expect(out[0].role).toBe('user');
            expect(out[0].content).toContain('Describe this chart and save the answer to out.md.');
            expect(out[0].content).toContain('attachments sent with this message are not repeated');
            expect(out[0].content).not.toContain('<nudge>');
            // B6: the summary request is counted
            expect(notes.find(n => n.type === 'compaction')).toMatchObject({ promptTokens: 100, responseTokens: 20 });
        } finally { W.fetch = origFetch; setMetricsWriter(null); }
    });
});

describe('A6. numeric settings never become NaN', () => {
    it('falls back to the default for a value that is not a number', () => {
        localStorage.setItem('fg_agent_max_tool_result', '80k');
        localStorage.setItem('fg_agent_compact_tokens', 'lots');
        localStorage.setItem('fg_agent_compact_at', 'x');
        localStorage.setItem('fg_openai_context', '');
        W._lsCacheClear?.();
        expect(intSetting('fg_agent_max_tool_result', 100000, 1)).toBe(80);     // parseInt reads the leading digits
        expect(intSetting('fg_agent_compact_tokens', 80000)).toBe(80000);
        expect(intSetting('fg_missing_key', 7, 1, 5)).toBe(5);
        expect(getAgentCompactAt()).toBe(0.75);
        expect(getOAIContextTokens()).toBe(50000);
    });
});

describe('A9/B4. local file adapter', () => {
    it('says what a failed read was, and lists a project\'s own dot-files but no other dot-entry', async () => {
        mkdirSync(join(dir, 'src')); writeFileSync(join(dir, 'src/a.ts'), 'x');
        mkdirSync(join(dir, '.github/workflows'), { recursive: true }); writeFileSync(join(dir, '.github/workflows/ci.yml'), 'x');
        writeFileSync(join(dir, '.gitignore'), 'x'); writeFileSync(join(dir, '.env.example'), 'x');
        for (const d of ['.git', '.ssh', '.venv', '.cache', '.hidden']) { mkdirSync(join(dir, d)); writeFileSync(join(dir, d, 'f'), 'x'); }
        writeFileSync(join(dir, '.env'), 'SECRET=1'); writeFileSync(join(dir, '.npmrc'), 'token');
        const a = new NodeFsAdapter(dir);
        expect((await a.agentListFiles()).map(f => f.name).sort()).toEqual(['.env.example', '.github/workflows/ci.yml', '.gitignore', 'src/a.ts']);
        await expect(a.agentReadFile('src')).rejects.toThrow(/is a directory/);
        await expect(a.agentReadFile('nope.txt')).rejects.toThrow(/File not found: nope\.txt/);
        expect(readFailureMessage({ code: 'EACCES' }, 'x')).toMatch(/Permission denied/);
        expect(readFailureMessage({ code: 'ERR_FS_FILE_TOO_LARGE' }, 'x')).toMatch(/too large/);
    });
});

describe('A10. task folders', () => {
    it('recognises fg-tasks/ inside a Local Folder too', () => {
        for (const p of ['fg-tasks/001-a.md', 'local/fg-tasks/001-a.md']) expect(isTaskPath(p), p).toBe(true);
        for (const p of ['tasks/x.md', 'local/tasks/x.md', 'src/tasks/x.md', 'local/src/a.ts', 'mytasks/x.md', null]) expect(isTaskPath(p), String(p)).toBe(false);
        expect(TASK_DIRS).toContain('local/fg-tasks/');
    });
});

describe('A11. skill completion triggers', () => {
    it('a skill with an unknown trigger_on_completion value does not fire', async () => {
        const { completionGateGuidance } = await import('../skill-guidance.ts');
        const reg = W.skillsRegistry;
        const mk = (name, cond) => ({ name, description: '', trigger: '', body: `BODY-${name}`, trigger_on_completion: cond, roles: '', exclude_roles: '', exclude_mode: '', requires_tools: '' });
        reg.set('t-typo', mk('t-typo', 'alway')); reg.set('t-always', mk('t-always', 'always'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const out = String(completionGateGuidance(false, new Set(), false) ?? '');
            expect(out).toContain('BODY-t-always');
            expect(out).not.toContain('BODY-t-typo');
            expect(warn).toHaveBeenCalled();
            expect(COMPLETION_TRIGGERS.has('always_on_edit')).toBe(true);
        } finally { reg.delete('t-typo'); reg.delete('t-always'); warn.mockRestore(); }
    });
});

describe('A12. credentials inside URL-valued variables', () => {
    it('are not handed to agent commands', () => {
        const out = scrubEnv({ PATH: '/bin', DATABASE_URL: 'postgres://app:s3cret@db.internal:5432/x', REDIS_URL: 'redis://:pw@cache:6379',
            HOMEPAGE: 'https://example.com/a?b=c', GIT_AUTHOR: 'a@b.c', GEMINI_API_KEY: 'k', KEPT: 'https://u:p@h/x', FG_EXEC_KEEP_ENV: 'KEPT' });
        expect(Object.keys(out).sort()).toEqual(['FG_EXEC_KEEP_ENV', 'GIT_AUTHOR', 'HOMEPAGE', 'KEPT', 'PATH']);
        expect(hasUrlCredential('redis://:pw@cache:6379')).toBe(true);    // a password with no user name
        expect(hasUrlCredential('http://localhost:8000/v1')).toBe(false);
        expect(hasUrlCredential('mailto:a@b.c')).toBe(false);
    });
});

describe('B6. requests outside the main loop reach the metrics', () => {
    it('counts a failed attempt', async () => {
        const notes = [];
        setMetricsWriter((r) => notes.push(r));
        try {
            let n = 0;
            const r = await withRetry(async () => { if (n++ === 0) throw new Error('HTTP 503: overloaded'); return 'ok'; }, () => 0, 3);
            expect(r).toBe('ok');
            expect(notes.filter(x => x.type === 'request_failed').length).toBe(1);
            metricsNote({ type: 'worker_step', promptTokens: 5, responseTokens: 2 });
            expect(notes.at(-1)).toMatchObject({ type: 'worker_step', promptTokens: 5 });
        } finally { setMetricsWriter(null); }
    });
});

describe('B8. one table of write tools', () => {
    it('every list of write tools is built from it', async () => {
        expect([...MAY_WRITE_TOOLS]).toEqual([...WORKSPACE_WRITE_TOOLS, 'execute_code', 'deep_research']);   // deep_research saves its report under research/ (codex R122)
        expect([...WORKSPACE_WRITE_TOOLS]).toEqual([...FILE_WRITE_TOOLS, 'undo_write']);
        expect([..._WRITE_TOOLS].sort()).toEqual([...MAY_WRITE_TOOLS].sort());
        // No module keeps its own literal list of the file-write tools any more.
        for (const f of ['tools.ts', 'llm-loops.ts', 'history.ts']) {
            const src = readFileSync(join(process.cwd(), f), 'utf8');
            expect(/\[\s*'write_file',\s*'(?:append_file|replace_in_file|apply_patch)',\s*'(?:apply_patch|replace_in_file|append_file)',\s*'(?:replace_in_file|delete_file|append_file|apply_patch)',\s*'(?:delete_file|append_file)'/.test(src), f).toBe(false);
        }
    });
});

describe('B10. a worker run that changed files drops cached reads and stays cached itself', () => {
    it('runs a scripted coder that writes a file', async () => {
        const { enabledTools } = await import('../config.ts');
        const { _workersChangedFiles } = await import('../llm-loops.ts');
        const before = [...enabledTools];
        for (const t of ['write_file', 'read_file', 'list_files', 'run_workers']) enabledTools.add(t);
        const files = {};
        // The worker's writes go to the real workspace module, which stores files in IndexedDB.
        const { IDBFactory } = await import('fake-indexeddb');
        const hadIdb = 'indexedDB' in W, prevIdb = W.indexedDB;
        W.indexedDB = new IDBFactory();
        const saved = { l: W.agentListFiles, r: W.agentReadFile, w: W.agentWriteFile, d: W.agentDeleteFile, f: W.fetch };
        W.agentListFiles = async () => Object.keys(files).map(name => ({ name, size: files[name].length }));
        W.agentReadFile = async (p) => { if (!(p in files)) throw new Error(`File not found: ${p}`); return files[p]; };
        W.agentWriteFile = async (p, c) => { files[p] = c; };
        W.agentDeleteFile = async (p) => { delete files[p]; };
        localStorage.setItem('fg_main_models', JSON.stringify(['openrouter|test-model']));
        localStorage.setItem('fg_openrouter_key', 'test-key');
        const json = (message) => new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } }),
            { status: 200, headers: { 'content-type': 'application/json' } });
        let requests = 0;
        W.fetch = vi.fn(async () => ++requests === 1
            ? json({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'made.txt', content: 'new\n' }) } }] })
            : json({ role: 'assistant', content: 'Wrote made.txt.\nSTATUS: complete' }));
        try {
            const cache = new Map();
            const readKey = 'read_file|' + JSON.stringify({ path: 'a.txt' });
            cache.set(readKey, { path: 'a.txt', content: 'old\n' });
            const run = (name, args) => W._runToolCalls([{ name, args }], null, { forWorker: false, repeatCache: cache });
            const call = { agents: [{ id: 'w1', role: 'coder', task: 'Create made.txt containing the word new.' }] };
            const first = (await run('run_workers', call))[0].result;
            expect(first.applied).toEqual(['made.txt']);
            expect(cache.has(readKey)).toBe(false);
            const n = requests;
            await run('run_workers', call);
            expect(requests).toBe(n);
        } finally {
            W.agentListFiles = saved.l; W.agentReadFile = saved.r; W.agentWriteFile = saved.w; W.agentDeleteFile = saved.d; W.fetch = saved.f;
            enabledTools.clear(); for (const t of before) enabledTools.add(t);
            if (hadIdb) W.indexedDB = prevIdb; else delete W.indexedDB;
        }
    });
});
