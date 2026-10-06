// Regression tests for the v0.62 code review findings (notes/2026_10_06_v0.62_codex_codereview.md).
const W = globalThis;
await import('../post-turn.ts');
await import('../tasks.ts');

const STUBBED = ['agentListFiles', 'agentReadFile', 'agentWriteFile', 'agentDeleteFile', 'callLLMComplete',
    'executeToolAsync', 'createEditor', 'refreshTasks'];
let saved, files;

beforeEach(() => {
    saved = Object.fromEntries(STUBBED.map(k => [k, W[k]]));
    files = {};
    W.agentListFiles = async () => Object.keys(files).map(name => ({ name }));
    W.agentReadFile = async (p) => { if (!(p in files)) throw new Error(`nf ${p}`); return files[p]; };
    W.agentWriteFile = async (p, c) => { files[p] = c; };
    W.agentDeleteFile = async (p) => { delete files[p]; };
});
afterEach(() => { for (const k of STUBBED) W[k] = saved[k]; localStorage.clear(); });

const task = (extra = '', status = 'in-progress') =>
    `---\nid: 001\ntitle: T\nstatus: ${status}\n---\n# T\n${extra}`;

describe('R01 task preview renders the path as text', () => {
    it('does not parse a hostile file name or error message as HTML', async () => {
        const path = 'fg-tasks/001-<img src=x onerror="window.__marker=1">.md';
        files[path] = '---\nid: 001\ntitle: T\nstatus: open\n---\n';
        document.body.innerHTML = '<div id="col-todo"></div><div id="col-in-progress"></div><div id="col-review"></div><div id="col-done"></div><div id="task-preview"></div>';
        W.createEditor = async () => { throw new Error('boom <img src=x onerror="window.__marker=2">'); };
        await W.refreshTasks();
        document.querySelector('.kanban-card').click();
        await vi.waitFor(() => expect(document.querySelector('.workspace-empty')).toBeTruthy());
        expect(document.querySelector('#task-preview img')).toBeNull();
        expect(document.querySelector('.task-preview-name').textContent).toBe(path);
        expect(document.querySelector('.workspace-empty').textContent).toContain('<img');
    });
});

describe('R16 board counts follow the column a status is shown in', () => {
    it('counts open, blocked, in-review and completed cards in their columns', async () => {
        document.body.innerHTML = ['todo', 'in-progress', 'review', 'done'].map(c =>
            `<div class="kanban-col" data-status="${c}"><span class="kanban-col-count"></span><div id="col-${c}"></div></div>`).join('');
        W.parseFrontmatter = (c) => Object.fromEntries((c.match(/^---\n([\s\S]*?)\n---/) ?? [, ''])[1].split('\n').filter(Boolean).map(l => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
        const mk = (n, s) => { files[`fg-tasks/00${n}-t.md`] = `---\nid: 00${n}\ntitle: T${n}\nstatus: ${s}\n---\n`; };
        mk(1, 'open'); mk(2, 'blocked'); mk(3, 'in-review'); mk(4, 'review'); mk(5, 'completed'); mk(6, 'in-progress');
        await W.refreshTasks();
        const count = c => document.querySelector(`[data-status="${c}"] .kanban-col-count`).textContent;
        expect([count('todo'), count('in-progress'), count('review'), count('done')]).toEqual(['2', '1', '2', '1']);
    });
});

describe('lifecycle gates', () => {
    beforeEach(() => {
        localStorage.setItem('fg_qa_enabled', 'true');
        localStorage.setItem('fg_qa_test_runner', 'false');
        localStorage.setItem('fg_qa_acceptance_review', 'true');
        W.refreshTasks = async () => {};
    });

    it('R10 the "review" spelling goes through the in-review gates', async () => {
        files['fg-tasks/001-t.md'] = task('- [ ] unfinished step\n');
        const r = await W.transitionTask('fg-tasks/001-t.md', 'review');
        expect(r.transitioned).toBe(false);
        expect(r.reason).toMatch(/Plan incomplete/);
        // and a file that already says "review" is gated on the way to done
        files['fg-tasks/002-t.md'] = task('## Acceptance\n- a\n', 'review');
        W.callLLMComplete = vi.fn().mockResolvedValue('- ✗ a — no\nVERDICT: FAIL');
        const r2 = await W.transitionTask('fg-tasks/002-t.md', 'done');
        expect(W.callLLMComplete).toHaveBeenCalled();
        expect(r2.transitioned).toBe(false);
    });

    it('R11 files and criteria after the first line are all seen', async () => {
        files['good.js'] = 'ok\n';
        files['bad.js'] = '// TODO finish\n';
        files['fg-tasks/001-t.md'] = task('## Files\n\n- `good.js`\n- `bad.js`\n## Acceptance\n- first\n- second\n');
        const r = await W.transitionTask('fg-tasks/001-t.md', 'in-review');
        expect(r.reason).toMatch(/TODO\/FIXME in bad\.js/);
        files['fg-tasks/001-t.md'] = task('## Acceptance\r\n- first\r\n- second', 'in-review');
        W.callLLMComplete = vi.fn().mockResolvedValue('- ✓ first\n- ✓ second\nVERDICT: PASS');
        await W.transitionTask('fg-tasks/001-t.md', 'done');
        const prompt = W.callLLMComplete.mock.calls[0][0];
        expect(prompt).toContain('- first');
        expect(prompt).toContain('- second');
    });

    it('R12 a task created in the UI (## Acceptance Criteria) is acceptance-reviewed', async () => {
        files['fg-tasks/001-t.md'] = task('## Acceptance Criteria\n- [x] requirement\n', 'in-review');
        W.callLLMComplete = vi.fn().mockResolvedValue('- ✓ requirement\nVERDICT: PASS');
        const r = await W.transitionTask('fg-tasks/001-t.md', 'done');
        expect(W.callLLMComplete).toHaveBeenCalledTimes(1);
        expect(r.transitioned).toBe(true);
    });

    it('R21 an acceptance review without a PASS verdict does not pass', async () => {
        files['fg-tasks/001-t.md'] = task('## Acceptance\n- a\n', 'in-review');
        W.callLLMComplete = vi.fn().mockResolvedValue('I cannot verify this criterion.');
        const r = await W.transitionTask('fg-tasks/001-t.md', 'done');
        expect(r.transitioned).toBe(false);
        expect(r.reason).toMatch(/no VERDICT: PASS/);
        expect(W.callLLMComplete).toHaveBeenCalledTimes(2);   // one retry for a reply with no verdict
        W.callLLMComplete = vi.fn().mockResolvedValue('- ? a\nVERDICT: PASS');
        expect((await W.transitionTask('fg-tasks/001-t.md', 'done')).transitioned).toBe(false);
        W.callLLMComplete = vi.fn().mockRejectedValue(new Error('offline'));
        expect((await W.transitionTask('fg-tasks/001-t.md', 'done')).transitioned).toBe(false);
    });

    it('R22 failure notes survive the rework-count update', async () => {
        files['fg-tasks/001-t.md'] = task('## Acceptance\n- a\n', 'in-review');
        W.callLLMComplete = vi.fn().mockResolvedValue('- ✗ a — missing\nVERDICT: FAIL');
        await W.transitionTask('fg-tasks/001-t.md', 'done');
        expect(files['fg-tasks/001-t.md']).toContain('rework_count: 1');
        expect(files['fg-tasks/001-t.md']).toContain('## QA: Acceptance Review');
        expect(files['fg-tasks/001-t.md']).toContain('## Gate: acceptance-review FAILED');
    });

    it('R13 a failing test run fails the gate even though its output is tailed', async () => {
        localStorage.setItem('fg_qa_test_runner', 'true');
        localStorage.setItem('fg_qa_acceptance_review', 'false');
        files['src.js'] = 'x\n';
        files['src.test.js'] = 'y\n';
        files['package.json'] = '{"scripts":{"test":"exit 7"}}';
        files['fg-tasks/001-t.md'] = task('## Files\n- `src.js`\n', 'in-review');
        let cmd = '';
        W.executeToolAsync = async (_n, a) => {
            cmd = a.code;
            const { spawnSync } = await import('node:child_process');
            const r = spawnSync('bash', ['-c', a.code.replace('npm test', 'bash -c "exit 7"')], { encoding: 'utf8' });
            return { exit_code: r.status, stdout: r.stdout, stderr: r.stderr };
        };
        const r = await W.transitionTask('fg-tasks/001-t.md', 'done');
        expect(cmd).toContain('tail');
        expect(r.transitioned).toBe(false);
    });
});

// ── Tool dispatch, staging and the syntax check ──────────────────────────────

describe('R06 worker tool ceiling is enforced at dispatch', () => {
    it('refuses a known tool the worker was not offered, including through an alias', async () => {
        const ctx = { snapshot: new Map(), staging: new Map(), binary: new Map(), allowedTools: new Set(['read_file']) };
        const r = await W.executeToolAsync('write_file', { path: 'forbidden.txt', content: 'x' }, ctx);
        expect(r.error).toMatch(/not available to this worker/);
        expect(ctx.staging.size).toBe(0);
        const alias = await W.executeToolAsync('bash', { command: 'touch x' }, ctx);   // alias of execute_code
        expect(alias.error).toMatch(/not available to this worker/);
    });
});

describe('R08 binary write_file from a worker is staged, not applied', () => {
    it('keeps the content in the worker context and leaves the workspace alone', async () => {
        const ctx = { snapshot: new Map(), staging: new Map(), binary: new Map() };
        const writes = [];
        W.agentWriteFile = async (...a) => { writes.push(a); };
        const r = await W.executeToolAsync('write_file', { path: 'asset.bin', content: 'AAEC', encoding: 'base64' }, ctx);
        expect(r.success).toBe(true);
        expect(ctx.binary.get('asset.bin')).toBe('AAEC');
        expect(writes).toEqual([]);
    });
});

describe('R05 syntax checks do not run file names as shell code', () => {
    it('passes $() in a file name through as data and checks valid Python', async () => {
        const { mkdtempSync, writeFileSync, existsSync } = await import('node:fs');
        const { spawnSync } = await import('node:child_process');
        const { join } = await import('node:path');
        const { tmpdir } = await import('node:os');
        const dir = mkdtempSync(join(tmpdir(), 'fg-syn-'));
        const savedNative = W.nativeExec;
        const state = await import('../state.ts');
        const savedRole = state.mainAgentRole;
        state.setMainAgentRole({ name: 'test', tools: null });   // the default test role has no write tools
        W.nativeExec = async (_lang, code) => {
            const r = spawnSync('bash', ['-c', code], { cwd: dir, encoding: 'utf8' });
            return { exit_code: r.status, stdout: r.stdout, stderr: r.stderr };
        };
        W.agentWriteFile = async (p, c) => writeFileSync(join(dir, p), c);
        W.agentReadFile = async () => { throw new Error('nf'); };
        try {
            const evil = await W.executeToolAsync('write_file', { path: 'check$(touch MARK).js', content: 'x = 1;\n' });
            expect(existsSync(join(dir, 'MARK'))).toBe(false);
            expect(evil.syntax_error).toBeUndefined();
            const good = await W.executeToolAsync('write_file', { path: 'ok.py', content: 'x = 1\nprint(x)\n' });
            expect(good.syntax_error).toBeUndefined();
            const bad = await W.executeToolAsync('write_file', { path: 'bad.py', content: 'def f(:\n' });
            expect(bad.syntax_error).toMatch(/SyntaxError/);
            const dash = await W.executeToolAsync('write_file', { path: '-bad.js', content: 'x = ;\n' });
            expect(dash.syntax_error).toMatch(/SyntaxError/);
        } finally { W.nativeExec = savedNative; state.setMainAgentRole(savedRole); }
    });
});

// ── Project import ───────────────────────────────────────────────────────────

describe('R02/R03 project import accepts chat data only', () => {
    it('ignores settings keys and HTML snapshots from the file', async () => {
        await import('fake-indexeddb/auto');
        W.loadAgentsContext = () => {};
        W.loadSkills = () => {};
        W.confirm = () => true;
        W.alert = (m) => { throw new Error(m); };
        const data = { fwproject: '1.0', name: 'p', workspace: [], chatData: {
            fg_role_body_fn_agent: "function(){ globalThis.__marker=42; return 'x'; }",
            fg_chat_c1_msgs: '<img src=x onerror="window.__marker=9">',
            fg_chat_c1_oh: '[]',
            fg_chat_list: JSON.stringify([{ id: 'c1', name: 'x', createdAt: 1, lastAt: 1 }]),
            fg_active_chat: 'c1',
        } };
        const input = { files: [{ name: 'p.fwproject', text: async () => JSON.stringify(data) }], value: 'x' };
        await W.importProject(input);
        expect(localStorage.getItem('fg_role_body_fn_agent')).toBeNull();
        expect(localStorage.getItem('fg_chat_c1_msgs')).toBeNull();
        expect(localStorage.getItem('fg_active_chat')).toBe('c1');
    });
});

describe('R07 workers running code do not see each other\'s staged files', () => {
    it('serializes apply → run → collect', async () => {
        const { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } = await import('node:fs');
        const { spawnSync } = await import('node:child_process');
        const { join } = await import('node:path');
        const { tmpdir } = await import('node:os');
        const dir = mkdtempSync(join(tmpdir(), 'fg-run-'));
        const state = await import('../state.ts');
        const savedRole = state.mainAgentRole;
        state.setMainAgentRole({ name: 'test', tools: null });
        const savedNative = W.nativeExec;
        W.nativeExec = async (_l, code) => {
            await new Promise(r => setTimeout(r, 40));            // time for the other worker to stage over us
            const r = spawnSync('bash', ['-c', code], { cwd: dir, encoding: 'utf8' });
            return { exit_code: r.status, stdout: r.stdout, stderr: r.stderr };
        };
        W.agentWriteFile = async (p, c) => writeFileSync(join(dir, p), c);
        W.agentReadFile = async (p) => readFileSync(join(dir, p), 'utf8');
        W.agentDeleteFile = async () => {};
        W.agentListFiles = async () => readdirSync(dir).map(name => ({ name, size: statSync(join(dir, name)).size, lastModified: statSync(join(dir, name)).mtimeMs }));
        const ctx = (who) => ({ snapshot: new Map(), staging: new Map([['shared.txt', who]]), binary: new Map(), allowedTools: new Set(['execute_code']) });
        try {
            const [a, b] = await Promise.all(['worker-A', 'worker-B'].map(who =>
                W.executeToolAsync('execute_code', { language: 'bash', code: 'cat shared.txt' }, ctx(who))));
            expect(a.stdout.trim()).toBe('worker-A');
            expect(b.stdout.trim()).toBe('worker-B');
        } finally { W.nativeExec = savedNative; state.setMainAgentRole(savedRole); }
    });
});
