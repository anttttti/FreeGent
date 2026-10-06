// check_page (tools.ts / tabs.ts runPageCheck): browser-only page check. The page-running part is
// exercised in a real browser (jsdom does not run sandboxed srcdoc iframes); these cover the tool's
// guards and its registration.
import { describe, it, expect, afterEach } from 'vitest';

const W = window as any;

describe('check_page', () => {
    const prev = { nativeExec: W.nativeExec, runPageCheck: W.runPageCheck };
    afterEach(() => { W.nativeExec = prev.nativeExec; W.runPageCheck = prev.runPageCheck; });

    it('refuses in headless runs (nativeExec present)', async () => {
        W.nativeExec = async () => ({});
        W.runPageCheck = async () => ({ ok: true });
        const r = await W.executeToolAsync('check_page', { path: 'index.html' });
        // Refused either by the headless role ceiling or by the handler's own guard.
        expect(r.error).toMatch(/not available|needs the browser app/);
    });

    it('requires an .html path and passes actions/probes through', async () => {
        W.nativeExec = undefined;
        let got: any = null;
        W.runPageCheck = async (path: string, opts: any) => { got = { path, opts }; return { path, summary: 'ok' }; };
        expect((await W.executeToolAsync('check_page', { path: 'game.js' })).error).toMatch(/HTML page/);
        const r = await W.executeToolAsync('check_page', { path: 'index.html', actions: [{ click: '#start-btn' }], probes: ['gameState', 42], wait_ms: 500 });
        expect(r.summary).toBe('ok');
        expect(got).toEqual({ path: 'index.html', opts: { actions: [{ click: '#start-btn' }], probes: ['gameState', '42'], waitMs: 500 } });
    });

    it('is a default-on tool known to the pseudo-call detector', async () => {
        expect(W.ALL_TOOL_NAMES).toContain('check_page');
        expect(W.OPT_IN_TOOLS.has('check_page')).toBe(false);
        const { AGENT_TOOL_NAMES } = await import('../step-validator.ts');
        expect(AGENT_TOOL_NAMES).toContain('check_page');
    });
});

describe('page references resolve from the page\'s folder', () => {
    it('resolvePageRef works like a browser URL resolver on workspace names', async () => {
        const { resolvePageRef } = await import('../tabs.ts');
        expect(resolvePageRef('app.js', 'app/index.html')).toBe('app/app.js');
        expect(resolvePageRef('./js/main.js', 'app/index.html')).toBe('app/js/main.js');
        expect(resolvePageRef('../shared/util.js', 'app/js/main.js')).toBe('app/shared/util.js');
        expect(resolvePageRef('/lib/x.js', 'app/index.html')).toBe('lib/x.js');
        expect(resolvePageRef('/workspace/lib/x.js', 'app/index.html')).toBe('lib/x.js');
        expect(resolvePageRef('style.css?v=2#top', 'index.html')).toBe('style.css');
        expect(resolvePageRef('img/a.png', '')).toBe('img/a.png');
    });

    it('a preview of app/index.html inlines app/app.js and app/style.css, not root files', async () => {
        await import('../tabs.ts');
        const files: Record<string, string> = {
            'app/app.js': 'window.WHICH = "app";', 'app.js': 'window.WHICH = "root";',
            'app/style.css': 'body{color:red}', 'style.css': 'body{color:blue}',
        };
        for (const id of ['tab-bar', 'tab-content'])
            if (!document.getElementById(id)) document.body.appendChild(Object.assign(document.createElement('div'), { id }));
        const prev = W.agentReadFile;
        W.agentReadFile = async (p: string) => { if (p in files) return files[p]; throw new Error(`File not found: ${p}`); };
        try {
            await W.openArtifactTab('app/index.html', '<html><head><link rel="stylesheet" href="style.css"></head><body><script src="app.js"></script></body></html>');
            const srcdoc = [...document.querySelectorAll('iframe')].map(f => f.srcdoc).find(s => s.includes('WHICH')) ?? '';
            expect(srcdoc).toContain('window.WHICH = "app"');
            expect(srcdoc).toContain('color:red');
            expect(srcdoc).not.toContain('"root"');
        } finally { W.agentReadFile = prev; }
    });

    it('inlines workspace images, icons and CSS url() as data: URLs', async () => {
        await import('../tabs.ts');
        for (const id of ['tab-bar', 'tab-content'])
            if (!document.getElementById(id)) document.body.appendChild(Object.assign(document.createElement('div'), { id }));
        const bin: Record<string, string> = { 'app/img/logo.png': 'data:image/png;base64,TE9HTw==', 'app/img/bg.png': 'data:image/png;base64,Qkc=' };
        const text: Record<string, string> = { 'app/css/site.css': '.hero{background:url("../img/bg.png")}', 'app/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' };
        const prev = { read: W.agentReadFile, data: W.readFileAsDataUrl };
        W.agentReadFile = async (p: string) => { if (p in text) return text[p]; throw new Error(`File not found: ${p}`); };
        W.readFileAsDataUrl = async (p: string) => { if (p in bin) return bin[p]; throw new Error('File content is not a data URI'); };
        try {
            await W.openArtifactTab('app/index.html', '<html><head><link rel="icon" href="icon.svg"><link rel="stylesheet" href="css/site.css"></head>'
                + '<body><img src="img/logo.png" alt="x"><img src="https://example.com/remote.png"><div class="hero"></div></body></html>');
            const srcdoc = [...document.querySelectorAll('iframe')].map(f => f.srcdoc).find(s => s.includes('LOGO') || s.includes('TE9HTw')) ?? '';
            expect(srcdoc).toContain('src="data:image/png;base64,TE9HTw=="');            // <img>, relative to the page
            expect(srcdoc).toContain('url("data:image/png;base64,Qkc=")');              // CSS url(), relative to the CSS file
            expect(srcdoc).toContain('href="data:image/svg+xml;charset=utf-8,');        // text SVG icon
            expect(srcdoc).toContain('src="https://example.com/remote.png"');          // remote URLs untouched
        } finally { W.agentReadFile = prev.read; W.readFileAsDataUrl = prev.data; }
    });
});

describe('scripts injected into page frames', () => {
    it('use no syntax newer than ES2017 (older Safari rejects ?? and ?. and skips the whole script)', async () => {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync(process.cwd() + '/tabs.ts', 'utf8');
        for (const name of ['_STORAGE_POLYFILL', '_CHECK_CAPTURE']) {
            const m = src.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)<\\\\/script>`'));
            expect(m, name).toBeTruthy();
            expect(m![1], name).not.toMatch(/\?\?|\?\.[a-zA-Z_$[(]/);
        }
    });
});
