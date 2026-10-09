// The acceptance reviewer is shown the project's source files, not only the ones the task names.
// Uploaded chat logs (2026-10-06..08): 21 `done` attempts in four chats were blocked with
// "js/game.js is referenced and not provided" / "no code provided" because the task had no ## Files.
const W = globalThis;
await import('../post-turn.ts');
await import('../tasks.ts');

const STUBBED = ['agentListFiles', 'agentReadFile', 'agentWriteFile', 'agentDeleteFile', 'callLLMComplete', 'refreshTasks'];
let saved, files, mtimes;

beforeEach(() => {
    saved = Object.fromEntries(STUBBED.map(k => [k, W[k]]));
    files = {}; mtimes = {};
    W.agentListFiles = async () => Object.keys(files).map(name => ({ name, lastModified: mtimes[name] ?? 0 }));
    W.agentReadFile = async (p) => { if (!(p in files)) throw new Error(`nf ${p}`); return files[p]; };
    W.agentWriteFile = async (p, c) => { files[p] = c; };
    W.agentDeleteFile = async (p) => { delete files[p]; };
    W.refreshTasks = async () => {};
    localStorage.setItem('fg_qa_enabled', 'true');
    localStorage.setItem('fg_qa_test_runner', 'false');
    localStorage.setItem('fg_qa_acceptance_review', 'true');
});
afterEach(() => { for (const k of STUBBED) W[k] = saved[k]; localStorage.clear(); });

const task = '---\nid: 002\ntitle: Game core\nstatus: in-review\n---\n# Game core\n## Acceptance Criteria\n- [ ] canvas runs\n- [ ] jump works\n';
const review = async () => {
    files['fg-tasks/002-core.md'] = task;
    W.callLLMComplete = vi.fn().mockResolvedValue('- ✓ canvas runs\n- ✓ jump works\nVERDICT: PASS');
    const r = await W.transitionTask('fg-tasks/002-core.md', 'done');
    return { r, prompt: W.callLLMComplete.mock.calls[0][0] };
};

describe('acceptance review input', () => {
    it('includes the project source files when the task names none, newest first', async () => {
        files['index.html'] = '<canvas id="game"></canvas>';
        files['js/game.js'] = 'function jump(){}';
        files['js/render.js'] = 'function draw(){}';
        files['style.css'] = 'body{margin:0}';
        files['assets/frames.json'] = '{"imageData":"' + 'A'.repeat(50_000) + '"}';
        files['memory/log.md'] = 'notes';
        files['_probe_test.html'] = 'probe';
        mtimes['js/game.js'] = 300; mtimes['js/render.js'] = 200; mtimes['index.html'] = 100;
        const { r, prompt } = await review();
        expect(r.transitioned).toBe(true);
        for (const f of ['index.html', 'js/game.js', 'js/render.js', 'style.css']) expect(prompt).toContain(`### ${f}`);
        expect(prompt.indexOf('### js/game.js')).toBeLessThan(prompt.indexOf('### js/render.js'));
        expect(prompt).toContain('function jump(){}');
        for (const f of ['assets/frames.json', 'memory/log.md', '_probe_test.html', 'fg-tasks/002-core.md']) expect(prompt).not.toContain(`### ${f}`);
        expect(prompt).not.toContain('no files available');
    });

    it('puts files the task names first', async () => {
        files['a.js'] = 'A'; files['b.js'] = 'B'; mtimes['a.js'] = 500; mtimes['b.js'] = 1;
        files['fg-tasks/002-core.md'] = task.replace('# Game core\n', '# Game core\n## Files\n- `b.js`\n');
        W.callLLMComplete = vi.fn().mockResolvedValue('- ✓ canvas runs\n- ✓ jump works\nVERDICT: PASS');
        await W.transitionTask('fg-tasks/002-core.md', 'done');
        const prompt = W.callLLMComplete.mock.calls[0][0];
        expect(prompt.indexOf('### b.js')).toBeGreaterThan(-1);
        expect(prompt.indexOf('### b.js')).toBeLessThan(prompt.indexOf('### a.js'));
    });

    it('stays within the size budget and says which source files were left out', async () => {
        for (let i = 0; i < 14; i++) { files[`src/m${i}.js`] = `// m${i}\n` + 'x'.repeat(15_000); mtimes[`src/m${i}.js`] = 1000 - i; }
        const { prompt } = await review();
        expect(prompt.length).toBeLessThan(90_000);
        expect(prompt).toContain('### src/m0.js');
        expect(prompt).not.toContain('### src/m13.js');
        expect(prompt).toMatch(/exist in the project but are not shown here: .*src\/m13\.js/);
    });

    it('cuts a very long file and says so', async () => {
        files['big.js'] = 'y'.repeat(70_000);
        const { prompt } = await review();
        expect(prompt).toMatch(/\[… cut at \d+ of 70000 characters\]/);
    });

    it('with no source files at all, still reports no files available', async () => {
        const { prompt } = await review();
        expect(prompt).toContain('(no files available)');
    });
});

describe('completeness gate message', () => {
    it('names the unchecked steps and the task file', async () => {
        files['fg-tasks/003-t.md'] = '---\nid: 003\ntitle: T\nstatus: in-progress\n---\n# T\n- [x] done one\n- [ ] tapping a block breaks it\n- [ ] hotbar selection changes\n';
        const r = await W.transitionTask('fg-tasks/003-t.md', 'in-review');
        expect(r.transitioned).toBe(false);
        expect(r.reason).toContain('2 unchecked steps in fg-tasks/003-t.md');
        expect(r.reason).toContain('"tapping a block breaks it", "hotbar selection changes"');
        expect(r.reason).toContain('"- [x]"');
        expect(r.reason).not.toContain('done one');
    });
});
