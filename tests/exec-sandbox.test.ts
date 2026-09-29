// tests/exec-sandbox.test.ts — agent code runs outside the page's origin and the user's files:
//   - the page side of the exec sandbox (exec-sandbox-host.ts) answers only its own frame, and
//     only the allowed workspace operations
//   - the sandbox bundle (dev-api.ts buildExecSandbox) swaps Web Storage/IndexedDB for stand-ins
//     and uses the workspace channel instead of the page's workspace module
//   - bubblewrap isolation for /api/execute (dev-api.ts bwrapArgs / toolchainBinds)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bwrapArgs, toolchainBinds } from '../dev-api.ts';
import { sandboxCall, resetSandbox } from '../exec-sandbox-host.ts';

const W = globalThis as any;

describe('exec sandbox host', () => {
    let frame: HTMLIFrameElement, posted: any[];
    const fromFrame = (data: any, source: any = frame.contentWindow) =>
        window.dispatchEvent(new MessageEvent('message', { data, source }));

    beforeEach(async () => {
        const call = sandboxCall('js', { code: '1', files: {} });
        frame = document.querySelector('iframe[sandbox]') as HTMLIFrameElement;
        posted = [];
        frame.contentWindow!.postMessage = ((m: any) => { posted.push(m); }) as any;
        fromFrame({ fg: 'ready' });
        await vi.waitFor(() => expect(posted.some(m => m.fg === 'call')).toBe(true));
        fromFrame({ fg: 'reply', id: posted.find(m => m.fg === 'call').id, value: { stdout: '1' } });
        await call;
        posted = [];
    });
    afterEach(() => resetSandbox());

    it('is an opaque-origin frame loading the sandbox bundle', () => {
        expect(frame.getAttribute('sandbox')).toBe('allow-scripts');   // no allow-same-origin
        expect(frame.srcdoc).toContain('fg-exec-sandbox.js');
    });

    it('answers allowed workspace operations from its frame', async () => {
        W.agentListFiles = vi.fn(async () => [{ name: 'a.txt' }]);
        fromFrame({ fg: 'ws', id: 7, op: 'agentListFiles', args: [] });
        await vi.waitFor(() => expect(posted).toContainEqual({ fg: 'ws-reply', id: 7, value: [{ name: 'a.txt' }] }));
    });

    it('refuses any other operation', async () => {
        W.agentListFiles = vi.fn();
        for (const op of ['eval', 'loadServerKeys', 'executeToolAsync', 'localStorage'])
            fromFrame({ fg: 'ws', id: 8, op, args: [] });
        await vi.waitFor(() => expect(posted.filter(m => m.error?.startsWith('workspace op not allowed'))).toHaveLength(4));
    });

    describe('network fallback', () => {
        const realFetch = globalThis.fetch;
        afterEach(() => { globalThis.fetch = realFetch; delete W.getEffectiveProxy; });

        it('fetches a plain GET through the proxy, never the URL itself', async () => {
            W.getEffectiveProxy = () => 'https://proxy.test';
            const f = vi.fn(async () => new Response('page', { headers: { 'Content-Type': 'text/html' } }));
            globalThis.fetch = f as any;
            fromFrame({ fg: 'net', id: 11, url: 'https://example.com/a?b=1' });
            await vi.waitFor(() => expect(posted.some(m => m.fg === 'net-reply')).toBe(true));
            expect(f).toHaveBeenCalledTimes(1);
            expect((f.mock.calls[0] as any)[0]).toBe('https://proxy.test?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1');
            const r = posted.find(m => m.fg === 'net-reply');
            expect(r.value.status).toBe(200);
            expect(r.value.contentType).toBe('text/html');
            expect(new TextDecoder().decode(r.value.body)).toBe('page');
        });

        it('refuses non-http URLs and reports proxy refusals', async () => {
            W.getEffectiveProxy = () => 'https://proxy.test';
            globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'private address' }),
                { status: 403, headers: { 'X-FG-Proxy-Error': '1' } })) as any;
            fromFrame({ fg: 'net', id: 12, url: 'file:///etc/passwd' });
            fromFrame({ fg: 'net', id: 13, url: 'https://10.0.0.1/' });
            await vi.waitFor(() => expect(posted.filter(m => m.fg === 'net-reply')).toHaveLength(2));
            expect(posted.find(m => m.id === 12).error).toMatch(/only http/);
            expect(posted.find(m => m.id === 13).error).toMatch(/proxy refused this URL — private address/);
        });

        it('fails without a proxy instead of fetching directly', async () => {
            W.getEffectiveProxy = () => '';
            const f = vi.fn(); globalThis.fetch = f as any;
            fromFrame({ fg: 'net', id: 14, url: 'https://example.com/' });
            await vi.waitFor(() => expect(posted.some(m => m.id === 14)).toBe(true));
            expect(posted.find(m => m.id === 14).error).toMatch(/no fetch proxy/);
            expect(f).not.toHaveBeenCalled();
        });

        it('ignores network requests from other windows', async () => {
            const f = vi.fn(); globalThis.fetch = f as any;
            W.getEffectiveProxy = () => 'https://proxy.test';
            fromFrame({ fg: 'net', id: 15, url: 'https://example.com/' }, window);
            await new Promise(r => setTimeout(r, 20));
            expect(f).not.toHaveBeenCalled();
        });
    });

    it('ignores messages from other windows', async () => {
        W.agentListFiles = vi.fn(async () => []);
        fromFrame({ fg: 'ws', id: 9, op: 'agentListFiles', args: [] }, window);
        await new Promise(r => setTimeout(r, 20));
        expect(W.agentListFiles).not.toHaveBeenCalled();
        expect(posted).toHaveLength(0);
    });
});

describe('exec sandbox bundle', () => {
    let code = '';
    // Built in a separate Node process: esbuild refuses to start under jsdom (its TextEncoder
    // returns a Uint8Array from another realm).
    beforeAll(() => {
        const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--loader', './js-to-ts-loader.mjs',
            'scripts/build-exec-sandbox.mjs'], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
        if (r.status !== 0) throw new Error(`bundle build failed: ${r.stderr}`);
        code = r.stdout;
    }, 60_000);

    it('has no direct Web Storage or IndexedDB references', () => {
        expect(code).not.toMatch(/[^.\w$]localStorage\b/);
        expect(code).not.toMatch(/[^.\w$]sessionStorage\b/);
        expect(code).not.toMatch(/[^.\w$]indexedDB\.open/);
    });

    it('reaches the workspace through the channel, not the page module', () => {
        expect(code).toMatch(/workspaceCall\(["']agentWriteFile["']/);
        expect(code).not.toContain('_buildPyRunnerHtml');   // workspace.ts was not bundled
    });

    it('inlines the Pyodide worker, which uses in-memory files', () => {
        expect(code).toContain('pyodide.js');
        expect(code).not.toContain('IDBFS');
    });
});

describe('bubblewrap isolation', () => {
    it('exposes toolchain prefixes under $HOME but not private directories', () => {
        const home = mkdtempSync(join(process.cwd(), 'tmp-home-'));
        try {
            for (const d of ['anaconda3/bin', '.local/bin', '.config/tool/bin', 'bin']) mkdirSync(join(home, d), { recursive: true });
            const binds = toolchainBinds([`${home}/anaconda3/bin`, `${home}/.local/bin`, `${home}/.config/tool/bin`, `${home}/bin`, '/usr/bin'].join(':'), home);
            expect(binds).toContain(join(home, 'anaconda3'));
            expect(binds).toContain(join(home, '.local', 'bin'));
            expect(binds).not.toContain(join(home, '.local'));
            expect(binds).toContain(join(home, 'bin'));
            expect(binds).not.toContain(home);
            expect(binds.some(b => b.includes('.config'))).toBe(false);
        } finally { rmSync(home, { recursive: true, force: true }); }
    });

    const hasBwrap = process.platform === 'linux' && spawnSync('bwrap', ['--ro-bind', '/', '/', 'true']).status === 0;
    it.runIf(hasBwrap)('hides files outside the system directories and the work directory', () => {
        const secretDir = mkdtempSync(join(process.cwd(), 'tmp-secret-'));
        const work = mkdtempSync('/tmp/fg-work-');
        try {
            writeFileSync(join(secretDir, 'credentials'), 'SECRET');
            const r = spawnSync('bwrap', [...bwrapArgs(work, '/usr/bin:/bin', '/nonexistent-home'), '--',
                'bash', '-c', `cat ${join(secretDir, 'credentials')}; echo ok > out.txt; cat out.txt`], { encoding: 'utf-8' });
            expect(r.stdout).not.toContain('SECRET');
            expect(r.stderr).toMatch(/No such file/);
            expect(r.stdout.trim()).toBe('ok');   // the work directory is writable
        } finally { rmSync(secretDir, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
    });
});

describe('approval default with isolation', () => {
    afterEach(() => { delete W.__FG_SERVER_INFO; localStorage.clear(); });

    it('does not ask for every command when the dev server isolates them', () => {
        localStorage.setItem('fg_sandbox_provider', 'local');
        W.__FG_SERVER_INFO = { execIsolated: true };
        expect(W.getToolApproval()).toBe('off');
        W.__FG_SERVER_INFO = { execIsolated: false };
        expect(W.getToolApproval()).toBe('high');
    });
});
