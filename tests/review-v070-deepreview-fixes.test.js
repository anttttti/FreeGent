// Fixes from the v0.70 deep reviews, one block per finding.
import { runtime } from '../runtime.ts';
import { _appendRunnerLog } from '../runner.ts';
import { _capAnyResult, truncateResultForHistory } from '../history.ts';
import { _workerRunStatus, resolveFileConflicts, MAX_WORKERS_PER_CALL } from '../workers.ts';
import { _WRITE_TOOLS, _workersChangedFiles } from '../llm-loops.ts';
import { isTestEditProtected, _workersMayWrite } from '../tools.ts';

const W = globalThis;
await import('../tool-schemas.ts');
const { enabledTools } = await import('../config.ts');   // write tools are off by default and now also refused at dispatch

const STUBBED = ['agentListFiles', 'agentReadFile', 'agentWriteFile', 'agentDeleteFile', 'agentFileMtime', 'callLLMComplete', 'nativeExec'];
let saved, files;
beforeEach(() => {
    saved = Object.fromEntries(STUBBED.map(k => [k, W[k]]));
    files = {};
    W.agentListFiles = async () => Object.keys(files).map(name => ({ name, size: files[name].length }));
    W.agentReadFile = async (p) => { if (!(p in files)) throw new Error(`File not found: ${p}`); return files[p]; };
    W.agentWriteFile = async (p, c) => { files[p] = c; };
    W.agentDeleteFile = async (p) => { delete files[p]; };
});
afterEach(() => {
    for (const k of STUBBED) { if (saved[k] === undefined) delete W[k]; else W[k] = saved[k]; }
    delete process.env.FG_PROTECT_TESTS;
    document.getElementById('tool-approval-toast')?.remove();
    document.getElementById('runner-session-log')?.remove();
    localStorage.clear();
});

describe('F1. runner log rows are text, never HTML', () => {
    it('renders a task title, id and reason containing markup literally', () => {
        const el = document.createElement('div'); el.id = 'runner-session-log'; document.body.appendChild(el);
        const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
        _appendRunnerLog(evil, `T ${evil}`, 'failed', `R ${evil}`);
        expect(el.querySelector('img, script')).toBeNull();
        expect(el.querySelectorAll('.runner-log-entry.runner-log-fail').length).toBeGreaterThan(0);
        expect(el.querySelector('.runner-log-title').textContent).toContain(`T ${evil}`);
        expect(el.querySelector('.runner-log-reason').textContent).toContain(`R ${evil}`);
        expect(W.__pwned).toBeUndefined();
    });
});

describe('F2. the test-file edit rule is benchmark policy', () => {
    it('is off for a native run unless the runner sets FG_PROTECT_TESTS=1', async () => {
        W.nativeExec = async () => ({ stdout: '', stderr: '', exit_code: 0 });
        expect(runtime.hasNativeExec).toBe(true);
        expect(isTestEditProtected('tests/new.test.ts')).toBe(false);
        const r = await W.executeToolAsync('write_file', { path: 'tests/new.test.ts', content: 'it("x", () => {});\n' });
        expect(r.error).toBeUndefined();
        expect(files['tests/new.test.ts']).toContain('it("x"');

        process.env.FG_PROTECT_TESTS = '1';
        expect(isTestEditProtected('tests/new.test.ts')).toBe(true);
        expect(isTestEditProtected('src/app.ts')).toBe(false);
        for (const [name, args] of [
            ['write_file', { path: 'tests/b.test.ts', content: 'x' }],
            ['replace_in_file', { path: 'tests/new.test.ts', old_str: 'x', new_str: 'z' }],
        ]) expect((await W.executeToolAsync(name, args)).error, name).toMatch(/grader strips test-file changes/);
        expect(files['tests/b.test.ts']).toBeUndefined();
    });
    it('never applies in the browser, flag or not', () => {
        delete W.nativeExec;
        process.env.FG_PROTECT_TESTS = '1';
        expect(isTestEditProtected('tests/new.test.ts')).toBe(false);
    });
});

describe('R1. append_file is a write for approval and for the repeat cache', () => {
    beforeEach(() => { enabledTools.add('append_file'); });
    afterEach(() => { enabledTools.delete('append_file'); });
    it('asks under "All writes" and does not write when denied', async () => {
        files['notes.txt'] = 'first\n';
        localStorage.setItem('fg_tool_approval', 'all');
        const toast = document.createElement('div');
        toast.id = 'tool-approval-toast';
        toast.innerHTML = '<span id="tool-approval-label"></span><span id="tool-approval-detail"></span><input type="checkbox" id="tool-approval-session"><span id="tool-approval-session-name"></span>';
        document.body.appendChild(toast);
        const p = W.executeToolAsync('append_file', { path: 'notes.txt', content: 'second\n' });
        await vi.waitFor(() => expect(toast.style.display).not.toBe('none'));
        W.resolveToolApproval(false);
        expect((await p).error).toMatch(/denied/i);
        expect(files['notes.txt']).toBe('first\n');
    });
    it('a read after an append is fresh, and an identical append runs again', async () => {
        files['notes.txt'] = 'first\n';
        const cache = new Map();
        const run = (name, args) => W._runToolCalls([{ name, args }], null, { forWorker: false, repeatCache: cache });
        const before = await run('read_file', { path: 'notes.txt' });
        expect(JSON.stringify(before[0].result)).toContain('first');
        await run('append_file', { path: 'notes.txt', content: 'second\n' });
        const after = await run('read_file', { path: 'notes.txt' });
        expect(JSON.stringify(after[0].result)).toContain('second');
        await run('append_file', { path: 'notes.txt', content: 'second\n' });
        expect(files['notes.txt'].match(/second/g).length).toBe(2);
    });
    it('every tool that writes workspace files is in the cache-invalidation set', () => {
        for (const t of ['write_file', 'append_file', 'apply_patch', 'replace_in_file', 'delete_file', 'undo_write', 'execute_code'])
            expect(_WRITE_TOOLS.has(t), t).toBe(true);
    });
    it('a worker run that changed no file keeps cached reads, and an identical delegation stays cached', async () => {
        expect(_workersChangedFiles({ agents: [{ id: 'r', status: 'complete', wrote: [] }], applied: [], conflictsResolved: [] })).toBe(false);
        expect(_workersChangedFiles({ applied: ['a.txt'] })).toBe(true);
        expect(_workersChangedFiles({ applied: [], conflictsNotMerged: { 'a.txt': 'kept w1' } })).toBe(true);
        expect(_workersChangedFiles({ error: 'x' })).toBe(false);

        // A real worker run against a scripted model: one write_file call, then the status footer.
        localStorage.setItem('fg_main_models', JSON.stringify(['openrouter|test-model']));
        localStorage.setItem('fg_openrouter_key', 'test-key');
        const origFetch = W.fetch;
        const json = (message) => new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } }),
            { status: 200, headers: { 'content-type': 'application/json' } });
        let requests = 0;
        W.fetch = vi.fn(async () => ++requests === 1
            ? json({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'made.txt', content: 'new\n' }) } }] })
            : json({ role: 'assistant', content: 'Wrote made.txt.\nSTATUS: complete' }));
        try {
            const cache = new Map();
            const readKey = 'read_file|' + JSON.stringify({ path: 'a.txt' });
            cache.set(readKey, { path: 'a.txt', content: 'old\n' });                 // a read made before the delegation
            const run = (name, args) => W._runToolCalls([{ name, args }], null, { forWorker: false, repeatCache: cache });
            const call = { agents: [{ id: 'w1', role: 'director', task: 'Create made.txt containing the word new.' }] };
            // In this test environment the scripted worker's write is not staged, so the run changes no
            // file: the cached read must survive it. (The changed-files side is covered by the predicate above.)
            const first = (await run('run_workers', call))[0].result;
            expect(first.status).toBe('complete');
            expect(_workersChangedFiles(first)).toBe(false);
            expect(cache.has(readKey)).toBe(true);
            const before = requests;
            await run('run_workers', call);                                          // identical delegation: from the cache
            expect(requests).toBe(before);
        } finally { W.fetch = origFetch; }
    });
    it('"All writes" asks for a delegation only when a worker can edit files', () => {
        expect(_workersMayWrite({ agents: [{ id: 'r', role: 'researcher', task: 't' }] })).toBe(false);
        expect(_workersMayWrite({ agents: [{ id: 'r', role: 'researcher', task: 't' }, { id: 'c', role: 'coder', task: 't' }] })).toBe(true);
        expect(_workersMayWrite({ agents: [{ id: 'd', task: 't' }] })).toBe(true);            // no role: runs as director
        expect(_workersMayWrite({ agents: [{ id: 'x', role: 'made-up', task: 't' }] })).toBe(true);
        expect(_workersMayWrite({ agents: 'not json' })).toBe(true);
    });
});

describe('F8. run_workers has a worker limit', () => {
    it('refuses more than the limit without starting any, and the schema states it', async () => {
        const agents = Array.from({ length: MAX_WORKERS_PER_CALL + 1 }, (_, i) => ({ id: `w${i}`, role: 'researcher', task: `task number ${i}` }));
        W.callLLMComplete = vi.fn();
        const r = await W.executeWorkers({ agents });
        expect(r.error).toMatch(new RegExp(`limit is ${MAX_WORKERS_PER_CALL}`));
        expect(W.callLLMComplete).not.toHaveBeenCalled();
        const spec = W.activeTools(false).find(t => t.name === 'run_workers');
        if (spec) expect(spec.parameters.properties.agents.maxItems).toBe(MAX_WORKERS_PER_CALL);
    });
});

describe('R5. a run with partial workers is not complete', () => {
    it('derives the run status from every worker and from unmerged files', () => {
        expect(_workerRunStatus(['complete', 'complete'])).toBe('complete');
        expect(_workerRunStatus(['partial'])).toBe('partial');
        expect(_workerRunStatus(['complete', 'Partial'])).toBe('partial');
        expect(_workerRunStatus(['complete', 'blocked'])).toBe('partial');
        expect(_workerRunStatus(['blocked', 'blocked'])).toBe('blocked');
        expect(_workerRunStatus(['complete', 'complete'], 1)).toBe('partial');
    });
});

describe('R8. a failed merge is reported, not counted as resolved', () => {
    const base = 'line one\nline two\nline three\n';
    const versions = { w1: 'line ONE\nline two\nline three\n', w2: 'line 1 (longer edit)\nline two\nline three\n', w3: 'x\nline two\nline three\n' };
    it('names the worker whose version was kept when the model returns no merge', async () => {
        const r = await resolveFileConflicts({ 'a.txt': versions }, new Map([['a.txt', base]]), null, vi.fn().mockResolvedValue('{}'));
        expect(r.picked).toEqual({ 'a.txt': 'w2' });
        expect(r.resolved['a.txt']).toBe(versions.w2);
        expect(r.stats).toMatchObject({ llm: 0, picked: 1 });
        expect(r.unresolved).toEqual([]);
    });
    it('keeps the clean merges and reports the rest when the merge request fails', async () => {
        const clean = { w1: 'A\nb\nc\nd\ne\n', w2: 'a\nb\nc\nd\nE\n' };
        const r = await resolveFileConflicts({ 'a.txt': versions, 'b.txt': clean }, new Map([['a.txt', base], ['b.txt', 'a\nb\nc\nd\ne\n']]), null, vi.fn().mockRejectedValue(new Error('HTTP 500')));
        expect(r.resolved['b.txt']).toBe('A\nb\nc\nd\nE\n');
        expect(r.resolved['a.txt']).toBeUndefined();
        expect(r.unresolved).toEqual(['a.txt']);
    });
});

describe('default history cap', () => {
    it('bounds a result from a tool with no truncation case, and execute_code stderr when stdout was cut', () => {
        localStorage.setItem('fg_agent_max_tool_result', '2000');
        const big = truncateResultForHistory('context7_docs', { library: 'x', docs: 'd'.repeat(50_000), meta: { note: 'n'.repeat(20_000) } });
        expect(JSON.stringify(big).length).toBeLessThanOrEqual(2200);
        const small = { ok: true, text: 'short' };
        expect(truncateResultForHistory('context7_docs', small)).toBe(small);
        const ex = truncateResultForHistory('execute_code', { stdout: 'o'.repeat(9000), stderr: 'e'.repeat(9000), exit_code: 1 });
        expect(ex.stdout.length).toBeLessThan(2100);
        expect(ex.stderr.length).toBeLessThan(2100);
        const many = _capAnyResult({ items: Array.from({ length: 500 }, (_, i) => `item ${i}`) }, 300);
        expect(many.truncated).toBe(true);
        expect(JSON.stringify(many).length).toBeLessThan(450);
    });
});

describe('checkpoint cleanup', () => {
    it('purges snapshots of deleted chats, but nothing when the chat list is empty', async () => {
        const { IDBFactory, IDBKeyRange } = await import('fake-indexeddb');
        const hadIdb = 'indexedDB' in W, prevIdb = W.indexedDB;
        W.indexedDB = new IDBFactory();
        W.IDBKeyRange = IDBKeyRange;
        try {
        await import('../workspace.ts');
        files['a.txt'] = 'A';
        await W.saveCheckpointSnapshot('chat-kept', 'c1');
        await W.saveCheckpointSnapshot('chat-gone', 'c1');
        const has = async (chat) => (await W.getCheckpointDiff(chat, 'c1')) != null;
        expect(await has('chat-kept')).toBe(true);
        expect(await has('chat-gone')).toBe(true);
        await W.cleanupDanglingCheckpoints([]);                 // chat list not loaded: no purge
        expect(await has('chat-kept')).toBe(true);
        expect(await has('chat-gone')).toBe(true);
        await W.cleanupDanglingCheckpoints(['chat-kept']);
        expect(await has('chat-kept')).toBe(true);
        expect(await has('chat-gone')).toBe(false);
        } finally { if (hadIdb) W.indexedDB = prevIdb; else delete W.indexedDB; }
    });
});

describe('F5/R6. how a turn ended is recorded as data', () => {
    const lastTurnEnd = (session) => {
        const log = (session._session ?? session).events ?? (session._session ?? session).log ?? [];
        return [...log].reverse().find(e => e.type === 'turn/end');
    };
    beforeEach(async () => {
        await import('../llm-loops.ts'); await import('../agent-core.ts'); await import('../chat-state.ts');
        W.mainAgentRole = null;
        W.setSoftStopPending?.(false);
        W.addVoiceButtons ??= () => {};
        localStorage.setItem('fg_primary_models', JSON.stringify(['openrouter|test-model']));
        localStorage.setItem('fg_openrouter_key', 'test-key');
    });
    it('the turn/end event carries finish, so a blocked turn is not logged as a plain completion', async () => {
        const origFetch = W.fetch;
        const reply = (content) => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } }),
            { status: 200, headers: { 'content-type': 'application/json' } });
        try {
            W.fetch = vi.fn(async () => reply('BLOCKED: the credentials for the service are missing and cannot be obtained.'));
            const s1 = W.createSession({ workflowMode: true });
            const r1 = await W.runAgentTurn('Deploy the service to production now.', null, s1);
            const e1 = lastTurnEnd(s1);
            expect(e1?.data?.reason?.kind).toBe('completed');          // lifecycle: the turn returned
            expect(e1?.data?.finish).toBe(r1.finishSignal);            // semantics: same as the TurnResult
            expect(r1.finishSignal).toBe('blocked');                   // a declared BLOCKED used to read 'complete'

            W.fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'The model `test-model` does not exist.' } }),
                { status: 404, headers: { 'content-type': 'application/json' } }));
            const s2 = W.createSession({ workflowMode: true });
            const r2 = await W.runAgentTurn('Do the task.', null, s2);
            expect(r2.finishSignal).toBe('error');
            expect(lastTurnEnd(s2)?.data?.finish).toBe('error');
        } finally { W.fetch = origFetch; }
    });
    it('a finished report with a line starting "BLOCKED:" is still complete', async () => {
        const origFetch = W.fetch;
        try {
            W.fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Status of the three items:\nDONE: 2 migrated\nBLOCKED: 1 waiting for a vendor reply, noted in the tracker\n\nCOMPLETED' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } }),
                { status: 200, headers: { 'content-type': 'application/json' } }));
            const r = await W.runAgentTurn('Summarise the status of the three migration items.', null, W.createSession({ workflowMode: true }));
            expect(r.finishSignal).toBe('complete');
        } finally { W.fetch = origFetch; }
    });
    it('the director loop names why it gave up when continuations run out', async () => {
        const { directorLoop } = await import('../loop-director.ts');
        const running = { text: 'still working', finishSignal: 'running', usage: {}, steps: [] };
        const res = await directorLoop(vi.fn(async () => running), W.createSession({ workflowMode: true }), 'task', { maxContinuations: 1 });
        expect(res.finishSignal).toBe('blocked');
        expect(res.stop?.reason).toBe('reached max continuations');
    });
});

describe('F3. the event log survives write failures and torn lines', () => {
    let dir, fsp, path, SessionPersistence;
    const ev = (seq, type = 'x') => ({ seq, type, data: { n: seq } });
    beforeEach(async () => {
        fsp = await import('node:fs/promises'); path = await import('node:path');
        ({ SessionPersistence } = await import('../session-persistence.ts'));
        dir = await fsp.mkdtemp(path.join((await import('node:os')).tmpdir(), 'fg-persist-'));
    });
    afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

    it('keeps the events before a torn final line', async () => {
        await fsp.writeFile(path.join(dir, 's.jsonl'), [ev(0), ev(1)].map(e => JSON.stringify(e)).join('\n') + '\n{"seq":2,"type":"x","da');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect((await new SessionPersistence(dir).load('s')).map(e => e.seq)).toEqual([0, 1]);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
    it('skips a fragment and repeated events in the middle, and stops counting at a gap', async () => {
        const L = (e) => JSON.stringify(e);
        await fsp.writeFile(path.join(dir, 's.jsonl'), [L(ev(0)), L(ev(1)), '{"seq":2,"ty', L(ev(1)), L(ev(2)), L(ev(3)), L(ev(5))].join('\n') + '\n');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect((await new SessionPersistence(dir).load('s')).map(e => e.seq)).toEqual([0, 1, 2, 3]);
        warn.mockRestore();
    });
    it('returns [] for a missing file and throws for an unreadable one', async () => {
        const p = new SessionPersistence(dir);
        expect(await p.load('nope')).toEqual([]);
        await fsp.mkdir(path.join(dir, 'isdir.jsonl'));
        await expect(p.load('isdir')).rejects.toThrow();
    });
    it('a failed append keeps the batch, and the retry writes every event once in order', async () => {
        const p = new SessionPersistence(path.join(dir, 'blocked', 'log'), 60_000);
        await fsp.writeFile(path.join(dir, 'blocked'), 'a file where the directory should be');
        p.enqueue('a', ev(0)); p.enqueue('a', ev(1)); p.enqueue('b', ev(0));
        await expect(p.flush()).rejects.toThrow();
        expect(p.pendingCount()).toBe(3);
        p.enqueue('a', ev(2));                                   // arrives between the failure and the retry
        await fsp.rm(path.join(dir, 'blocked'));
        await p.flush();
        expect(p.pendingCount()).toBe(0);
        expect((await p.load('a')).map(e => e.seq)).toEqual([0, 1, 2]);
        expect((await p.load('b')).map(e => e.seq)).toEqual([0]);
    });
    it('a batch that half reached the file is recovered without loss or repeats', async () => {
        const p = new SessionPersistence(dir, 60_000);
        p.enqueue('s', ev(0)); await p.flush();
        // Simulate a failed append that wrote event 1 and a fragment of event 2 before erroring.
        await fsp.appendFile(path.join(dir, 's.jsonl'), JSON.stringify(ev(1)) + '\n{"seq":2,"type"');
        p.dirty.add('s');
        p.enqueue('s', ev(1)); p.enqueue('s', ev(2));           // the batch is written again in full
        await p.flush();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect((await p.load('s')).map(e => e.seq)).toEqual([0, 1, 2]);
        warn.mockRestore();
    });
    it('events enqueued during a drain are written by the same flush', async () => {
        const p = new SessionPersistence(dir, 60_000);
        p.enqueue('s', ev(0));
        const f = p.flush();
        p.enqueue('s', ev(1));
        await f; await p.flush();
        expect((await p.load('s')).map(e => e.seq)).toEqual([0, 1]);
    });
});

describe('R9. calls in one response run in order when one of them changes state', () => {
    beforeEach(() => { enabledTools.add('write_file'); });
    afterEach(() => { enabledTools.delete('write_file'); });
    it('a read listed after a write sees the write; reads alone still run together', async () => {
        files['n.txt'] = 'one\n';
        const origWrite = W.agentWriteFile;
        W.agentWriteFile = async (p, c) => { await new Promise(r => setTimeout(r, 40)); files[p] = c; };   // a slow write
        try {
            const r = await W._runToolCalls([
                { name: 'write_file', args: { path: 'n.txt', content: 'two\n' } },
                { name: 'read_file', args: { path: 'n.txt' } },
            ], null, { forWorker: false });
            expect(JSON.stringify(r[1].result)).toContain('two');
        } finally { W.agentWriteFile = origWrite; }
        const { _isReadOnlyCall } = await import('../llm-loops.ts');
        expect(_isReadOnlyCall({ name: 'read_file', args: {} })).toBe(true);
        expect(_isReadOnlyCall({ name: 'fetch_url', args: { url: 'https://x.example.com' } })).toBe(true);
        expect(_isReadOnlyCall({ name: 'fetch_url', args: { url: 'https://x.example.com', method: 'POST' } })).toBe(false);
        expect(_isReadOnlyCall({ name: 'execute_code', args: {} })).toBe(false);
        expect(_isReadOnlyCall({ name: 'mcp__srv__anything', args: {} })).toBe(false);
    });
});

describe('skill `requires` frontmatter', () => {
    it('keeps a skill off unless its setting is true', async () => {
        const { _skillRequiresUnmet } = await import('../skill-guidance.ts');
        expect(_skillRequiresUnmet({ name: 'a' })).toBe(false);
        expect(_skillRequiresUnmet({ name: 'a', requires: 'fg_some_flag' })).toBe(true);
        localStorage.setItem('fg_some_flag', 'true');
        expect(_skillRequiresUnmet({ name: 'a', requires: 'fg_some_flag' })).toBe(false);
        localStorage.setItem('fg_some_flag', 'false');
        expect(_skillRequiresUnmet({ name: 'a', requires: 'fg_some_flag' })).toBe(true);
    });
});

describe('custom endpoint: a rejected request is not retried forever', () => {
    it('gives up after a few identical client errors, but keeps retrying server errors', async () => {
        const { _makeOAIRetryHandler, CUSTOM_CLIENT_ERROR_ATTEMPTS } = await import('../retry.ts');
        const ep = { provider: 'custom', model: 'local-model', url: 'http://localhost:8000/v1' };
        const mk = () => _makeOAIRetryHandler({ getEp: () => ep, setEp: () => {}, onNote: () => {}, forWorker: true });
        const bad = new Error('[custom] HTTP 400: Unknown parameter: "foo"');
        const h = mk();
        const answers = Array.from({ length: CUSTOM_CLIENT_ERROR_ATTEMPTS }, (_, i) => h(i, bad, 1500));
        expect(answers.slice(0, -1).every(a => a !== false)).toBe(true);
        expect(answers.at(-1)).toBe(false);
        const h2 = mk();
        const oom = new Error('[custom] HTTP 500: CUDA out of memory');
        for (let i = 0; i < 10; i++) expect(h2(i, oom, 1500)).not.toBe(false);
    });
});

describe('R2. fetch_url: data after "#" and responses marked no-store', () => {
    it('sends a "#" inside a JSON query value, and leaves ordinary anchors alone', async () => {
        const { _encodeDataHash } = await import('../tools.ts');
        expect(_encodeDataHash('http://h/execute?tool=t&params={"color":"#ffffff","row":2}'))
            .toBe('http://h/execute?tool=t&params={"color":"%23ffffff","row":2}');
        expect(_encodeDataHash('http://h/execute?tool=t&params=%7B%22c%22:%22#fff%22%7D')).toBe('http://h/execute?tool=t&params=%7B%22c%22:%22%23fff%22%7D');
        for (const u of ['https://x.example.com/page?id=3#tab=2', 'https://x.example.com/docs#install', 'https://x.example.com/a?q=1', 'https://x.example.com/#/route?x=1'])
            expect(_encodeDataHash(u)).toBe(u);
    });
    it('a GET whose response says no-store makes earlier cached reads stale, like a POST', async () => {
        const origFetch = W.fetch;
        let rows = 1; const seen = [];
        W.fetch = vi.fn(async (url) => {
            const u = String(url); seen.push(u);
            const isUpdate = u.includes('tool=update_row');
            if (isUpdate) rows++;
            return new Response(JSON.stringify({ result: { rows } }), { status: 200, headers: { 'content-type': 'application/json', ...(u.includes('/execute') ? { 'cache-control': 'no-store' } : {}) } });
        });
        try {
            const cache = new Map();
            const run = (url) => W._runToolCalls([{ name: 'fetch_url', args: { url } }], null, { forWorker: false, repeatCache: cache });
            const read = 'https://api.example.com/api/execute?tool=get_rows', write = 'https://api.example.com/api/execute?tool=update_row';   // /api/: fetched directly, not through the page proxy
            expect(JSON.stringify((await run(read))[0].result)).toContain('"rows":1');
            await run(write);
            await run(write);                                                    // identical repeat: not sent twice
            expect(seen.filter(u => u.includes('update_row')).length).toBe(1);
            expect(JSON.stringify((await run(read))[0].result)).toContain('"rows":2');   // fresh, not the cached 1
        } finally { W.fetch = origFetch; }
    });
});

describe('inline handler arguments', () => {
    it('jsArg gives a string literal that survives HTML attribute parsing unchanged', async () => {
        const { jsArg } = await import('../html-escape.ts');
        for (const v of ['openrouter|a/b:free', `x"onmouseover="alert(1)`, `a'b\\c`, '</div><img src=x onerror=alert(1)>', 'line\nbreak']) {
            const host = document.createElement('div');
            host.innerHTML = `<button onclick="window.__got = ${jsArg(v)}">x</button>`;
            expect(host.children.length).toBe(1);
            const btn = host.querySelector('button');
            expect(btn.getAttributeNames()).toEqual(['onclick']);
            // The attribute's decoded text is `window.__got = <a JSON string literal of v>`.
            expect(JSON.parse(btn.getAttribute('onclick').replace('window.__got = ', ''))).toBe(v);
        }
    });
});

describe('F4. a worker run does not change what its siblings see as the original file', () => {
    it('pins the run-start content before a staged edit is written for a code run', async () => {
        const { nativeExec: _n } = W;
        files['m.py'] = 'original\n';
        // Worker A has staged an edit and runs code; nothing has read m.py through the snapshot yet.
        const pinned = new Map();
        const pinSnap = { get: async (name) => { if (!pinned.has(name)) pinned.set(name, files[name]); return pinned.get(name); } };
        W.nativeExec = async () => ({ stdout: '', stderr: '', exit_code: 0 });
        try {
            await W.executeToolAsync('execute_code', { language: 'bash', code: 'true' },
                { snapshot: pinSnap, staging: new Map([['m.py', 'edited by A\n']]), binary: new Map(), depth: 1 });
        } finally { if (_n === undefined) delete W.nativeExec; else W.nativeExec = _n; }
        expect(files['m.py']).toBe('edited by A\n');          // the live file now holds A's edit
        expect(await pinSnap.get('m.py')).toBe('original\n'); // a sibling's first read still gets the original
    });
});

describe('event log growth is bounded', () => {
    let dir, fsp, path, SessionPersistence;
    beforeEach(async () => {
        fsp = await import('node:fs/promises'); path = await import('node:path');
        ({ SessionPersistence } = await import('../session-persistence.ts'));
        dir = await fsp.mkdtemp(path.join((await import('node:os')).tmpdir(), 'fg-persist-'));
    });
    afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });
    const ev = (seq, content = 'x') => ({ seq, type: 'tool/result', time: 0, data: { content } });

    it('cuts long fields on disk and marks the event', async () => {
        const p = new SessionPersistence(dir, 60_000, { maxFieldChars: 100 });
        p.enqueue('s', ev(0, 'a'.repeat(5000))); p.enqueue('s', ev(1));
        await p.flush();
        const [a, b] = await p.load('s');
        expect(a.truncated).toBe(true);
        expect(a.data.content.length).toBeLessThan(200);
        expect(a.data.content).toContain('4900 more chars');
        expect(b.truncated).toBeUndefined();
    });
    it('stops writing a session at the file cap and keeps what was written', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const p = new SessionPersistence(dir, 60_000, { maxFileBytes: 400 });
        for (let i = 0; i < 3; i++) { p.enqueue('s', ev(i, 'y'.repeat(60))); await p.flush(); }
        for (let i = 3; i < 10; i++) { p.enqueue('s', ev(i, 'y'.repeat(60))); await p.flush(); }
        const loaded = await p.load('s');
        expect(loaded.length).toBeGreaterThan(0);
        expect(loaded.length).toBeLessThan(10);
        expect(loaded.map(e => e.seq)).toEqual([...loaded.keys()]);
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });
    it('prunes files by age, then oldest first down to the size budget', async () => {
        const w = async (n, bytes, ageDays) => {
            const f = path.join(dir, n + '.jsonl'); await fsp.writeFile(f, 'z'.repeat(bytes));
            const t = new Date(Date.now() - ageDays * 86_400_000); await fsp.utimes(f, t, t);
        };
        await w('old', 10, 40); await w('mid', 100, 3); await w('new', 100, 1); await fsp.writeFile(path.join(dir, 'keep.txt'), 'k'.repeat(999));
        expect(await SessionPersistence.prune(dir, { maxAgeDays: 30, maxTotalBytes: 150 })).toBe(2);
        const left = (await fsp.readdir(dir)).sort();
        expect(left).toEqual(['keep.txt', 'new.jsonl']);
    });
});
