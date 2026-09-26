// tests/key-exposure.test.ts — browser-side key handling:
//   - dev-server keys reach the page only as placeholders (config.ts loadServerKeys)
//   - copies of server keys that older versions saved into localStorage are removed
//   - fetch_url can't reach the page's own server (it would carry the dev-server token)
//   - commands that run on the host ask for approval, from workers too
import { createHash } from 'node:crypto';

const W = globalThis as any;
const hash16 = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 16);

afterEach(() => {
    delete W.__FG_SERVER_KEYS;
    localStorage.clear();
});

describe('server keys in the page', () => {
    it('are placeholders, and matching localStorage copies are removed', async () => {
        const real = 'gsk_realvalue_0123456789';
        localStorage.setItem('fg_groq_key', real);                 // copied there by an old Settings save
        localStorage.setItem('fg_mistral_key', 'user-typed-key');  // user's own key: kept
        W.__FG_SERVER_KEYS = { fg_groq_key: hash16(real), fg_mistral_key: hash16('a-different-server-key') };
        await W.loadServerKeys();
        expect(localStorage.getItem('fg_groq_key')).toBeNull();
        expect(W.ls('fg_groq_key')).toBe('__fgsk__fg_groq_key__');
        expect(W.isServerKeyPlaceholder(W.ls('fg_groq_key'))).toBe(true);
        expect(W.ls('fg_mistral_key')).toBe('user-typed-key');     // a typed key still wins
    });
});

describe('fetch_url and the page\'s own server', () => {
    let fetchSpy: any;
    beforeEach(() => {
        fetchSpy = vi.fn(async () => new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
        vi.stubGlobal('fetch', fetchSpy);
    });

    it('refuses the page origin and its loopback aliases when a dev server serves the page', async () => {
        W.__FG_SERVER_KEYS = {};
        const port = location.port || '80';
        for (const url of [`${location.origin}/api/keys`, `http://127.0.0.1:${port}/api/execute`, `http://[::1]:${port}/`]) {
            const r = await W.executeToolAsync('fetch_url', { url });
            expect(r.error, url).toMatch(/FreeGent server itself/);
        }
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('still reaches other local services (local LLMs, mock APIs)', async () => {
        W.__FG_SERVER_KEYS = {};
        const r = await W.executeToolAsync('fetch_url', { url: 'http://localhost:42389/search?q=x' });
        expect(r.error ?? '').not.toMatch(/FreeGent server itself/);
    });
});

describe('git metadata', () => {
    it('agent writes and deletes can\'t touch .git', async () => {
        for (const p of ['local/.git/hooks/pre-commit', '.git/config', 'sub/.GIT/config', 'local\\.git\\hooks\\x'])
            await expect(W.agentWriteFile(p, 'x'), p).rejects.toThrow(/\.git directory/);
        await expect(W.agentDeleteFile('local/.git/index')).rejects.toThrow(/\.git directory/);
        // .gitignore is an ordinary file: the guard lets it through (storage itself isn't set up here).
        const err = await W.agentWriteFile('notes/.gitignore', 'x').then(() => null, (e: Error) => e);
        expect(String(err?.message ?? '')).not.toMatch(/\.git directory/);
    });
});

describe('approval for host commands', () => {
    beforeEach(() => {
        document.body.insertAdjacentHTML('beforeend', `<div id="tool-approval-toast" style="display:none">
            <div id="tool-approval-label"></div><input type="checkbox" id="tool-approval-session">
            <span id="tool-approval-session-name"></span></div>`);
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ stdout: '', stderr: '', exit_code: 0 }))));
    });
    afterEach(() => document.getElementById('tool-approval-toast')?.remove());

    it('defaults to asking when the sandbox runs on the host', () => {
        localStorage.setItem('fg_sandbox_provider', 'local');
        expect(W.getToolApproval()).toBe('high');
        localStorage.setItem('fg_sandbox_provider', 'wasm');
        expect(W.getToolApproval()).toBe('off');
        localStorage.setItem('fg_tool_approval', 'off');                // an explicit choice wins
        localStorage.setItem('fg_sandbox_provider', 'local');
        expect(W.getToolApproval()).toBe('off');
    });

    it('asks before a worker runs a host command, and shows the command', async () => {
        localStorage.setItem('fg_sandbox_provider', 'local');
        const p = W.executeToolAsync('execute_code', { language: 'bash', code: 'cat ~/.config/freegent/credentials' }, { staging: new Map() });
        await vi.waitFor(() => expect(document.getElementById('tool-approval-toast')!.style.display).toBe(''));
        expect(document.getElementById('tool-approval-label')!.textContent).toContain('cat ~/.config/freegent/credentials');
        W.resolveToolApproval(false);
        expect((await p).error).toBe('User denied tool execution.');
    });
});
