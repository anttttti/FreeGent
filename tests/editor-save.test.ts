// codex report 8, cases 365/366/368 (Save while Save is pending), 406-408 (Save after Clear/Load), 413/414 (CRLF), 382/383 (reload).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { bumpWorkspaceEpoch } from '../exec-limits.ts';

const W: any = window;
let files: Record<string, string>;
let writes: [string, string][];
let readGate: Promise<void> | null;
let editor: { text: string; onSave: (c: string) => void; onChange: (c: string) => void };

beforeAll(async () => {
    W.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    await import('../settings-ui.ts');
    await import('../tabs.ts');
});
beforeEach(() => {
    document.body.innerHTML = '<div id="tab-bar"></div><div id="tab-content"><div class="tab-panel active" data-panel="chat"></div></div>';
    files = {}; writes = []; readGate = null;
    W.agentReadFile = async (n: string) => { if (readGate) await readGate; if (!(n in files)) throw new Error('not found'); return files[n]; };
    W.agentWriteFile = async (n: string, c: string) => { writes.push([n, c]); files[n] = c; };
    W.createEditor = async (_wrap: any, _n: string, content: string, o: any) => {
        editor = { text: content.replace(/\r\n?/g, '\n'), onSave: o.onSave, onChange: o.onChange };
        return { state: { doc: { toString: () => editor.text } }, destroy() {}, dispatch() {} };
    };
    W.activateTab ??= () => {};
});
afterEach(() => { W.closeAllFileTabs?.(); vi.restoreAllMocks(); });

const open = async (name: string, content: string) => {
    files[name] = content;
    W.openFileTab(name);
    await vi.waitFor(() => expect(editor?.text).toBeDefined());
    await new Promise(r => setTimeout(r, 10));
    return document.querySelector('.file-save-btn') as HTMLElement;
};
const type = (t: string) => { editor.text = t; editor.onChange(t); };

describe('Save and the project boundary (406-408)', () => {
    it('a Save still reading when the project is cleared writes nothing', async () => {
        const btn = await open('a.txt', 'old');
        type('edited');
        let open_!: () => void; readGate = new Promise(r => { open_ = r; });
        const saving = editor.onSave('edited');
        bumpWorkspaceEpoch(); W.closeAllFileTabs();
        open_(); await saving;
        expect(writes).toEqual([]);
        void btn;
    });
});

describe('typing while a Save is pending (366/368)', () => {
    it('the newer text stays marked unsaved when the earlier Save completes', async () => {
        const btn = await open('b.txt', 'v0');
        type('v1');
        let release!: () => void; readGate = new Promise(r => { release = r; });
        const saving = editor.onSave('v1');
        type('v2');                                   // typed while the Save waits
        release(); await saving;
        expect(files['b.txt']).toBe('v1');
        expect(btn.classList.contains('file-unsaved')).toBe(true);
        expect(btn.textContent).toBe('↑ Save ●');
        await new Promise(r => setTimeout(r, 1700));
        expect(btn.textContent).toBe('↑ Save ●');      // the success timer does not wipe it
    });
});

describe('CRLF files (413/414)', () => {
    it('an untouched CRLF file is clean, and a Save keeps its line breaks', async () => {
        const btn = await open('c.txt', 'one\r\ntwo\r\n');
        expect(btn.classList.contains('file-unsaved')).toBe(false);
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
        W.closeFileTab('c.txt');
        expect(confirmSpy).not.toHaveBeenCalled();     // no "unsaved changes" for an untouched file
        const btn2 = await open('c.txt', 'one\r\ntwo\r\n');
        type('one\ntwo\nthree\n');
        await editor.onSave('one\ntwo\nthree\n');
        expect(files['c.txt']).toBe('one\r\ntwo\r\nthree\r\n');
        void btn2;
    });
});

describe('reload with unsaved edits (382/383)', () => {
    it('asks before the page unloads when a buffer is dirty, not when clean', async () => {
        await open('d.txt', 'x');
        const clean = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(clean);
        expect(clean.defaultPrevented).toBe(false);
        type('changed');
        const dirty = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(dirty);
        expect(dirty.defaultPrevented).toBe(true);
    });
});

