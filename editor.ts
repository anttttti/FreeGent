// editor.js — FreeGent: lazy-loaded CodeMirror 6 editor for file tabs
// Loaded dynamically, not at page startup: fetched in the background once the page is idle, so the first file tab
// does not wait seconds for esm.sh (opening a file before that still loads it on demand).

import { getPrivacyLevel } from './privacy.js';

let _cmPromise: Promise<{ basicSetup: any; EditorView: any; EditorState: any; langJS: any; langPY: any; langHTML: any; langCSS: any; langMD: any; langJSON: any }> | null = null;

// Load CodeMirror 6 and language packs once, cache the promise.
function _loadCM() {
    if (_cmPromise) return _cmPromise;
    _cmPromise = (async () => {
        // ?deps= pins all lang packs to the same @codemirror/* versions as basic-setup,
        // ensuring one module instance per package (avoids duplicate-extension errors).
        const BASE = 'https://esm.sh';
        // basic-setup is versioned as 0.x, not @6; pin @lezer/highlight@1 to avoid mismatches.
        const DEPS = '?deps=@codemirror/state@6,@codemirror/view@6,@codemirror/language@6,@lezer/highlight@1';
        const [setup, js, py, htm, cssMod, md, json] = await Promise.all([
            import(/* @vite-ignore */ `${BASE}/@codemirror/basic-setup@0.20.0${DEPS}`),
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
        return {
            basicSetup: setup.basicSetup,
            EditorView:  setup.EditorView,
            EditorState: setup.EditorState,
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

// ── Public API ─────────────────────────────────────────────────────────────

// Returns the EditorView, or null if CM fails to load (falls back to plain <pre>).
// Options: onSave(content), onChange(content), readOnly (bool)
async function createEditor(container, filename, content, { onSave, onChange, readOnly = false }: { onSave?: (content: string) => void; onChange?: (content: string) => void; readOnly?: boolean } = {}) {
    let mods: Awaited<ReturnType<typeof _loadCM>>;
    try {
        mods = await _loadCM();
    } catch (err) {
        const pre = document.createElement('pre');
        pre.className = 'file-panel-pre';
        pre.textContent = content;
        container.appendChild(pre);
        console.warn('[editor] CodeMirror failed to load, using plain viewer:', err.message);
        return null;
    }

    const { EditorView, EditorState, basicSetup } = mods;
    if (!EditorView) throw new Error('EditorView not loaded — check CDN/network');
    const lang = _pickLanguage(filename, mods);

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

