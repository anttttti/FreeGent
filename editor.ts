// editor.js — FreeGent: lazy-loaded CodeMirror 6 editor for file tabs
// Loaded dynamically, not at page startup: fetched in the background once the page is idle, so the first file tab
// does not wait seconds for esm.sh (opening a file before that still loads it on demand).

import { getPrivacyLevel } from './privacy.js';

let _cmPromise: Promise<{ basicSetup: any; EditorView: any; EditorState: any; langJS: any; langPY: any; langHTML: any; langCSS: any; langMD: any; langJSON: any }> | null = null;

// Load CodeMirror 6 and language packs once, cache the promise.
function _loadCM() {
    if (_cmPromise) return _cmPromise;
    _cmPromise = (async () => {
        // ?deps= pins all lang packs to the same @codemirror/* versions as the setup package,
        // ensuring one module instance per package (avoids duplicate-extension errors).
        const BASE = 'https://esm.sh';
        const DEPS = '?deps=@codemirror/state@6,@codemirror/view@6,@codemirror/language@6,@lezer/highlight@1';
        // `codemirror` is what @codemirror/basic-setup was renamed to at 6.0. basic-setup@0.20.0 also pulled autocomplete, commands,
        // lint and search at ^0.20 (pre-6 builds beside state/view 6), and esm.sh printed a deprecation warning for it in every
        // session that opened a file (console uploads: 67 sessions, v0.71-v1.0.79).
        const [setup, js, py, htm, cssMod, md, json] = await Promise.all([
            import(/* @vite-ignore */ `${BASE}/codemirror@6${DEPS}`),
            import(/* @vite-ignore */ `${BASE}/@codemirror/lang-javascript@6${DEPS}`),
            import(/* @vite-ignore */ `${BASE}/@codemirror/lang-python@6${DEPS}`),
            import(/* @vite-ignore */ `${BASE}/@codemirror/lang-html@6${DEPS}`),
            import(/* @vite-ignore */ `${BASE}/@codemirror/lang-css@6${DEPS}`),
            import(/* @vite-ignore */ `${BASE}/@codemirror/lang-markdown@6${DEPS}`),
            import(/* @vite-ignore */ `${BASE}/@codemirror/lang-json@6${DEPS}`),
        ]);
        // EditorView and EditorState must come from the same module instances as basicSetup's keymaps: esm.sh builds a
        // package again for each ?deps= combination, so `@codemirror/view@6` imported on its own is a second copy, and a
        // keymap made by the first copy is silently ignored by a view of the second (undo, indent, search: none worked).
        // `codemirror` exports EditorView but not EditorState, so the class is taken from a view's own state.
        const _probe = new setup.EditorView();
        const EditorState = _probe.state.constructor;
        _probe.destroy();
        return {
            basicSetup: setup.basicSetup,
            EditorView:  setup.EditorView,
            EditorState,
            langJS:   js.javascript,
            langPY:   py.python,
            langHTML: htm.html,
            langCSS:  cssMod.css,
            langMD:   md.markdown,
            langJSON: json.json,
        };
    })().catch(err => { _cmPromise = null; throw err; }); // reset on failure so next open retries
    return _cmPromise;
}

function _pickLanguage(filename, mods) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    if (['js','mjs','cjs'].includes(ext))       return mods.langJS();
    if (['ts','tsx'].includes(ext))              return mods.langJS({ typescript: true });
    if (['jsx'].includes(ext))                   return mods.langJS({ jsx: true });
    if (ext === 'py')                            return mods.langPY();
    if (['html','htm'].includes(ext))            return mods.langHTML();
    if (ext === 'css')                           return mods.langCSS();
    if (ext === 'md')                            return mods.langMD();
    if (ext === 'json')                          return mods.langJSON();
    return null;
}

// Languages with no pack in the first download: each one is fetched when a file of that type is opened (the setup would otherwise grow by eight
// downloads, each a way for the editor to fail to load). A pack that fails to load leaves the file editable without colours.
const _ESM = 'https://esm.sh';
const _LANG_DEPS = '?deps=@codemirror/state@6,@codemirror/view@6,@codemirror/language@6,@lezer/highlight@1';
type LazyLang = { pkg: string; fn: string } | { legacy: string; fn: string };
const _LAZY_BY_EXT: Record<string, LazyLang> = {
    yaml: { pkg: 'lang-yaml', fn: 'yaml' }, yml: { pkg: 'lang-yaml', fn: 'yaml' },
    sql: { pkg: 'lang-sql', fn: 'sql' },
    xml: { pkg: 'lang-xml', fn: 'xml' }, svg: { pkg: 'lang-xml', fn: 'xml' }, xsl: { pkg: 'lang-xml', fn: 'xml' }, xsd: { pkg: 'lang-xml', fn: 'xml' },
    c: { pkg: 'lang-cpp', fn: 'cpp' }, h: { pkg: 'lang-cpp', fn: 'cpp' }, cc: { pkg: 'lang-cpp', fn: 'cpp' }, cpp: { pkg: 'lang-cpp', fn: 'cpp' },
    cxx: { pkg: 'lang-cpp', fn: 'cpp' }, hpp: { pkg: 'lang-cpp', fn: 'cpp' }, hh: { pkg: 'lang-cpp', fn: 'cpp' },
    java: { pkg: 'lang-java', fn: 'java' },
    go: { pkg: 'lang-go', fn: 'go' },
    rs: { pkg: 'lang-rust', fn: 'rust' },
    sh: { legacy: 'shell', fn: 'shell' }, bash: { legacy: 'shell', fn: 'shell' }, zsh: { legacy: 'shell', fn: 'shell' },
};
export const _lazyLanguageOf = (filename: string): LazyLang | null => _LAZY_BY_EXT[(filename.split('.').pop() || '').toLowerCase()] ?? null;

const _lazyCache = new Map<string, Promise<any>>();
/** The language extension for a lazily loaded type, or null when its pack cannot be had. `importer` is the module loader (replaced in tests). */
export async function _loadLazyLanguage(spec: LazyLang, importer: (url: string) => Promise<any> = u => import(/* @vite-ignore */ u)): Promise<any> {
    const key = 'pkg' in spec ? spec.pkg : spec.legacy;
    let p = _lazyCache.get(key);
    if (!p) {
        p = (async () => {
            if ('pkg' in spec) return (await importer(`${_ESM}/@codemirror/${spec.pkg}@6${_LANG_DEPS}`))[spec.fn]();
            // Legacy (stream) modes are wrapped by the language package that the editor itself uses.
            const [lang, mode] = await Promise.all([importer(`${_ESM}/@codemirror/language@6${_LANG_DEPS}`), importer(`${_ESM}/@codemirror/legacy-modes@6/mode/${spec.legacy}${_LANG_DEPS}`)]);
            return lang.StreamLanguage.define(mode[spec.fn]);
        })();
        _lazyCache.set(key, p);
        p.catch(() => _lazyCache.delete(key));   // a failure is tried again next time
    }
    try { return await p; } catch { return null; }
}

// ── Public API ─────────────────────────────────────────────────────────────

// Where the editor library cannot load (an old browser, a blocked CDN) the file is still editable: a text box with the little of the EditorView
// interface the tabs use (state.doc, dispatch of a whole-text replacement, destroy), so saving, the dirty mark and external-change handling work as before.
export function _plainEditor(container, content, { onSave, onChange }: { onSave?: (c: string) => void; onChange?: (c: string) => void }) {
    const ta = document.createElement('textarea');
    ta.className = 'file-panel-textarea';
    ta.value = content;
    ta.spellcheck = false;
    ta.setAttribute('autocapitalize', 'off'); ta.setAttribute('autocomplete', 'off'); ta.setAttribute('autocorrect', 'off'); ta.setAttribute('wrap', 'off');
    ta.addEventListener('input', () => onChange?.(ta.value));
    ta.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); onSave?.(ta.value); }
        else if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {   // a tab character, as in the editor, not a jump to the next control
            e.preventDefault();
            const a = ta.selectionStart, b = ta.selectionEnd;
            ta.setRangeText('\t', a, b, 'end'); onChange?.(ta.value);
        }
    });
    container.appendChild(ta);
    return {
        plain: true,
        state: { doc: { toString: () => ta.value, get length() { return ta.value.length; } } },
        dispatch(tr: { changes: { insert: string } }) { ta.value = tr.changes.insert; onChange?.(ta.value); },
        destroy() { ta.remove(); },
    };
}

// Returns the EditorView, or null if CM fails to load (falls back to plain <pre>).
// Options: onSave(content), onChange(content), readOnly (bool)
async function createEditor(container, filename, content, { onSave, onChange, readOnly = false }: { onSave?: (content: string) => void; onChange?: (content: string) => void; readOnly?: boolean } = {}) {
    let mods: Awaited<ReturnType<typeof _loadCM>>;
    try {
        mods = await _loadCM();
    } catch (err) {
        console.warn('[editor] CodeMirror failed to load, using a plain text box:', err.message);
        if (!readOnly) return _plainEditor(container, content, { onSave, onChange });
        const pre = document.createElement('pre');
        pre.className = 'file-panel-pre';
        pre.textContent = content;
        container.appendChild(pre);
        return null;
    }

    const { EditorView, EditorState, basicSetup } = mods;
    if (!EditorView) throw new Error('EditorView not loaded — check CDN/network');
    let lang = _pickLanguage(filename, mods);
    if (!lang) { const spec = _lazyLanguageOf(filename); if (spec) lang = await _loadLazyLanguage(spec); }

    const extensions = [
        basicSetup,
        EditorView.lineWrapping,
        ...(lang ? [lang] : []),
        ...(readOnly ? [EditorState.readOnly.of(true)] : []),
    ];

    if (onSave) {
        extensions.push(EditorView.domEventHandlers({
            keydown(event, view) {
                if ((event.ctrlKey || event.metaKey) && event.key === 's') {
                    event.preventDefault();
                    onSave(view.state.doc.toString());
                    return true;
                }
            }
        }));
    }

    if (onChange) {
        extensions.push(EditorView.updateListener.of(update => {
            if (update.docChanged) onChange(update.view.state.doc.toString());
        }));
    }

    const view = new EditorView({
        state: EditorState.create({ doc: content, extensions }),
        parent: container,
    });

    return view;
}

function setEditorContent(view, content) {
    if (!view) return;
    view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content }
    });
}

// Warm the cache after the page has settled. Skipped on Data Saver and where the privacy level keeps third-party
// requests off (below Routed); the editor then loads on first use as before.
function _warmEditor(): void {
    try {
        if ((navigator as any).connection?.saveData) return;
        if (getPrivacyLevel() !== 'routed') return;
    } catch { /* storage blocked: warm anyway */ }
    _loadCM().catch(() => {});   // a failure resets the cache; the first real open retries
}
function _scheduleWarmEditor(): void {
    const idle = (window as any).requestIdleCallback as ((cb: () => void, o?: { timeout: number }) => void) | undefined;
    setTimeout(() => idle ? idle(_warmEditor, { timeout: 5000 }) : _warmEditor(), 1500);   // Safari has no requestIdleCallback
}
if (document.readyState === 'complete') _scheduleWarmEditor();
else window.addEventListener('load', _scheduleWarmEditor, { once: true });

Object.assign(window, { createEditor, setEditorContent });

