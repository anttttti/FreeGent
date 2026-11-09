import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// Browsers that cannot load the editor library got a read-only <pre>, so a file could not be edited at all (uploaded console errors:
// "CodeMirror failed to load: Unexpected token '.'"). A text box stands in, with the part of the editor interface the tabs use.
const W: any = window;

describe('plain text editor fallback', () => {
    it('edits, reports changes, saves on Ctrl+S, takes a replacement and removes itself', async () => {
        const { _plainEditor } = await import('../editor.ts');
        const box = document.createElement('div'); document.body.appendChild(box);
        const changes: string[] = [], saves: string[] = [];
        const ed: any = _plainEditor(box, 'one', { onSave: c => saves.push(c), onChange: c => changes.push(c) });
        const ta = box.querySelector('textarea') as HTMLTextAreaElement;
        expect(ta.value).toBe('one'); expect(ed.state.doc.toString()).toBe('one'); expect(ed.state.doc.length).toBe(3);
        ta.value = 'two'; ta.dispatchEvent(new Event('input'));
        expect(changes).toEqual(['two']);
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true }));
        expect(saves).toEqual(['two']);
        ed.dispatch({ changes: { from: 0, to: 3, insert: 'from disk' } });
        expect(ta.value).toBe('from disk'); expect(changes.at(-1)).toBe('from disk');
        ta.setSelectionRange(0, 0);
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
        expect(ta.value.startsWith('\tfrom disk')).toBe(true);
        ed.destroy();
        expect(box.querySelector('textarea')).toBeNull();
    });
});

describe('Edit button on a page preview', () => {
    let files: Record<string, string>;
    beforeAll(async () => {
        W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        await import('../settings-ui.ts'); await import('../tabs.ts');
    });
    beforeEach(() => {
        document.body.innerHTML = '<div id="tab-bar"></div><div id="tab-content"><div class="tab-panel active" data-panel="chat"></div></div>';
        files = { 'app/index.html': '<p>hi</p>' };
        W.agentReadFile = async (n: string) => { if (!(n in files)) throw new Error('not found'); return files[n]; };
        W.createEditor = async () => ({ state: { doc: { toString: () => '' } }, destroy() {}, dispatch() {} });
    });
    afterEach(() => { W.closeAllFileTabs?.(); vi.restoreAllMocks(); });

    it('shows for a workspace file and opens that file\'s editor tab; a page that is not a file gets none', async () => {
        await W.openArtifactTab('app/index.html', '<p>hi</p>');
        await W.openArtifactTab('chat page', '<p>x</p>');
        await new Promise(r => setTimeout(r, 20));
        const btns = [...document.querySelectorAll<HTMLButtonElement>('.artifact-edit-btn')];
        expect(btns).toHaveLength(2);
        expect(btns[0].style.display).toBe('');
        expect(btns[1].style.display).toBe('none');
        btns[0].click();
        await vi.waitFor(() => expect(document.querySelector('.file-panel .file-save-btn')).not.toBeNull());
    });
});

describe('languages loaded on demand', () => {
    it('maps the extra file types to their packs, and leaves the built-in ones alone', async () => {
        const { _lazyLanguageOf } = await import('../editor.ts');
        expect(_lazyLanguageOf('a/config.yml')).toEqual({ pkg: 'lang-yaml', fn: 'yaml' });
        expect(_lazyLanguageOf('q.SQL')).toEqual({ pkg: 'lang-sql', fn: 'sql' });
        expect(_lazyLanguageOf('main.cpp')).toEqual({ pkg: 'lang-cpp', fn: 'cpp' });
        expect(_lazyLanguageOf('main.rs')).toEqual({ pkg: 'lang-rust', fn: 'rust' });
        expect(_lazyLanguageOf('run.sh')).toEqual({ legacy: 'shell', fn: 'shell' });
        expect(_lazyLanguageOf('app.js')).toBeNull(); expect(_lazyLanguageOf('README')).toBeNull();
    });

    it('loads a pack once, wraps a legacy mode in StreamLanguage, and returns null (then retries) when the pack cannot be had', async () => {
        const { _loadLazyLanguage } = await import('../editor.ts');
        const urls: string[] = [];
        const ok = async (u: string) => { urls.push(u); return u.includes('lang-go') ? { go: () => 'GO' } : u.includes('legacy-modes') ? { shell: 'SHELL-MODE' } : { StreamLanguage: { define: (m: any) => 'STREAM:' + m } }; };
        expect(await _loadLazyLanguage({ pkg: 'lang-go', fn: 'go' }, ok)).toBe('GO');
        expect(await _loadLazyLanguage({ pkg: 'lang-go', fn: 'go' }, ok)).toBe('GO');
        expect(urls.filter(u => u.includes('lang-go'))).toHaveLength(1);
        expect(await _loadLazyLanguage({ legacy: 'shell', fn: 'shell' }, ok)).toBe('STREAM:SHELL-MODE');
        let tries = 0;
        const bad = async () => { tries++; throw new Error('offline'); };
        expect(await _loadLazyLanguage({ pkg: 'lang-yaml', fn: 'yaml' }, bad)).toBeNull();
        expect(await _loadLazyLanguage({ pkg: 'lang-yaml', fn: 'yaml' }, bad)).toBeNull();
        expect(tries).toBe(2);
    });
});
